// HTTP routes for Get started, organisation approval and Connect tenant (docs/hosted-service.md).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, type Principal, type Verifier } from './auth.ts';
import { arm as defaultArm, ArmError, onboardingArm as defaultOnboardingArm, type Arm, type OnboardingArm } from './arm.ts';
import { graph as defaultGraph, type Graph } from './graph.ts';
import { applyOnboarding, checkOnboarding, type OnboardingContext, type OnboardingRequest } from './onboarding.ts';
import { codeChallenge, consentAdminRoles, EntraError, randomToken, RelinkNeededError, type Entra } from './entra.ts';
import type { Sealer } from './sealer.ts';
import { permissionsFor, type AvdPermission } from './roles.ts';
import type { AccountLink, ConnectState, OrganisationRecord, OrganisationStatus, Store, TenantConnection } from './store.ts';

export interface AppOptions {
  verify: Verifier;
  store: Store;
  akcAdminUserIds: Set<string>;
  /** Absent when the multi-tenant Entra app isn't configured yet; Connect tenant then reports that. */
  entra?: Entra;
  /** Seals operators' refresh tokens; required for Link account. */
  sealer?: Sealer;
  arm?: Arm;
  onboardingArm?: OnboardingArm;
  graph?: Graph;
  now?: () => Date;
}

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const connectStateMinutes = 15;

const orgIdPattern = /^org_[A-Za-z0-9]{10,64}$/;
const statuses: OrganisationStatus[] = ['pending', 'approved', 'declined', 'suspended'];
const maxBodyBytes = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported-media-type', 'Send JSON.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) throw new HttpError(413, 'too-large', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid-json', 'The request body is not a JSON object.');
  }
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if ((required && !result) || result.length > max || /[\u0000-\u001f<>]/.test(result)) {
    throw new HttpError(400, 'invalid-field', `${field} must be ${required ? '1' : '0'}-${max} characters without < or >.`);
  }
  return result;
}

function organisationView(record: OrganisationRecord) {
  return { id: record.orgId, name: record.name, status: record.status, requestedAt: record.requestedAt, decidedAt: record.decidedAt ?? null };
}

function linkView(record: AccountLink | null) {
  return record ? { username: record.username, linkedAt: record.linkedAt, mfa: record.mfa } : null;
}

function tenantView(record: TenantConnection | null) {
  return record ? { tenantId: record.tenantId, name: record.tenantName, connectedAt: record.connectedAt, consentedBy: record.consentedByUsername } : null;
}

// Microsoft's admin consent errors, in plain words.
function consentErrorMessage(error: string, description: string): string {
  if (error === 'access_denied' && /AADSTS65004/.test(description)) return 'Consent was declined, so the tenant was not connected.';
  if (error === 'access_denied') return 'Your account could not grant consent. Ask a Global Administrator or Cloud Application Administrator to connect the tenant.';
  return `Microsoft reported: ${(description || error).split(/\r?\n/)[0].slice(0, 300)}`;
}

export function createApp(options: AppOptions) {
  const now = options.now ?? (() => new Date());
  const isAkcAdmin = (principal: Principal) => options.akcAdminUserIds.has(principal.userId);

  function requireAkcAdmin(principal: Principal) {
    if (!isAkcAdmin(principal)) throw new HttpError(403, 'forbidden', 'Only AKC staff can do this.');
  }

  // The caller's active organisation, if it is approved and they hold the permission.
  async function requirePermission(principal: Principal, permission: AvdPermission) {
    if (!principal.orgId) throw new HttpError(400, 'no-organisation', 'Choose an organisation first.');
    const record = await options.store.getOrganisation(principal.orgId);
    if (record?.status !== 'approved') throw new HttpError(403, 'not-approved', 'This organisation is not approved for AVD Deploy yet.');
    const roles = (await options.store.getMemberRoles(principal.orgId, principal.userId))?.roles ?? [];
    if (!permissionsFor(roles).includes(permission)) throw new HttpError(403, 'forbidden', `You need the AVD ${permission === 'admin' ? 'Admin' : permission} role for this.`);
    return { orgId: principal.orgId, record };
  }

  function requireEntra(): Entra {
    if (!options.entra) throw new HttpError(503, 'not-configured', 'Connecting a tenant is not available yet.');
    return options.entra;
  }

  async function takeState(principal: Principal, value: unknown, stage: ConnectState['stage']): Promise<ConnectState> {
    const state = typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value) ? await options.store.takeConnectState(value) : null;
    // Bound to the person and organisation that started it, single-use and short-lived.
    if (!state || state.stage !== stage || state.userId !== principal.userId || state.orgId !== principal.orgId || Date.parse(state.expiresAt) < now().getTime()) {
      throw new HttpError(400, 'invalid-state', 'This connection attempt has expired or was started elsewhere. Start Connect tenant again.');
    }
    return state;
  }

  async function connectStart(principal: Principal) {
    const entra = requireEntra();
    const { orgId } = await requirePermission(principal, 'admin');
    const state = randomToken();
    await options.store.putConnectState({ state, orgId, userId: principal.userId, stage: 'consent', expiresAt: expiry() });
    return { url: entra.adminConsentUrl(state) };
  }

  async function connectConsented(principal: Principal, body: Record<string, unknown>) {
    const entra = requireEntra();
    const { orgId } = await requirePermission(principal, 'admin');
    await takeState(principal, body.state, 'consent');
    if (typeof body.error === 'string' && body.error) {
      throw new HttpError(400, 'consent-failed', consentErrorMessage(body.error, String(body.errorDescription ?? '')));
    }
    const tenantId = typeof body.tenant === 'string' ? body.tenant.toLowerCase() : '';
    if (!guidPattern.test(tenantId)) throw new HttpError(400, 'invalid-tenant', 'Microsoft did not return a tenant ID.');
    // Microsoft's consent redirect isn't signed, so a signed sign-in to the same tenant proves it next.
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    await options.store.putConnectState({ state, orgId, userId: principal.userId, stage: 'verify', tenantId, nonce, codeVerifier, expiresAt: expiry() });
    return { url: entra.verifySignInUrl(tenantId, state, nonce, codeChallenge(codeVerifier)) };
  }

  async function connectVerify(principal: Principal, body: Record<string, unknown>) {
    const entra = requireEntra();
    const { orgId } = await requirePermission(principal, 'admin');
    const state = await takeState(principal, body.state, 'verify');
    if (typeof body.error === 'string' && body.error) throw new HttpError(400, 'sign-in-failed', consentErrorMessage(body.error, String(body.errorDescription ?? '')));
    if (typeof body.code !== 'string' || !body.code || body.code.length > 4096) throw new HttpError(400, 'invalid-code', 'Microsoft did not return a sign-in code.');
    const tenantId = state.tenantId!;
    let signIn;
    try {
      signIn = await entra.redeemSignIn(tenantId, body.code, state.codeVerifier!, state.nonce!);
    } catch (e) {
      throw new HttpError(400, 'sign-in-failed', e instanceof EntraError ? e.message : 'The sign-in could not be verified.');
    }
    if (signIn.tenantId.toLowerCase() !== tenantId) throw new HttpError(400, 'tenant-mismatch', 'You signed in to a different tenant from the one that gave consent.');
    const adminRole = signIn.roles.map((role) => consentAdminRoles[role]).find(Boolean);
    if (!adminRole) {
      throw new HttpError(403, 'not-tenant-admin', `${signIn.username || 'This account'} is not a Global, Privileged Role, Cloud Application or Application Administrator of the tenant.`);
    }
    if (!(await entra.appIsConsented(tenantId))) throw new HttpError(400, 'not-consented', 'The AKC AVD Deploy app is not approved in this tenant yet. Start Connect tenant again.');
    const record: TenantConnection = {
      orgId,
      tenantId,
      tenantName: signIn.tenantName,
      connectedBy: principal.userId,
      consentedByObjectId: signIn.objectId,
      consentedByUsername: signIn.username,
      connectedAt: now().toISOString(),
    };
    await options.store.connectTenant(record);
    return { tenant: tenantView(record), consentedAs: adminRole };
  }

  const expiry = () => new Date(now().getTime() + connectStateMinutes * 60_000).toISOString();

  // Short-lived Azure tokens per linked operator, so the sealed refresh token isn't opened on every request.
  const armTokens = new Map<string, { token: string; expiresAt: number }>();
  const arm = options.arm ?? defaultArm;

  function requireSealer(): Sealer {
    if (!options.sealer) throw new HttpError(503, 'not-configured', 'Linking accounts is not available yet.');
    return options.sealer;
  }

  async function requireTenant(orgId: string) {
    const tenant = await options.store.getTenantConnection(orgId);
    if (!tenant) throw new HttpError(409, 'no-tenant', 'Connect your Microsoft tenant first.');
    return tenant;
  }

  async function linkStart(principal: Principal) {
    const entra = requireEntra();
    requireSealer();
    const { orgId } = await requirePermission(principal, 'read');
    const tenant = await requireTenant(orgId);
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    await options.store.putConnectState({ state, orgId, userId: principal.userId, stage: 'link', tenantId: tenant.tenantId, nonce, codeVerifier, expiresAt: expiry() });
    return { url: entra.linkSignInUrl(tenant.tenantId, state, nonce, codeChallenge(codeVerifier)) };
  }

  async function linkComplete(principal: Principal, body: Record<string, unknown>) {
    const entra = requireEntra();
    const sealer = requireSealer();
    const { orgId } = await requirePermission(principal, 'read');
    const state = await takeState(principal, body.state, 'link');
    if (typeof body.error === 'string' && body.error) throw new HttpError(400, 'sign-in-failed', consentErrorMessage(body.error, String(body.errorDescription ?? '')));
    if (typeof body.code !== 'string' || !body.code || body.code.length > 4096) throw new HttpError(400, 'invalid-code', 'Microsoft did not return a sign-in code.');
    const tenant = await requireTenant(orgId);
    if (tenant.tenantId !== state.tenantId) throw new HttpError(409, 'tenant-changed', 'The connected tenant changed while you were signing in. Try again.');
    let signIn;
    try {
      signIn = await entra.redeemLink(tenant.tenantId, body.code, state.codeVerifier!, state.nonce!);
    } catch (e) {
      throw new HttpError(400, 'sign-in-failed', e instanceof EntraError ? e.message : 'The sign-in could not be verified.');
    }
    if (signIn.tenantId.toLowerCase() !== tenant.tenantId) {
      throw new HttpError(400, 'tenant-mismatch', `Sign in with your work account in ${tenant.tenantName || 'the connected tenant'}.`);
    }
    const record: AccountLink = {
      orgId,
      userId: principal.userId,
      tenantId: tenant.tenantId,
      objectId: signIn.objectId,
      username: signIn.username,
      mfa: signIn.mfa,
      sealedRefreshToken: await sealer.seal(signIn.refreshToken),
      linkedAt: now().toISOString(),
    };
    await options.store.putAccountLink(record);
    armTokens.set(`${orgId}/${principal.userId}`, { token: signIn.accessToken, expiresAt: signIn.expiresAt });
    return { link: linkView(record) };
  }

  async function unlink(principal: Principal) {
    if (!principal.orgId) throw new HttpError(400, 'no-organisation', 'Choose an organisation first.');
    await options.store.deleteAccountLink(principal.orgId, principal.userId);
    armTokens.delete(`${principal.orgId}/${principal.userId}`);
    return { link: null };
  }

  /** An Azure token for the caller's own linked account in the organisation's connected tenant. */
  async function operatorArmToken(principal: Principal): Promise<{ token: string; link: AccountLink }> {
    const entra = requireEntra();
    const sealer = requireSealer();
    const { orgId } = await requirePermission(principal, 'read');
    const tenant = await requireTenant(orgId);
    const link = await options.store.getAccountLink(orgId, principal.userId);
    if (!link) throw new HttpError(409, 'not-linked', 'Link your Microsoft work account first.');
    const key = `${orgId}/${principal.userId}`;
    if (link.tenantId !== tenant.tenantId) {
      await options.store.deleteAccountLink(orgId, principal.userId);
      armTokens.delete(key);
      throw new HttpError(409, 'relink-needed', 'Your organisation connected a different tenant. Link your account again.');
    }
    const cached = armTokens.get(key);
    if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return { token: cached.token, link };
    try {
      const fresh = await entra.armToken(link.tenantId, await sealer.open(link.sealedRefreshToken));
      if (fresh.refreshToken) await options.store.putAccountLink({ ...link, sealedRefreshToken: await sealer.seal(fresh.refreshToken) });
      armTokens.set(key, { token: fresh.accessToken, expiresAt: fresh.expiresAt });
      return { token: fresh.accessToken, link };
    } catch (e) {
      if (e instanceof RelinkNeededError) {
        // Never retried with another identity (ADR 0005): the operator signs in again.
        await options.store.deleteAccountLink(orgId, principal.userId);
        armTokens.delete(key);
        throw new HttpError(409, 'relink-needed', 'Microsoft needs you to sign in again. Link your account again.');
      }
      throw e;
    }
  }

  function armFailure(e: unknown): never {
    if (e instanceof ArmError) throw new HttpError(e.status === 403 ? 403 : 502, e.status === 403 ? 'azure-forbidden' : 'azure-error', e.message);
    throw e;
  }

  async function mySubscriptions(principal: Principal) {
    const { token, link } = await operatorArmToken(principal);
    try {
      return (await arm.listSubscriptions(token))
        .filter((s) => s.tenantId?.toLowerCase() === link.tenantId)
        .map((s) => ({ id: s.subscriptionId, name: s.displayName, state: s.state }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      armFailure(e);
    }
  }

  async function regions(principal: Principal, subscriptionId: string | null) {
    if (!subscriptionId || !guidPattern.test(subscriptionId)) throw new HttpError(400, 'invalid-subscription', 'Choose a subscription.');
    const subscriptions = await mySubscriptions(principal);
    if (!subscriptions.some((s) => s.id.toLowerCase() === subscriptionId.toLowerCase())) {
      throw new HttpError(404, 'subscription-not-found', 'That subscription is not one you can see in the connected tenant.');
    }
    const { token } = await operatorArmToken(principal);
    try {
      return { regions: await arm.listHostPoolRegions(token, subscriptionId) };
    } catch (e) {
      armFailure(e);
    }
  }

  const onboardingArm = options.onboardingArm ?? defaultOnboardingArm;
  const graphApi = options.graph ?? defaultGraph;
  const appObjectIds = new Map<string, string>();

  function onboardingRequest(body: Record<string, unknown>): OnboardingRequest {
    const subscriptionId = typeof body.subscriptionId === 'string' ? body.subscriptionId.toLowerCase() : '';
    const resourceGroup = typeof body.resourceGroup === 'string' ? body.resourceGroup.trim() : '';
    const location = typeof body.location === 'string' ? body.location.trim().toLowerCase() : '';
    if (!guidPattern.test(subscriptionId)) throw new HttpError(400, 'invalid-subscription', 'Choose a subscription.');
    if (!/^[A-Za-z0-9._()-]{1,90}$/.test(resourceGroup) || resourceGroup.endsWith('.')) throw new HttpError(400, 'invalid-resource-group', 'Resource group names are 1-90 letters, digits and . _ - ( ), not ending in a full stop.');
    if (!/^[a-z0-9]{2,40}$/.test(location)) throw new HttpError(400, 'invalid-location', 'Choose a region.');
    return { subscriptionId, resourceGroup, location, scaling: body.scaling !== false };
  }

  async function onboardingContext(principal: Principal, request: OnboardingRequest): Promise<{ orgId: string; context: OnboardingContext; link: AccountLink; tenant: TenantConnection }> {
    const entra = requireEntra();
    const sealer = requireSealer();
    const { orgId } = await requirePermission(principal, 'admin');
    const tenant = await requireTenant(orgId);
    if (!(await mySubscriptions(principal)).some((s) => s.id.toLowerCase() === request.subscriptionId)) {
      throw new HttpError(404, 'subscription-not-found', 'That subscription is not one you can see in the connected tenant.');
    }
    const { token, link } = await operatorArmToken(principal);
    try {
      if (!(await arm.listHostPoolRegions(token, request.subscriptionId)).some((r) => r.name === request.location)) {
        throw new HttpError(400, 'invalid-location', 'Azure Virtual Desktop is not offered in that region.');
      }
    } catch (e) {
      armFailure(e);
    }
    let appObjectId = appObjectIds.get(tenant.tenantId);
    if (!appObjectId) {
      try {
        appObjectId = await entra.appObjectId(tenant.tenantId);
      } catch (e) {
        throw new HttpError(409, 'app-not-consented', e instanceof EntraError ? e.message : 'AKC AVD Deploy is not approved in this tenant. Connect the tenant again.');
      }
      appObjectIds.set(tenant.tenantId, appObjectId);
    }
    let avdObjectId: string | null = null;
    if (request.scaling) {
      try {
        avdObjectId = await graphApi.avdServicePrincipalId(await entra.graphToken(tenant.tenantId, await sealer.open(link.sealedRefreshToken)));
      } catch (e) {
        if (e instanceof RelinkNeededError) throw new HttpError(409, 'relink-needed', 'Microsoft needs you to sign in again. Link your account again.');
        throw new HttpError(502, 'graph-error', e instanceof Error ? e.message : 'Could not look up the Azure Virtual Desktop service.');
      }
    }
    return { orgId, link, tenant, context: { token, arm: onboardingArm, appObjectId, avdObjectId } };
  }

  async function onboard(principal: Principal, body: Record<string, unknown>, apply: boolean) {
    const request = onboardingRequest(body);
    const { orgId, context, link, tenant } = await onboardingContext(principal, request);
    try {
      let actions = await checkOnboarding(request, context);
      if (apply) {
        await applyOnboarding(request, context, actions);
        actions = await checkOnboarding(request, context);
      }
      const ready = actions.every((a) => a.status === 'done');
      if (ready) {
        await options.store.putOnboarding({
          orgId, tenantId: tenant.tenantId, subscriptionId: request.subscriptionId, resourceGroup: request.resourceGroup, location: request.location,
          scaling: request.scaling, onboardedBy: principal.userId, onboardedByUsername: link.username, onboardedAt: now().toISOString(),
        });
      }
      return { actions, ready };
    } catch (e) {
      armFailure(e);
    }
  }

  async function listOnboardings(principal: Principal) {
    const { orgId } = await requirePermission(principal, 'read');
    const records = await options.store.listOnboardings(orgId);
    return {
      onboardings: records
        .sort((a, b) => b.onboardedAt.localeCompare(a.onboardedAt))
        .map((o) => ({ subscriptionId: o.subscriptionId, resourceGroup: o.resourceGroup, location: o.location, scaling: o.scaling, onboardedBy: o.onboardedByUsername, onboardedAt: o.onboardedAt })),
    };
  }

  async function me(principal: Principal) {
    if (!principal.orgId) return { userId: principal.userId, isAkcAdmin: isAkcAdmin(principal), organisation: null };
    const record = await options.store.getOrganisation(principal.orgId);
    const roles = record?.status === 'approved' ? ((await options.store.getMemberRoles(principal.orgId, principal.userId))?.roles ?? []) : [];
    const tenant = record?.status === 'approved' ? tenantView(await options.store.getTenantConnection(principal.orgId)) : null;
    const link = tenant ? linkView(await options.store.getAccountLink(principal.orgId, principal.userId)) : null;
    return {
      userId: principal.userId,
      isAkcAdmin: isAkcAdmin(principal),
      organisation: {
        id: principal.orgId,
        clerkRole: principal.orgRole ?? null,
        // ADR 0018: only Clerk's organisation admin may request AVD; no other Clerk role means anything here.
        canRequest: principal.orgRole === 'admin',
        avd: record ? { ...organisationView(record), roles, permissions: permissionsFor(roles), tenant, link, connectAvailable: !!options.entra, linkAvailable: !!options.entra && !!options.sealer } : null,
      },
    };
  }

  async function requestAvd(principal: Principal, body: Record<string, unknown>) {
    if (!principal.orgId) throw new HttpError(400, 'no-organisation', 'Choose or create an organisation first.');
    if (principal.orgRole !== 'admin') throw new HttpError(403, 'not-org-admin', "Only the organisation's admin can request AVD.");
    const existing = await options.store.getOrganisation(principal.orgId);
    if (existing) {
      if (existing.status === 'declined') throw new HttpError(409, 'declined', 'This organisation was not approved. Contact hello@andykemp.com.');
      return { organisation: organisationView(existing) };
    }
    const record: OrganisationRecord = {
      orgId: principal.orgId,
      name: text(body.name, 'Organisation name', 100, true),
      status: 'pending',
      requestedBy: principal.userId,
      requesterName: text(body.requesterName, 'Your name', 100, false),
      requesterEmail: text(body.requesterEmail, 'Your email', 254, false),
      requestedAt: now().toISOString(),
    };
    await options.store.createOrganisation(record);
    return { organisation: organisationView(record) };
  }

  async function listRequests(principal: Principal, status: string | null) {
    requireAkcAdmin(principal);
    if (status && !statuses.includes(status as OrganisationStatus)) throw new HttpError(400, 'invalid-status', 'Unknown status.');
    const records = await options.store.listOrganisations((status as OrganisationStatus) || undefined);
    records.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return {
      organisations: records.map((r) => ({ ...organisationView(r), requestedBy: r.requestedBy, requesterName: r.requesterName, requesterEmail: r.requesterEmail, decidedBy: r.decidedBy ?? null })),
    };
  }

  async function decide(principal: Principal, orgId: string, decision: 'approve' | 'decline') {
    requireAkcAdmin(principal);
    const at = now().toISOString();
    const record = await options.store.decideOrganisation(orgId, decision === 'approve' ? 'approved' : 'declined', principal.userId, at);
    if (decision === 'approve') {
      // The requester becomes the organisation's first AVD Admin (ADR 0018).
      await options.store.putMemberRoles({ orgId, userId: record.requestedBy, roles: ['admin'], grantedBy: principal.userId, grantedAt: at });
    }
    return { organisation: organisationView(record) };
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
    try {
      if (route === 'GET /api/health') return send(res, 200, { ok: true });
      const principal = await options.verify(req.headers.authorization);
      if (route === 'GET /api/me') return send(res, 200, await me(principal));
      if (route === 'POST /api/organisations/request') return send(res, 200, await requestAvd(principal, await readJson(req)));
      if (route === 'GET /api/admin/organisations') return send(res, 200, await listRequests(principal, url.searchParams.get('status')));
      if (route === 'POST /api/tenants/connect/start') return send(res, 200, await connectStart(principal));
      if (route === 'POST /api/tenants/connect/consented') return send(res, 200, await connectConsented(principal, await readJson(req)));
      if (route === 'POST /api/tenants/connect/verify') return send(res, 200, await connectVerify(principal, await readJson(req)));
      if (route === 'POST /api/accounts/link/start') return send(res, 200, await linkStart(principal));
      if (route === 'POST /api/accounts/link/complete') return send(res, 200, await linkComplete(principal, await readJson(req)));
      if (route === 'DELETE /api/accounts/link') return send(res, 200, await unlink(principal));
      if (route === 'GET /api/discovery/subscriptions') return send(res, 200, { subscriptions: await mySubscriptions(principal) });
      if (route === 'GET /api/discovery/regions') return send(res, 200, await regions(principal, url.searchParams.get('subscriptionId')));
      if (route === 'POST /api/onboarding/check') return send(res, 200, await onboard(principal, await readJson(req), false));
      if (route === 'POST /api/onboarding/apply') return send(res, 200, await onboard(principal, await readJson(req), true));
      if (route === 'GET /api/onboarding') return send(res, 200, await listOnboardings(principal));
      const decision = /^POST \/api\/admin\/organisations\/([^/]+)\/(approve|decline)$/.exec(route);
      if (decision) {
        if (!orgIdPattern.test(decision[1])) throw new HttpError(400, 'invalid-organisation', 'Not a Clerk organisation ID.');
        return send(res, 200, await decide(principal, decision[1], decision[2] as 'approve' | 'decline'));
      }
      throw new HttpError(404, 'not-found', 'Unknown endpoint.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      console.error(`${route} failed:`, e instanceof Error ? e.message : e);
      return send(res, 500, { error: 'Something went wrong.', code: 'internal' });
    }
  };
}

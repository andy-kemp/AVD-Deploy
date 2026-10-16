// HTTP routes for Get started, organisation approval and Connect tenant (docs/hosted-service.md).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, type Principal, type Verifier } from './auth.ts';
import { codeChallenge, consentAdminRoles, EntraError, randomToken, type Entra } from './entra.ts';
import { permissionsFor, type AvdPermission } from './roles.ts';
import type { ConnectState, OrganisationRecord, OrganisationStatus, Store, TenantConnection } from './store.ts';

export interface AppOptions {
  verify: Verifier;
  store: Store;
  akcAdminUserIds: Set<string>;
  /** Absent when the multi-tenant Entra app isn't configured yet; Connect tenant then reports that. */
  entra?: Entra;
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

  const expiry = () => new Date(now().getTime() + connectStateMinutes * 60_000).toISOString();

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

  async function me(principal: Principal) {
    if (!principal.orgId) return { userId: principal.userId, isAkcAdmin: isAkcAdmin(principal), organisation: null };
    const record = await options.store.getOrganisation(principal.orgId);
    const roles = record?.status === 'approved' ? ((await options.store.getMemberRoles(principal.orgId, principal.userId))?.roles ?? []) : [];
    const tenant = record?.status === 'approved' ? tenantView(await options.store.getTenantConnection(principal.orgId)) : null;
    return {
      userId: principal.userId,
      isAkcAdmin: isAkcAdmin(principal),
      organisation: {
        id: principal.orgId,
        clerkRole: principal.orgRole ?? null,
        // ADR 0018: only Clerk's organisation admin may request AVD; no other Clerk role means anything here.
        canRequest: principal.orgRole === 'admin',
        avd: record ? { ...organisationView(record), roles, permissions: permissionsFor(roles), tenant, connectAvailable: !!options.entra } : null,
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

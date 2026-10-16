// HTTP routes for Get started and organisation approval (docs/hosted-service.md, First run and invitations).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, type Principal, type Verifier } from './auth.ts';
import { permissionsFor } from './roles.ts';
import type { OrganisationRecord, OrganisationStatus, Store } from './store.ts';

export interface AppOptions {
  verify: Verifier;
  store: Store;
  akcAdminUserIds: Set<string>;
  now?: () => Date;
}

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

export function createApp(options: AppOptions) {
  const now = options.now ?? (() => new Date());
  const isAkcAdmin = (principal: Principal) => options.akcAdminUserIds.has(principal.userId);

  function requireAkcAdmin(principal: Principal) {
    if (!isAkcAdmin(principal)) throw new HttpError(403, 'forbidden', 'Only AKC staff can do this.');
  }

  async function me(principal: Principal) {
    if (!principal.orgId) return { userId: principal.userId, isAkcAdmin: isAkcAdmin(principal), organisation: null };
    const record = await options.store.getOrganisation(principal.orgId);
    const roles = record?.status === 'approved' ? ((await options.store.getMemberRoles(principal.orgId, principal.userId))?.roles ?? []) : [];
    return {
      userId: principal.userId,
      isAkcAdmin: isAkcAdmin(principal),
      organisation: {
        id: principal.orgId,
        clerkRole: principal.orgRole ?? null,
        // ADR 0018: only Clerk's organisation admin may request AVD; no other Clerk role means anything here.
        canRequest: principal.orgRole === 'admin',
        avd: record ? { ...organisationView(record), roles, permissions: permissionsFor(roles) } : null,
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

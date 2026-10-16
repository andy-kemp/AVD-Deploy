// Get started and approval, end to end against the HTTP handler, with tokens signed by a local test key.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.ts';
import { createVerifier } from '../src/auth.ts';
import { issuerFromPublishableKey } from '../src/config.ts';
import { MemoryStore } from '../src/store.ts';

const issuer = 'https://clerk.andykemp.com';
const portal = 'https://avd-deploy.andykemp.com';
const akcAdmin = 'user_akcadmin0000000001';
const owner = 'user_owner00000000000001';
const colleague = 'user_colleague000000001';
const org = 'org_contoso000000000001';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let server: Server;
let otherKey: Key;
let base: string;
let sign: (claims: Record<string, unknown>, options?: { key?: Key; issuer?: string; expired?: boolean }) => Promise<string>;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  sign = async (claims, options = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: 'sess_test', v: 2, sts: 'active', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(options.issuer ?? issuer)
      .setSubject(String(claims.sub ?? owner))
      .setIssuedAt(now - 10)
      .setNotBefore(now - 10)
      .setExpirationTime(options.expired ? now - 60 : now + 60)
      .sign(options.key ?? privateKey);
  };
  otherKey = other.privateKey;
  const verify = createVerifier({ issuer, authorizedParties: [portal], getKey: createLocalJWKSet({ keys: [jwk] }) });
  server = createServer(createApp({ verify, store: new MemoryStore(), akcAdminUserIds: new Set([akcAdmin]) }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const session = (sub: string, extra: Record<string, unknown> = {}) => sign({ sub, azp: portal, ...extra });
const inOrg = (sub: string, rol: string) => session(sub, { o: { id: org, rol } });

describe('token verification', () => {
  it('rejects requests without a token', async () => {
    assert.equal((await call('GET', '/api/me')).status, 401);
  });

  it('rejects a token issued for another andykemp.com app', async () => {
    const result = await call('GET', '/api/me', await sign({ sub: owner, azp: 'https://audit.andykemp.com' }));
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'wrong-audience');
  });

  it('rejects a token without azp', async () => {
    assert.equal((await call('GET', '/api/me', await sign({ sub: owner }))).body.code, 'wrong-audience');
  });

  it('rejects a token from another issuer, an unknown key, or one that has expired', async () => {
    assert.equal((await call('GET', '/api/me', await sign({ sub: owner, azp: portal }, { issuer: 'https://clerk.example.com' }))).body.code, 'invalid-token');
    assert.equal((await call('GET', '/api/me', await sign({ sub: owner, azp: portal }, { key: otherKey }))).body.code, 'invalid-token');
    assert.equal((await call('GET', '/api/me', await sign({ sub: owner, azp: portal }, { expired: true }))).body.code, 'token-expired');
  });

  it('rejects a session that still has pending tasks', async () => {
    assert.equal((await call('GET', '/api/me', await session(owner, { sts: 'pending' }))).body.code, 'session-not-active');
  });
});

describe('get started', () => {
  it('reports no organisation until one is active', async () => {
    const result = await call('GET', '/api/me', await session(owner));
    assert.equal(result.status, 200);
    assert.equal(result.body.organisation, null);
    assert.equal(result.body.isAkcAdmin, false);
  });

  it('lets only the Clerk organisation admin request AVD', async () => {
    const member = await call('POST', '/api/organisations/request', await inOrg(colleague, 'member'), { name: 'Contoso' });
    assert.equal(member.status, 403);
    assert.equal(member.body.code, 'not-org-admin');
    const noOrg = await call('POST', '/api/organisations/request', await session(owner), { name: 'Contoso' });
    assert.equal(noOrg.body.code, 'no-organisation');
  });

  it('validates the organisation name', async () => {
    assert.equal((await call('POST', '/api/organisations/request', await inOrg(owner, 'admin'), { name: '<script>' })).status, 400);
    assert.equal((await call('POST', '/api/organisations/request', await inOrg(owner, 'admin'), { name: '' })).status, 400);
  });

  it('records a pending request, idempotently, and grants nothing yet', async () => {
    const first = await call('POST', '/api/organisations/request', await inOrg(owner, 'admin'), { name: 'Contoso', requesterName: 'Jo', requesterEmail: 'jo@contoso.com' });
    assert.equal(first.status, 200);
    assert.equal(first.body.organisation.status, 'pending');
    const again = await call('POST', '/api/organisations/request', await inOrg(owner, 'admin'), { name: 'Contoso again' });
    assert.equal(again.body.organisation.name, 'Contoso');
    const me = await call('GET', '/api/me', await inOrg(owner, 'admin'));
    assert.equal(me.body.organisation.avd.status, 'pending');
    assert.deepEqual(me.body.organisation.avd.permissions, []);
  });
});

describe('approval', () => {
  it('is only for AKC admins', async () => {
    assert.equal((await call('GET', '/api/admin/organisations', await inOrg(owner, 'admin'))).status, 403);
    assert.equal((await call('POST', `/api/admin/organisations/${org}/approve`, await inOrg(owner, 'admin'))).status, 403);
  });

  it('lists pending requests for AKC admins', async () => {
    const result = await call('GET', '/api/admin/organisations?status=pending', await session(akcAdmin));
    assert.equal(result.status, 200);
    assert.equal(result.body.organisations.length, 1);
    assert.equal(result.body.organisations[0].requesterEmail, 'jo@contoso.com');
  });

  it('approves once and makes the requester the first AVD Admin', async () => {
    const approved = await call('POST', `/api/admin/organisations/${org}/approve`, await session(akcAdmin));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.organisation.status, 'approved');
    assert.equal((await call('POST', `/api/admin/organisations/${org}/decline`, await session(akcAdmin))).status, 409);
    const me = await call('GET', '/api/me', await inOrg(owner, 'admin'));
    assert.deepEqual(me.body.organisation.avd.roles, ['admin']);
    assert.deepEqual(me.body.organisation.avd.permissions, ['admin', 'approve', 'operate', 'read']);
  });

  it('gives other members of an approved organisation no AVD role until one is granted', async () => {
    const me = await call('GET', '/api/me', await inOrg(colleague, 'admin'));
    assert.equal(me.body.organisation.avd.status, 'approved');
    assert.deepEqual(me.body.organisation.avd.roles, []);
  });

  it('rejects malformed organisation IDs', async () => {
    assert.equal((await call('POST', '/api/admin/organisations/not-an-org/approve', await session(akcAdmin))).body.code, 'invalid-organisation');
  });
});

describe('configuration', () => {
  it('derives the issuer from a publishable key', () => {
    assert.equal(issuerFromPublishableKey('pk_live_Y2xlcmsuYW5keWtlbXAuY29tJA'), 'https://clerk.andykemp.com');
    assert.throws(() => issuerFromPublishableKey('sk_live_secret'));
  });
});

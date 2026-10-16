// Connect tenant (ADR 0018), with a fake Microsoft Entra so every failure path can be exercised.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.ts';
import { createVerifier } from '../src/auth.ts';
import type { Entra, VerifiedSignIn } from '../src/entra.ts';
import { MemoryStore } from '../src/store.ts';

const issuer = 'https://clerk.andykemp.com';
const portal = 'https://avd-deploy.andykemp.com';
const owner = 'user_owner00000000000001';
const reader = 'user_reader0000000000001';
const otherOwner = 'user_otherowner00000001';
const org = 'org_contoso000000000001';
const otherOrg = 'org_fabrikam00000000001';
const tenant = '11111111-2222-4333-8444-555555555555';
const globalAdmin = '62e90394-69f5-4237-9190-012177145e10';

let server: Server;
let base: string;
let store: MemoryStore;
let sign: (claims: Record<string, unknown>) => Promise<string>;
let now = new Date('2026-10-17T09:00:00Z');

// The fake records what it was asked and returns whatever the test sets.
const fake = {
  signIn: { tenantId: tenant, objectId: 'oid-admin', username: 'admin@contoso.com', roles: [globalAdmin], tenantName: 'Contoso' } as VerifiedSignIn,
  consented: true,
  lastVerify: null as null | { tenantId: string; nonce: string; challenge: string },
};
const entra: Entra = {
  adminConsentUrl: (state) => `https://login.example/adminconsent?state=${state}`,
  verifySignInUrl: (tenantId, state, nonce, challenge) => {
    fake.lastVerify = { tenantId, nonce, challenge };
    return `https://login.example/${tenantId}/authorize?state=${state}`;
  },
  redeemSignIn: async (tenantId, _code, _verifier, nonce) => {
    assert.equal(nonce, fake.lastVerify?.nonce);
    return { ...fake.signIn, tenantId: fake.signIn.tenantId || tenantId };
  },
  appIsConsented: async () => fake.consented,
  linkSignInUrl: () => 'https://login.example/link',
  redeemLink: async () => { throw new Error('not used'); },
  armToken: async () => { throw new Error('not used'); },
};

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  sign = (claims) => {
    const t = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: 'sess_test', v: 2, sts: 'active', azp: portal, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setSubject(String(claims.sub))
      .setIssuedAt(t - 10).setNotBefore(t - 10).setExpirationTime(t + 60).sign(privateKey);
  };
  store = new MemoryStore();
  const verify = createVerifier({ issuer, authorizedParties: [portal], getKey: createLocalJWKSet({ keys: [jwk] }) });
  server = createServer(createApp({ verify, store, akcAdminUserIds: new Set(), entra, now: () => now }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  // Two approved organisations: Contoso (owner is AVD Admin, reader is Reader) and Fabrikam.
  for (const [id, requester] of [[org, owner], [otherOrg, otherOwner]] as const) {
    await store.createOrganisation({ orgId: id, name: id, status: 'pending', requestedBy: requester, requesterName: '', requesterEmail: '', requestedAt: now.toISOString() });
    await store.decideOrganisation(id, 'approved', 'akc', now.toISOString());
    await store.putMemberRoles({ orgId: id, userId: requester, roles: ['admin'], grantedBy: 'akc', grantedAt: now.toISOString() });
  }
  await store.putMemberRoles({ orgId: org, userId: reader, roles: ['reader'], grantedBy: owner, grantedAt: now.toISOString() });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  fake.signIn = { tenantId: tenant, objectId: 'oid-admin', username: 'admin@contoso.com', roles: [globalAdmin], tenantName: 'Contoso' };
  fake.consented = true;
  now = new Date('2026-10-17T09:00:00Z');
});

async function call(path: string, sub: string, orgId: string, body?: unknown) {
  const token = await sign({ sub, o: { id: orgId, rol: 'admin' } });
  const response = await fetch(`${base}${path}`, {
    method: body === undefined && path.startsWith('/api/me') ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const stateFrom = (url: string) => new URL(url).searchParams.get('state')!;

/** Runs start and the consent callback, returning the verify-stage state. */
async function startAndConsent(sub = owner, orgId = org, consentTenant = tenant) {
  const start = await call('/api/tenants/connect/start', sub, orgId);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const consented = await call('/api/tenants/connect/consented', sub, orgId, { state: stateFrom(start.body.url), tenant: consentTenant, adminConsent: 'True' });
  assert.equal(consented.status, 200, JSON.stringify(consented.body));
  return stateFrom(consented.body.url);
}

describe('connect tenant', () => {
  it('is for AVD Admins of approved organisations only', async () => {
    const result = await call('/api/tenants/connect/start', reader, org);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'forbidden');
  });

  it('uses PKCE and asks the signing-in tenant that consented', async () => {
    await startAndConsent();
    assert.equal(fake.lastVerify?.tenantId, tenant);
    assert.match(fake.lastVerify?.challenge ?? '', /^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a state used twice, by someone else, or after it expires', async () => {
    const start = await call('/api/tenants/connect/start', owner, org);
    const state = stateFrom(start.body.url);
    assert.equal((await call('/api/tenants/connect/consented', otherOwner, otherOrg, { state, tenant })).body.code, 'invalid-state');
    // The failed attempt consumed it, so the owner can't use it either.
    assert.equal((await call('/api/tenants/connect/consented', owner, org, { state, tenant })).body.code, 'invalid-state');
    const fresh = stateFrom((await call('/api/tenants/connect/start', owner, org)).body.url);
    now = new Date(now.getTime() + 16 * 60_000);
    assert.equal((await call('/api/tenants/connect/consented', owner, org, { state: fresh, tenant })).body.code, 'invalid-state');
  });

  it('reports a declined consent in plain words', async () => {
    const state = stateFrom((await call('/api/tenants/connect/start', owner, org)).body.url);
    const result = await call('/api/tenants/connect/consented', owner, org, { state, error: 'access_denied', errorDescription: 'AADSTS65004: User declined to consent.' });
    assert.equal(result.body.code, 'consent-failed');
    assert.match(result.body.error, /declined/);
  });

  it('rejects a sign-in to a different tenant from the one that consented', async () => {
    const state = await startAndConsent();
    fake.signIn = { ...fake.signIn, tenantId: '99999999-2222-4333-8444-555555555555' };
    assert.equal((await call('/api/tenants/connect/verify', owner, org, { state, code: 'code' })).body.code, 'tenant-mismatch');
  });

  it('requires a directory role that can grant consent', async () => {
    const state = await startAndConsent();
    fake.signIn = { ...fake.signIn, roles: ['b79fbf4d-3ef9-4689-8143-76b194e85509'] };
    const result = await call('/api/tenants/connect/verify', owner, org, { state, code: 'code' });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'not-tenant-admin');
  });

  it('requires the app to really be consented in the tenant', async () => {
    const state = await startAndConsent();
    fake.consented = false;
    assert.equal((await call('/api/tenants/connect/verify', owner, org, { state, code: 'code' })).body.code, 'not-consented');
  });

  it('connects the tenant and shows it to members', async () => {
    const state = await startAndConsent();
    const result = await call('/api/tenants/connect/verify', owner, org, { state, code: 'code' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.consentedAs, 'Global Administrator');
    const me = await call('/api/me', reader, org);
    assert.deepEqual(me.body.organisation.avd.tenant, { tenantId: tenant, name: 'Contoso', connectedAt: now.toISOString(), consentedBy: 'admin@contoso.com' });
  });

  it('never lets a second organisation claim a connected tenant', async () => {
    const state = await startAndConsent(otherOwner, otherOrg);
    const result = await call('/api/tenants/connect/verify', otherOwner, otherOrg, { state, code: 'code' });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'tenant-taken');
  });
});

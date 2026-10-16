// Link Microsoft account and first discovery, with fake Entra and ARM.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.ts';
import type { Arm } from '../src/arm.ts';
import { createVerifier } from '../src/auth.ts';
import { RelinkNeededError, type Entra, type LinkedSignIn } from '../src/entra.ts';
import { MemorySealer } from '../src/sealer.ts';
import { MemoryStore } from '../src/store.ts';

const issuer = 'https://clerk.andykemp.com';
const portal = 'https://avd-deploy.andykemp.com';
const operator = 'user_operator0000000001';
const outsider = 'user_outsider0000000001';
const org = 'org_contoso000000000001';
const noTenantOrg = 'org_notenant00000000001';
const tenant = '11111111-2222-4333-8444-555555555555';
const otherTenant = '99999999-2222-4333-8444-555555555555';
const subA = 'aaaaaaaa-0000-4000-8000-000000000001';
const subB = 'bbbbbbbb-0000-4000-8000-000000000002';
const foreignSub = 'cccccccc-0000-4000-8000-000000000003';

let server: Server;
let base: string;
let store: MemoryStore;
let sign: (claims: Record<string, unknown>) => Promise<string>;

const fake = {
  linked: { tenantId: tenant, objectId: 'oid-op', username: 'op@contoso.com', mfa: true, refreshToken: 'rt-1', accessToken: 'at-1', expiresAt: 0 } as LinkedSignIn,
  refreshCalls: 0,
  refreshFails: false,
  lastRefreshToken: '',
};
const entra: Entra = {
  adminConsentUrl: () => '',
  verifySignInUrl: () => '',
  redeemSignIn: async () => { throw new Error('not used'); },
  appIsConsented: async () => true,
  linkSignInUrl: (tenantId, state) => `https://login.example/${tenantId}/authorize?state=${state}`,
  redeemLink: async () => ({ ...fake.linked }),
  armToken: async (_tenantId, refreshToken) => {
    fake.refreshCalls++;
    fake.lastRefreshToken = refreshToken;
    if (fake.refreshFails) throw new RelinkNeededError('AADSTS700082: The refresh token has expired.');
    return { accessToken: `at-${fake.refreshCalls + 1}`, expiresAt: Date.now() + 3600_000, refreshToken: `rt-${fake.refreshCalls + 1}` };
  },
  graphToken: async () => 'graph-token',
  appObjectId: async () => 'app-oid',
};
const arm: Arm = {
  listSubscriptions: async (token) => {
    assert.match(token, /^at-/);
    return [
      { subscriptionId: subB, displayName: 'Production', state: 'Enabled', tenantId: tenant },
      { subscriptionId: subA, displayName: 'Dev', state: 'Enabled', tenantId: tenant },
      { subscriptionId: foreignSub, displayName: 'Guest access elsewhere', state: 'Enabled', tenantId: otherTenant },
    ];
  },
  listHostPoolRegions: async (_token, subscriptionId) => [{ name: 'uksouth', displayName: `UK South (${subscriptionId.slice(0, 4)})` }],
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
  server = createServer(createApp({ verify, store, akcAdminUserIds: new Set(), entra, arm, sealer: new MemorySealer() }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const at = new Date().toISOString();
  for (const id of [org, noTenantOrg]) {
    await store.createOrganisation({ orgId: id, name: id, status: 'pending', requestedBy: operator, requesterName: '', requesterEmail: '', requestedAt: at });
    await store.decideOrganisation(id, 'approved', 'akc', at);
    await store.putMemberRoles({ orgId: id, userId: operator, roles: ['operator'], grantedBy: 'akc', grantedAt: at });
  }
  await store.connectTenant({ orgId: org, tenantId: tenant, tenantName: 'Contoso', connectedBy: operator, consentedByObjectId: 'oid-admin', consentedByUsername: 'admin@contoso.com', connectedAt: at });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  fake.linked = { tenantId: tenant, objectId: 'oid-op', username: 'op@contoso.com', mfa: true, refreshToken: 'rt-1', accessToken: 'at-1', expiresAt: Date.now() - 1 };
  fake.refreshFails = false;
});

async function call(method: string, path: string, sub = operator, orgId = org, body?: unknown) {
  const token = await sign({ sub, o: { id: orgId, rol: 'member' } });
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function link(sub = operator, orgId = org) {
  const start = await call('POST', '/api/accounts/link/start', sub, orgId);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const state = new URL(start.body.url).searchParams.get('state');
  return call('POST', '/api/accounts/link/complete', sub, orgId, { state, code: 'code' });
}

describe('link Microsoft account', () => {
  it('needs an AVD role and a connected tenant', async () => {
    assert.equal((await call('POST', '/api/accounts/link/start', outsider)).body.code, 'forbidden');
    assert.equal((await call('POST', '/api/accounts/link/start', operator, noTenantOrg)).body.code, 'no-tenant');
  });

  it('rejects an account from a different tenant', async () => {
    fake.linked = { ...fake.linked, tenantId: otherTenant };
    const result = await link();
    assert.equal(result.body.code, 'tenant-mismatch');
    assert.equal(await store.getAccountLink(org, operator), null);
  });

  it('stores the refresh token sealed, never in clear, and shows the link', async () => {
    const result = await link();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(Object.keys(result.body.link).sort(), ['linkedAt', 'mfa', 'username']);
    const stored = await store.getAccountLink(org, operator);
    assert.ok(stored);
    assert.ok(!stored.sealedRefreshToken.includes('rt-1'));
    const me = await call('GET', '/api/me');
    assert.equal(me.body.organisation.avd.link.username, 'op@contoso.com');
    assert.equal(me.body.organisation.avd.link.mfa, true);
  });
});

describe('discovery', () => {
  it('lists only subscriptions in the connected tenant, refreshing and re-sealing the token', async () => {
    await link();
    const result = await call('GET', '/api/discovery/subscriptions');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.subscriptions.map((s: { name: string }) => s.name), ['Dev', 'Production']);
    assert.equal(fake.lastRefreshToken, 'rt-1');
    const stored = await store.getAccountLink(org, operator);
    assert.ok(stored && !stored.sealedRefreshToken.includes('rt-'));
  });

  it('only looks up regions for a subscription the operator can see', async () => {
    await link();
    assert.equal((await call('GET', `/api/discovery/regions?subscriptionId=${subA}`)).body.regions[0].name, 'uksouth');
    assert.equal((await call('GET', `/api/discovery/regions?subscriptionId=${foreignSub}`)).body.code, 'subscription-not-found');
    assert.equal((await call('GET', '/api/discovery/regions?subscriptionId=not-a-guid')).body.code, 'invalid-subscription');
  });

  it("never uses another person's link", async () => {
    await link();
    await store.putMemberRoles({ orgId: org, userId: outsider, roles: ['reader'], grantedBy: operator, grantedAt: new Date().toISOString() });
    assert.equal((await call('GET', '/api/discovery/subscriptions', outsider)).body.code, 'not-linked');
  });

  it('asks the operator to link again when Microsoft refuses the refresh token', async () => {
    await link();
    fake.refreshFails = true;
    const result = await call('GET', '/api/discovery/subscriptions');
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'relink-needed');
    assert.equal(await store.getAccountLink(org, operator), null);
  });

  it('unlinks and forgets the token', async () => {
    await link();
    assert.equal((await call('DELETE', '/api/accounts/link')).status, 200);
    assert.equal(await store.getAccountLink(org, operator), null);
    assert.equal((await call('GET', '/api/discovery/subscriptions')).body.code, 'not-linked');
  });
});

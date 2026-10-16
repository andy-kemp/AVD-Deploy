// Onboard subscription, against an in-memory Azure that records every change.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.ts';
import type { Arm, OnboardingArm, RoleAssignment } from '../src/arm.ts';
import { ArmError } from '../src/arm.ts';
import { createVerifier } from '../src/auth.ts';
import type { Entra } from '../src/entra.ts';
import { assignableRoles, assignmentCondition, avdProviders } from '../src/onboarding.ts';
import { MemorySealer } from '../src/sealer.ts';
import { MemoryStore } from '../src/store.ts';

const issuer = 'https://clerk.andykemp.com';
const portal = 'https://avd-deploy.andykemp.com';
const admin = 'user_admin00000000000001';
const operator = 'user_operator0000000001';
const org = 'org_contoso000000000001';
const tenant = '11111111-2222-4333-8444-555555555555';
const sub = 'aaaaaaaa-0000-4000-8000-000000000001';
const appOid = 'app-oid-in-customer-tenant';
const avdOid = 'avd-service-oid';
const rgScope = `/subscriptions/${sub}/resourceGroups/rg-avd`;

let server: Server;
let base: string;
let store: MemoryStore;
let sign: (claims: Record<string, unknown>) => Promise<string>;

// In-memory Azure for one subscription.
const azure = {
  providers: new Map<string, string>(),
  groups: new Map<string, string>(),
  assignments: [] as (RoleAssignment & { principalId: string })[],
  forbidden: false,
  puts: 0,
};
function resetAzure() {
  azure.providers = new Map(avdProviders.map((ns) => [ns, ns === 'Microsoft.Network' ? 'Registered' : 'NotRegistered']));
  azure.groups = new Map();
  azure.assignments = [];
  azure.forbidden = false;
  azure.puts = 0;
}
const onboardingArm: OnboardingArm = {
  providerState: async (_t, _s, ns) => azure.providers.get(ns) ?? 'NotRegistered',
  registerProvider: async (_t, _s, ns) => { azure.providers.set(ns, 'Registering'); },
  resourceGroupLocation: async (_t, _s, name) => azure.groups.get(name.toLowerCase()) ?? null,
  createResourceGroup: async (_t, _s, name, location) => {
    if (azure.forbidden) throw new ArmError(403, 'Your account is not allowed to do this. Onboarding needs Owner (or User Access Administrator and Contributor) on the subscription.');
    azure.groups.set(name.toLowerCase(), location);
  },
  roleAssignments: async (_t, scope, principalId) => azure.assignments.filter((a) => a.scope.toLowerCase() === scope.toLowerCase() && a.principalId === principalId),
  assignRole: async (_t, scope, a) => {
    azure.puts++;
    const existing = azure.assignments.find((x) => x.name === a.name);
    if (existing) Object.assign(existing, { condition: a.condition ?? '' });
    else azure.assignments.push({ name: a.name, scope, roleId: a.roleId, condition: a.condition ?? '', principalId: a.principalId });
  },
};
const arm: Arm = {
  listSubscriptions: async () => [{ subscriptionId: sub, displayName: 'Dev', state: 'Enabled', tenantId: tenant }],
  listHostPoolRegions: async () => [{ name: 'uksouth', displayName: 'UK South' }],
};
const entra: Entra = {
  adminConsentUrl: () => '', verifySignInUrl: () => '', redeemSignIn: async () => { throw new Error('unused'); }, appIsConsented: async () => true,
  linkSignInUrl: () => '', redeemLink: async () => { throw new Error('unused'); },
  armToken: async () => ({ accessToken: 'at', expiresAt: Date.now() + 3600_000 }),
  graphToken: async () => 'graph-token',
  appObjectId: async () => appOid,
};

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  sign = (claims) => {
    const t = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: 'sess_test', v: 2, sts: 'active', azp: portal, o: { id: org, rol: 'member' }, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setSubject(String(claims.sub))
      .setIssuedAt(t - 10).setNotBefore(t - 10).setExpirationTime(t + 60).sign(privateKey);
  };
  store = new MemoryStore();
  const sealer = new MemorySealer();
  const verify = createVerifier({ issuer, authorizedParties: [portal], getKey: createLocalJWKSet({ keys: [jwk] }) });
  server = createServer(createApp({ verify, store, akcAdminUserIds: new Set(), entra, sealer, arm, onboardingArm, graph: { avdServicePrincipalId: async () => avdOid } }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const at = new Date().toISOString();
  await store.createOrganisation({ orgId: org, name: 'Contoso', status: 'pending', requestedBy: admin, requesterName: '', requesterEmail: '', requestedAt: at });
  await store.decideOrganisation(org, 'approved', 'akc', at);
  await store.putMemberRoles({ orgId: org, userId: admin, roles: ['admin'], grantedBy: 'akc', grantedAt: at });
  await store.putMemberRoles({ orgId: org, userId: operator, roles: ['operator'], grantedBy: admin, grantedAt: at });
  await store.connectTenant({ orgId: org, tenantId: tenant, tenantName: 'Contoso', connectedBy: admin, consentedByObjectId: 'x', consentedByUsername: 'x', connectedAt: at });
  for (const userId of [admin, operator]) {
    await store.putAccountLink({ orgId: org, userId, tenantId: tenant, objectId: 'oid', username: `${userId}@contoso.com`, mfa: true, sealedRefreshToken: await sealer.seal('rt'), linkedAt: at });
  }
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(resetAzure);

async function call(path: string, body: unknown, sub_ = admin) {
  const token = await sign({ sub: sub_ });
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const request = { subscriptionId: sub, resourceGroup: 'rg-avd', location: 'uksouth', scaling: true };
const statusOf = (body: Record<string, any>) => Object.fromEntries(body.actions.map((a: { id: string; status: string }) => [a.id, a.status]));

describe('onboard subscription', () => {
  it('is for AVD Admins, in a subscription they can see, in an AVD region', async () => {
    assert.equal((await call('/api/onboarding/check', request, operator)).status, 403);
    assert.equal((await call('/api/onboarding/check', { ...request, subscriptionId: 'bbbbbbbb-0000-4000-8000-000000000002' })).body.code, 'subscription-not-found');
    assert.equal((await call('/api/onboarding/check', { ...request, location: 'antarctica' })).body.code, 'invalid-location');
    assert.equal((await call('/api/onboarding/check', { ...request, resourceGroup: 'bad/name' })).body.code, 'invalid-resource-group');
  });

  it('checks without changing anything', async () => {
    const result = await call('/api/onboarding/check', request);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(statusOf(result.body), { providers: 'todo', 'resource-group': 'todo', contributor: 'todo', 'key-vault': 'todo', 'limited-rbac': 'todo', 'power-role': 'todo' });
    assert.equal(result.body.ready, false);
    assert.equal(azure.puts, 0);
    assert.equal(azure.groups.size, 0);
  });

  it('applies the exact grants, scoped to the resource group, and records it once providers finish', async () => {
    let result = await call('/api/onboarding/apply', request);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(statusOf(result.body).providers, 'in-progress');
    assert.equal(azure.groups.get('rg-avd'), 'uksouth');

    const app = azure.assignments.filter((a) => a.principalId === appOid);
    assert.deepEqual(app.map((a) => a.scope), [rgScope, rgScope, rgScope], 'the app gets nothing outside the resource group');
    assert.deepEqual(app.map((a) => a.roleId).sort(), ['4633458b-17de-408a-b874-0445c86b69e6', 'b24988ac-6180-42a0-ab88-20f7382dd24c', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168']);
    assert.equal(app.find((a) => a.roleId === 'f58310d9-a9f6-439a-9e8d-f62e7b41a168')?.condition, assignmentCondition);
    const power = azure.assignments.filter((a) => a.principalId === avdOid);
    assert.deepEqual(power.map((a) => [a.scope, a.roleId]), [[`/subscriptions/${sub}`, '40c5ff49-9181-41f8-ae61-143b0e78555e']]);

    for (const ns of avdProviders) azure.providers.set(ns, 'Registered');
    result = await call('/api/onboarding/apply', request);
    assert.equal(result.body.ready, true);
    assert.equal(azure.assignments.length, 4, 'repeating apply creates no duplicates');
    const list = await call('/api/onboarding', undefined, operator);
    assert.equal(list.body.onboardings.length, 1);
    assert.equal(list.body.onboardings[0].resourceGroup, 'rg-avd');
  });

  it('refuses a resource group that already exists in another region', async () => {
    azure.groups.set('rg-avd', 'westeurope');
    const result = await call('/api/onboarding/apply', request);
    assert.equal(statusOf(result.body)['resource-group'], 'blocked');
    assert.equal(azure.puts, 0);
  });

  it('refuses to work alongside an unrestricted role-assignment right', async () => {
    azure.groups.set('rg-avd', 'uksouth');
    azure.assignments.push({ name: 'manual', scope: rgScope, roleId: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168', condition: '', principalId: appOid });
    const result = await call('/api/onboarding/apply', request);
    assert.equal(statusOf(result.body)['limited-rbac'], 'blocked');
    assert.equal(azure.puts, 0);
  });

  it("explains when the operator isn't an Owner", async () => {
    azure.forbidden = true;
    const result = await call('/api/onboarding/apply', { ...request, scaling: false });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /Owner/);
  });

  it('skips the subscription-wide power role when autoscale is off', async () => {
    await call('/api/onboarding/apply', { ...request, scaling: false });
    assert.equal(azure.assignments.filter((a) => a.principalId === avdOid).length, 0);
  });

  it('allows exactly the roles the workload templates assign', () => {
    // The Bicep is the source of truth: if a template starts assigning another role, onboarding must allow it too.
    const infra = new URL('../../infra/avd/', import.meta.url);
    const files = readdirSync(infra, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.bicep') && !/(^|[\\/])foundation/.test(f));
    const templateRoles = new Set<string>();
    for (const file of files) {
      const text = readFileSync(new URL(file.replace(/\\/g, '/'), infra), 'utf8');
      for (const m of text.matchAll(/(?:roleDefinitions', '|roleId: '|Role = ')([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)) templateRoles.add(m[1]);
    }
    assert.deepEqual([...assignableRoles].sort(), [...templateRoles].sort());
  });
});

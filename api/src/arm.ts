// Read-only Azure Resource Manager calls made with an operator's own delegated token (ADR 0019: discovery runs as the
// operator, so it only ever shows what that person can see).
const armBase = 'https://management.azure.com';

export interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId: string;
}

export interface Region {
  name: string;
  displayName: string;
}

export interface Arm {
  listSubscriptions(token: string): Promise<Subscription[]>;
  listHostPoolRegions(token: string, subscriptionId: string): Promise<Region[]>;
}

export class ArmError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getAll<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${armBase}${path}`;
  while (url) {
    // Only ever send the token to ARM, including when following nextLink.
    if (!url.startsWith(`${armBase}/`)) throw new ArmError(502, 'Azure returned an unexpected next page.');
    const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json().catch(() => null)) as { value?: T[]; nextLink?: string; error?: { message?: string } } | null;
    if (!response.ok) throw new ArmError(response.status, body?.error?.message ?? `Azure returned HTTP ${response.status}.`);
    items.push(...(body?.value ?? []));
    url = body?.nextLink ?? null;
  }
  return items;
}

export const arm: Arm = {
  async listSubscriptions(token) {
    return getAll<Subscription>(token, '/subscriptions?api-version=2022-12-01');
  },

  // Same as Get-AvdHostPoolRegions: where Microsoft.DesktopVirtualization offers host pools.
  async listHostPoolRegions(token, subscriptionId) {
    const sub = encodeURIComponent(subscriptionId);
    const [provider, locations] = await Promise.all([
      fetch(`${armBase}/subscriptions/${sub}/providers/Microsoft.DesktopVirtualization?api-version=2021-04-01`, { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => {
        const body = (await r.json().catch(() => null)) as { resourceTypes?: { resourceType: string; locations: string[] }[]; error?: { message?: string } } | null;
        if (!r.ok) throw new ArmError(r.status, body?.error?.message ?? `Azure returned HTTP ${r.status}.`);
        return body;
      }),
      getAll<Region>(token, `/subscriptions/${sub}/locations?api-version=2022-12-01`),
    ]);
    const hostPools = provider?.resourceTypes?.find((t) => t.resourceType.toLowerCase() === 'hostpools');
    const regions = new Map<string, Region>();
    for (const display of hostPools?.locations ?? []) {
      const compact = display.replace(/\s/g, '').toLowerCase();
      const match = locations.find((l) => l.displayName === display || l.name === compact);
      if (match) regions.set(match.name, { name: match.name, displayName: match.displayName });
    }
    return [...regions.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
};

// Onboard subscription (ADR 0019): the operator's own token, so Azure enforces that they are an Owner.

export interface RoleAssignment {
  name: string;
  scope: string;
  roleId: string;
  condition: string;
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${armBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return { status: response.status, json };
}

function fail(result: { status: number; json: Record<string, unknown> }): never {
  const error = result.json.error as { code?: string; message?: string } | undefined;
  const text = error?.code === 'AuthorizationFailed'
    ? 'Your account is not allowed to do this. Onboarding needs Owner (or User Access Administrator and Contributor) on the subscription.'
    : (error?.message ?? `Azure returned HTTP ${result.status}.`);
  throw new ArmError(result.status, text);
}

export interface OnboardingArm {
  providerState(token: string, subscriptionId: string, namespace: string): Promise<string>;
  registerProvider(token: string, subscriptionId: string, namespace: string): Promise<void>;
  resourceGroupLocation(token: string, subscriptionId: string, name: string): Promise<string | null>;
  createResourceGroup(token: string, subscriptionId: string, name: string, location: string): Promise<void>;
  roleAssignments(token: string, scope: string, principalId: string): Promise<RoleAssignment[]>;
  assignRole(token: string, scope: string, assignment: { name: string; roleId: string; principalId: string; principalType: 'ServicePrincipal'; description: string; condition?: string }): Promise<void>;
}

export const onboardingArm: OnboardingArm = {
  async providerState(token, subscriptionId, namespace) {
    const result = await call(token, 'GET', `/subscriptions/${subscriptionId}/providers/${namespace}?api-version=2021-04-01`);
    if (result.status !== 200) fail(result);
    return String(result.json.registrationState ?? 'NotRegistered');
  },

  async registerProvider(token, subscriptionId, namespace) {
    const result = await call(token, 'POST', `/subscriptions/${subscriptionId}/providers/${namespace}/register?api-version=2021-04-01`);
    if (result.status >= 300) fail(result);
  },

  async resourceGroupLocation(token, subscriptionId, name) {
    const result = await call(token, 'GET', `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(name)}?api-version=2021-04-01`);
    if (result.status === 404) return null;
    if (result.status !== 200) fail(result);
    return String(result.json.location);
  },

  async createResourceGroup(token, subscriptionId, name, location) {
    const result = await call(token, 'PUT', `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(name)}?api-version=2021-04-01`, {
      location,
      tags: { 'managed-by': 'AVD Deploy (Andy Kemp Consulting)' },
    });
    if (result.status >= 300) fail(result);
  },

  async roleAssignments(token, scope, principalId) {
    const filter = encodeURIComponent(`principalId eq '${principalId}'`);
    const result = await call(token, 'GET', `${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${filter}`);
    if (result.status !== 200) fail(result);
    const value = (result.json.value ?? []) as { name: string; properties: { scope: string; roleDefinitionId: string; condition?: string } }[];
    return value
      .filter((a) => a.properties.scope.toLowerCase() === scope.toLowerCase())
      .map((a) => ({ name: a.name, scope: a.properties.scope, roleId: a.properties.roleDefinitionId.split('/').pop()!.toLowerCase(), condition: a.properties.condition ?? '' }));
  },

  async assignRole(token, scope, assignment) {
    const subscription = /^\/subscriptions\/([^/]+)/i.exec(scope)?.[1];
    const result = await call(token, 'PUT', `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignment.name}?api-version=2022-04-01`, {
      properties: {
        roleDefinitionId: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${assignment.roleId}`,
        principalId: assignment.principalId,
        principalType: assignment.principalType,
        description: assignment.description,
        ...(assignment.condition ? { condition: assignment.condition, conditionVersion: '2.0' } : {}),
      },
    });
    // A new service principal can take a moment to replicate; the caller retries on the next check.
    if (result.status >= 300) fail(result);
  },
};

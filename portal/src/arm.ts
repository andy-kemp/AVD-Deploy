// Browser-direct Azure Resource Manager calls with the operator's delegated token (ADR 0017). Read-only.
const armBase = 'https://management.azure.com';

export class ArmError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function armFetch(token: string, url: string): Promise<Response> {
  // Only ever send the token to ARM, including when following nextLink.
  if (!url.startsWith(`${armBase}/`)) throw new Error('Refusing to call a non-ARM URL.');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ArmError(body?.error?.message ?? `ARM request failed with HTTP ${response.status}.`, response.status);
  }
  return response;
}

async function armGetAll<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${armBase}${path}`;
  while (url) {
    const page: { value: T[]; nextLink?: string } = await (await armFetch(token, url)).json();
    items.push(...page.value);
    url = page.nextLink ?? null;
  }
  return items;
}

export interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId: string;
}

export async function listSubscriptions(token: string): Promise<Subscription[]> {
  const subscriptions = await armGetAll<Subscription>(token, '/subscriptions?api-version=2022-12-01');
  return subscriptions.filter((s) => s.state === 'Enabled').sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface Region {
  name: string;
  displayName: string;
}

// Same as Get-AvdHostPoolRegions: regions where Microsoft.DesktopVirtualization offers host pools.
export async function listHostPoolRegions(token: string, subscriptionId: string): Promise<Region[]> {
  const sub = encodeURIComponent(subscriptionId);
  const [provider, locations] = await Promise.all([
    armFetch(token, `${armBase}/subscriptions/${sub}/providers/Microsoft.DesktopVirtualization?api-version=2021-04-01`).then((r) => r.json()),
    armGetAll<Region>(token, `/subscriptions/${sub}/locations?api-version=2022-12-01`),
  ]);
  const hostPools = (provider.resourceTypes as { resourceType: string; locations: string[] }[]).find((t) => t.resourceType.toLowerCase() === 'hostpools');
  const regions = new Map<string, Region>();
  for (const display of hostPools?.locations ?? []) {
    const compact = display.replace(/\s/g, '').toLowerCase();
    const match = locations.find((l) => l.displayName === display || l.name === compact);
    if (match) regions.set(match.name, { name: match.name, displayName: match.displayName });
  }
  return [...regions.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getResourceGroupLocation(token: string, subscriptionId: string, name: string): Promise<string | null> {
  try {
    const response = await armFetch(token, `${armBase}/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(name)}?api-version=2021-04-01`);
    return (await response.json()).location as string;
  } catch (e) {
    if (e instanceof ArmError && e.status === 404) return null;
    throw e;
  }
}

export interface VirtualNetwork {
  name: string;
  resourceGroup: string;
  location: string;
  addressPrefixes: string[];
  subnets: string[];
}

export async function listVirtualNetworks(token: string, subscriptionId: string): Promise<VirtualNetwork[]> {
  type Raw = { id: string; name: string; location: string; properties: { addressSpace?: { addressPrefixes?: string[] }; subnets?: { name: string }[] } };
  const raw = await armGetAll<Raw>(token, `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Network/virtualNetworks?api-version=2024-05-01`);
  return raw.map((v) => ({
    name: v.name,
    resourceGroup: v.id.split('/')[4] ?? '',
    location: v.location,
    addressPrefixes: v.properties.addressSpace?.addressPrefixes ?? [],
    subnets: (v.properties.subnets ?? []).map((s) => s.name),
  }));
}

export interface ComputeSku {
  resourceType: string;
  name: string;
  family?: string;
  capabilities?: { name: string; value: string }[];
  restrictions?: { type: string; reasonCode?: string }[];
}

export interface Usage {
  name: { value: string };
  currentValue: number;
  limit: number;
}

export async function getComputeCapacityData(token: string, subscriptionId: string, location: string): Promise<{ skus: ComputeSku[]; usages: Usage[] }> {
  const sub = encodeURIComponent(subscriptionId);
  const loc = encodeURIComponent(location);
  const filter = encodeURIComponent(`location eq '${location}'`);
  const [skus, usages] = await Promise.all([
    armGetAll<ComputeSku>(token, `/subscriptions/${sub}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=${filter}`),
    armGetAll<Usage>(token, `/subscriptions/${sub}/providers/Microsoft.Compute/locations/${loc}/usages?api-version=2023-07-01`),
  ]);
  return { skus: skus.filter((s) => s.resourceType === 'virtualMachines'), usages };
}

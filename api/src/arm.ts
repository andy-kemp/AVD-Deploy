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

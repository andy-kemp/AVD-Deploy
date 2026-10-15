// Browser-direct Azure Resource Manager calls with the operator's delegated token (ADR 0017).
const armBase = 'https://management.azure.com';

export interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId: string;
}

async function armGetAll<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${armBase}${path}`;
  while (url) {
    // Only follow nextLink back to ARM, so the token is never sent anywhere else.
    if (!url.startsWith(`${armBase}/`)) throw new Error('ARM returned an unexpected nextLink.');
    const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error?.message ?? `ARM request failed with HTTP ${response.status}.`);
    }
    const page: { value: T[]; nextLink?: string } = await response.json();
    items.push(...page.value);
    url = page.nextLink ?? null;
  }
  return items;
}

export async function listSubscriptions(token: string): Promise<Subscription[]> {
  const subscriptions = await armGetAll<Subscription>(token, '/subscriptions?api-version=2022-12-01');
  return subscriptions.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

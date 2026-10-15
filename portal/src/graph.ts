// Delegated Microsoft Graph reads for the group picker (GroupMember.Read.All, permission matrix "Discovery: existing groups").
const graphBase = 'https://graph.microsoft.com/v1.0';
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Group {
  id: string;
  displayName: string;
}

async function graphGet<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${graphBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Graph request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function searchGroups(token: string, search: string): Promise<Group[]> {
  const term = search.trim();
  if (guid.test(term)) {
    try {
      return [await graphGet<Group>(token, `/groups/${term}?$select=id,displayName`)];
    } catch {
      return [];
    }
  }
  const filter = term ? `&$filter=${encodeURIComponent(`startswith(displayName,'${term.replace(/'/g, "''")}')`)}` : '';
  const page = await graphGet<{ value: Group[] }>(token, `/groups?$select=id,displayName&$top=25${filter}`);
  return page.value.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

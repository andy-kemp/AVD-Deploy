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

// Same as Select-EntraGroup in avd.ps1: reuse a group with this exact name, otherwise create a security group owned by
// the operator. Needs Group.ReadWrite.All (delegated), so it only runs as the signed-in operator, never the worker.
export async function ensureSecurityGroup(token: string, name: string, role: string, ownerId: string, addOwnerAsMember: boolean): Promise<Group> {
  const filter = encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`);
  const existing = await graphGet<{ value: Group[] }>(token, `/groups?$select=id,displayName&$filter=${filter}`);
  if (existing.value.length) return existing.value[0];
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
  const owner = `${graphBase}/users/${ownerId}`;
  const response = await fetch(`${graphBase}/groups`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: name,
      mailEnabled: false,
      mailNickname: `${name.replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 50)}-${suffix}`,
      securityEnabled: true,
      description: `Azure Virtual Desktop ${role} group created by the AVD Deploy portal`,
      'owners@odata.bind': [owner],
      ...(addOwnerAsMember ? { 'members@odata.bind': [owner] } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`Creating group '${name}' failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
  }
  const group = await response.json();
  return { id: group.id, displayName: group.displayName };
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

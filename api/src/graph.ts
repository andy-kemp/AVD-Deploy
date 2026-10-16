// Read-only Microsoft Graph calls with an operator's delegated token (Connect tenant's consented read scopes).
export const avdAppId = '9cdead84-a844-4324-93f2-b2e6bb768d07';

export interface Graph {
  /** Object ID of the Azure Virtual Desktop service principal in the tenant, or null if it isn't there yet. */
  avdServicePrincipalId(token: string): Promise<string | null>;
}

export const graph: Graph = {
  async avdServicePrincipalId(token) {
    const response = await fetch(`https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${avdAppId}'&$select=id`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Graph returned HTTP ${response.status} looking up the Azure Virtual Desktop service.`);
    return ((await response.json()) as { value?: { id: string }[] }).value?.[0]?.id ?? null;
  },
};

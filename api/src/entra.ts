// Microsoft Entra calls for Connect tenant (ADR 0018). The API is a confidential client of the multi-tenant
// "AKC AVD Deploy" app. Its credential is its own managed identity, configured as a federated identity credential on
// the app (ADR 0019), so there is no client secret.
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ManagedIdentityCredential } from '@azure/identity';

const login = 'https://login.microsoftonline.com';

// Directory roles that can grant tenant-wide consent to delegated permissions.
export const consentAdminRoles: Record<string, string> = {
  '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
  '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
};

export interface VerifiedSignIn {
  tenantId: string;
  objectId: string;
  username: string;
  /** Directory role template IDs (the wids claim; the app sets groupMembershipClaims to DirectoryRole). */
  roles: string[];
  tenantName: string;
}

export interface Entra {
  adminConsentUrl(state: string): string;
  verifySignInUrl(tenantId: string, state: string, nonce: string, codeChallenge: string): string;
  /** Redeems the proof sign-in and returns its verified claims and the tenant's display name. */
  redeemSignIn(tenantId: string, code: string, codeVerifier: string, nonce: string): Promise<VerifiedSignIn>;
  /** True when the app has a service principal in the tenant, i.e. it was consented to there. */
  appIsConsented(tenantId: string): Promise<boolean>;
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const codeChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class EntraError extends Error {}

export function createEntra(options: { clientId: string; portalOrigin: string; managedIdentityClientId?: string; getKey?: (tenantId: string) => JWTVerifyGetKey }): Entra {
  const consentRedirect = `${options.portalOrigin}/connect/callback`;
  const verifyRedirect = `${options.portalOrigin}/connect/verify`;
  const signInScopes = 'openid profile https://graph.microsoft.com/User.Read';
  const keys = new Map<string, JWTVerifyGetKey>();
  const getKey = options.getKey ?? ((tenantId: string) => {
    if (!keys.has(tenantId)) keys.set(tenantId, createRemoteJWKSet(new URL(`${login}/${tenantId}/discovery/v2.0/keys`)));
    return keys.get(tenantId)!;
  });
  const identity = new ManagedIdentityCredential(options.managedIdentityClientId ? { clientId: options.managedIdentityClientId } : {});

  async function clientAssertion(): Promise<string> {
    const token = await identity.getToken('api://AzureADTokenExchange/.default');
    if (!token) throw new EntraError('The API could not get its managed identity token.');
    return token.token;
  }

  async function tokenRequest(tenantId: string, body: Record<string, string>) {
    const response = await fetch(`${login}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await clientAssertion(),
        ...body,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, string>;
    return { ok: response.ok, data };
  }

  return {
    adminConsentUrl(state) {
      // /.default asks for every permission configured on the app registration.
      const query = new URLSearchParams({ client_id: options.clientId, scope: 'https://graph.microsoft.com/.default', redirect_uri: consentRedirect, state });
      return `${login}/organizations/v2.0/adminconsent?${query}`;
    },

    verifySignInUrl(tenantId, state, nonce, challenge) {
      const query = new URLSearchParams({
        client_id: options.clientId,
        response_type: 'code',
        response_mode: 'query',
        redirect_uri: verifyRedirect,
        scope: signInScopes,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${login}/${tenantId}/oauth2/v2.0/authorize?${query}`;
    },

    async redeemSignIn(tenantId, code, codeVerifier, nonce) {
      const { ok, data } = await tokenRequest(tenantId, { grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: verifyRedirect, scope: signInScopes });
      if (!ok || !data.id_token) throw new EntraError(data.error_description?.split('\r\n')[0] ?? 'Microsoft did not complete the sign-in.');
      const { payload } = await jwtVerify(data.id_token, getKey(tenantId), {
        issuer: `${login}/${tenantId}/v2.0`,
        audience: options.clientId,
        algorithms: ['RS256'],
        clockTolerance: 60,
      });
      if (payload.nonce !== nonce) throw new EntraError('The sign-in response did not match this request.');
      let tenantName = '';
      if (data.access_token) {
        const org = await fetch('https://graph.microsoft.com/v1.0/organization?$select=displayName', { headers: { Authorization: `Bearer ${data.access_token}` } });
        if (org.ok) tenantName = String(((await org.json()) as { value?: { displayName?: string }[] }).value?.[0]?.displayName ?? '');
      }
      return {
        tenantId: String(payload.tid ?? ''),
        objectId: String(payload.oid ?? ''),
        username: String(payload.preferred_username ?? payload.email ?? ''),
        roles: Array.isArray(payload.wids) ? payload.wids.map(String) : [],
        tenantName,
      };
    },

    async appIsConsented(tenantId) {
      const { ok } = await tokenRequest(tenantId, { grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' });
      return ok;
    },
  };
}

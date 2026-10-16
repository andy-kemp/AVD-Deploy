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

export interface LinkedSignIn {
  tenantId: string;
  objectId: string;
  username: string;
  /** True when the sign-in used multi-factor authentication (amr contains mfa). */
  mfa: boolean;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

export interface ArmToken {
  accessToken: string;
  expiresAt: number;
  /** Microsoft may rotate the refresh token; store it when present. */
  refreshToken?: string;
}

/** Microsoft refused to refresh: expired, revoked, password changed, or Conditional Access needs a new sign-in. */
export class RelinkNeededError extends Error {}

export interface Entra {
  /** Operator account link: a delegated sign-in for Azure Resource Manager with a refresh token. */
  linkSignInUrl(tenantId: string, state: string, nonce: string, codeChallenge: string): string;
  redeemLink(tenantId: string, code: string, codeVerifier: string, nonce: string): Promise<LinkedSignIn>;
  armToken(tenantId: string, refreshToken: string): Promise<ArmToken>;
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
  const linkRedirect = `${options.portalOrigin}/link/callback`;
  const signInScopes = 'openid profile https://graph.microsoft.com/User.Read';
  const armScopes = 'openid profile offline_access https://management.azure.com/user_impersonation';
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

  function authorizeUrl(tenantId: string, redirectUri: string, scope: string, state: string, nonce: string, challenge: string, prompt: string) {
    const query = new URLSearchParams({
      client_id: options.clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: redirectUri,
      scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt,
    });
    return `${login}/${tenantId}/oauth2/v2.0/authorize?${query}`;
  }

  async function verifyIdToken(tenantId: string, idToken: string, nonce: string) {
    const { payload } = await jwtVerify(idToken, getKey(tenantId), {
      issuer: `${login}/${tenantId}/v2.0`,
      audience: options.clientId,
      algorithms: ['RS256'],
      clockTolerance: 60,
    });
    if (payload.nonce !== nonce) throw new EntraError('The sign-in response did not match this request.');
    return payload;
  }

  const firstLine = (text: string | undefined, fallback: string) => text?.split(/\r?\n/)[0] ?? fallback;

  return {
    linkSignInUrl(tenantId, state, nonce, challenge) {
      return authorizeUrl(tenantId, linkRedirect, armScopes, state, nonce, challenge, 'select_account');
    },

    async redeemLink(tenantId, code, codeVerifier, nonce) {
      const { ok, data } = await tokenRequest(tenantId, { grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: linkRedirect, scope: armScopes });
      if (!ok || !data.id_token || !data.refresh_token || !data.access_token) throw new EntraError(firstLine(data.error_description, 'Microsoft did not complete the sign-in.'));
      const payload = await verifyIdToken(tenantId, data.id_token, nonce);
      // amr is in the access token, not the ID token; read it without re-verifying (Microsoft just issued it to us over TLS).
      const accessClaims = JSON.parse(Buffer.from(data.access_token.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}') as { amr?: string[] };
      return {
        tenantId: String(payload.tid ?? ''),
        objectId: String(payload.oid ?? ''),
        username: String(payload.preferred_username ?? payload.email ?? ''),
        mfa: Array.isArray(accessClaims.amr) && accessClaims.amr.includes('mfa'),
        refreshToken: data.refresh_token,
        accessToken: data.access_token,
        expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
      };
    },

    async armToken(tenantId, refreshToken) {
      const { ok, data } = await tokenRequest(tenantId, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'offline_access https://management.azure.com/user_impersonation' });
      if (!ok || !data.access_token) {
        if (['invalid_grant', 'interaction_required', 'consent_required'].includes(data.error)) throw new RelinkNeededError(firstLine(data.error_description, 'Sign in again.'));
        throw new EntraError(firstLine(data.error_description, 'Microsoft did not issue an Azure token.'));
      }
      return { accessToken: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000, ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}) };
    },

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

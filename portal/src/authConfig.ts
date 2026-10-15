import type { Configuration } from '@azure/msal-browser';

const tenantId = import.meta.env.VITE_AVD_TENANT_ID as string | undefined;
const clientId = import.meta.env.VITE_AVD_CLIENT_ID as string | undefined;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single-tenant only (ADR 0002): the authority is always an explicit tenant ID, never common or organizations.
export const configError =
  !tenantId || !guid.test(tenantId) || !clientId || !guid.test(clientId)
    ? 'Set VITE_AVD_TENANT_ID and VITE_AVD_CLIENT_ID in portal/.env.local (see portal/README.md).'
    : null;

export const msalConfig: Configuration = {
  auth: {
    clientId: clientId ?? '',
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: `${window.location.origin}/redirect.html`,
    postLogoutRedirectUri: `${window.location.origin}/redirect.html`,
  },
  cache: { cacheLocation: 'sessionStorage' },
};

export const armScope = 'https://management.azure.com/user_impersonation';
export const loginRequest = { scopes: ['User.Read', armScope] };

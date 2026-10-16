// Calls to the AVD Deploy API with the signed-in user's Clerk session token. Same origin: /api is linked to the
// Static Web App when hosted, and proxied by Vite locally.
import { useAuth } from '@clerk/react';
import { useCallback } from 'react';

export type OrganisationStatus = 'pending' | 'approved' | 'declined' | 'suspended';

export interface AvdOrganisation {
  id: string;
  name: string;
  status: OrganisationStatus;
  requestedAt: string;
  decidedAt: string | null;
  roles: string[];
  permissions: string[];
  tenant: TenantConnection | null;
  /** False until the AKC AVD Deploy Entra app is configured on the API. */
  connectAvailable: boolean;
}

export interface TenantConnection {
  tenantId: string;
  name: string;
  connectedAt: string;
  consentedBy: string;
}

export interface Me {
  userId: string;
  isAkcAdmin: boolean;
  organisation: null | { id: string; clerkRole: string | null; canRequest: boolean; avd: AvdOrganisation | null };
}

export interface OrganisationRequest {
  id: string;
  name: string;
  status: OrganisationStatus;
  requestedAt: string;
  decidedAt: string | null;
  requestedBy: string;
  requesterName: string;
  requesterEmail: string;
  decidedBy: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T,>(method: 'GET' | 'POST', path: string, body?: unknown, options: { freshToken?: boolean } = {}): Promise<T> => {
      // A fresh token after switching organisation, so the API sees the new active organisation.
      const token = await getToken(options.freshToken ? { skipCache: true } : undefined);
      if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in first.');
      const response = await fetch(`/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, data?.code ?? 'error', data?.error ?? `The request failed (HTTP ${response.status}).`);
      return data as T;
    },
    [getToken],
  );
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

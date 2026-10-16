// Clerk session token verification (ADR 0018). The Clerk instance is shared with other andykemp.com apps, so a valid
// signature is not enough: the token must have been issued for this portal's origin (azp).
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Principal {
  userId: string;
  sessionId: string;
  /** Active Clerk organisation, if any. */
  orgId?: string;
  /** The user's Clerk role in that organisation without the org: prefix, e.g. 'admin'. Grants no AVD permission. */
  orgRole?: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ClerkClaims {
  sub?: string;
  sid?: string;
  azp?: string;
  sts?: string;
  o?: { id?: string; rol?: string };
  org_id?: string;
  org_role?: string;
}

export type Verifier = (authorization: string | undefined) => Promise<Principal>;

export function createVerifier(options: { issuer: string; authorizedParties: string[]; getKey: JWTVerifyGetKey }): Verifier {
  const parties = new Set(options.authorizedParties);
  return async (authorization) => {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '')?.[1];
    if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    let claims: ClerkClaims;
    try {
      ({ payload: claims } = await jwtVerify<ClerkClaims>(token, options.getKey, {
        issuer: options.issuer,
        algorithms: ['RS256'],
        clockTolerance: 5,
        requiredClaims: ['sub', 'sid', 'exp', 'nbf', 'iat'],
      }));
    } catch (e) {
      const expired = e instanceof errors.JWTExpired;
      throw new HttpError(401, expired ? 'token-expired' : 'invalid-token', expired ? 'Your session expired; sign in again.' : 'The session token is not valid.');
    }
    // A token minted for another andykemp.com app (or without azp) is never accepted here.
    if (!claims.azp || !parties.has(claims.azp)) throw new HttpError(401, 'wrong-audience', 'This session was not issued for AVD Deploy.');
    // Sessions with outstanding tasks (for example a required organisation choice) are not active yet.
    if (claims.sts !== undefined && claims.sts !== 'active') throw new HttpError(401, 'session-not-active', 'Finish signing in first.');
    const orgId = claims.o?.id ?? claims.org_id;
    const orgRole = claims.o?.rol ?? claims.org_role?.replace(/^org:/, '');
    return { userId: claims.sub!, sessionId: claims.sid!, ...(orgId ? { orgId, orgRole } : {}) };
  };
}

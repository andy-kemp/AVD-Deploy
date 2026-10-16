// Settings from the environment. Nothing here is secret: the Clerk publishable key and storage account name are public,
// and the API reaches storage with its managed identity.

export interface Config {
  port: number;
  /** Clerk Frontend API origin, the token issuer, e.g. https://clerk.andykemp.com. */
  issuer: string;
  jwksUrl: string;
  /** Origins whose Clerk tokens this API accepts (the token's azp claim). */
  authorizedParties: string[];
  /** Clerk user IDs that may approve or decline organisations (AKC staff). */
  akcAdminUserIds: Set<string>;
  storage: { kind: 'memory' } | { kind: 'table'; accountName: string } | { kind: 'connection-string'; connectionString: string };
}

/** A publishable key is pk_test_ or pk_live_ followed by base64("<frontend api host>$"). */
export function issuerFromPublishableKey(key: string): string {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(key.trim());
  if (!match) throw new Error('CLERK_PUBLISHABLE_KEY is not a Clerk publishable key.');
  const host = Buffer.from(match[2], 'base64').toString('utf8').replace(/\$$/, '');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('CLERK_PUBLISHABLE_KEY does not contain a Frontend API host.');
  return `https://${host}`;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuer = issuerFromPublishableKey(env.CLERK_PUBLISHABLE_KEY ?? '');
  const authorizedParties = list(env.AUTHORIZED_PARTIES);
  if (!authorizedParties.length) throw new Error('AUTHORIZED_PARTIES must list the portal origins, e.g. https://avd-deploy.andykemp.com.');
  for (const origin of authorizedParties) {
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) throw new Error(`AUTHORIZED_PARTIES entry '${origin}' is not an origin.`);
  }
  const storage: Config['storage'] = env.STORAGE_CONNECTION_STRING
    ? { kind: 'connection-string', connectionString: env.STORAGE_CONNECTION_STRING }
    : env.STORAGE_ACCOUNT_NAME
      ? { kind: 'table', accountName: env.STORAGE_ACCOUNT_NAME }
      : { kind: 'memory' };
  return {
    port: Number(env.PORT ?? 7071),
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    authorizedParties,
    akcAdminUserIds: new Set(list(env.AKC_ADMIN_USER_IDS)),
    storage,
  };
}

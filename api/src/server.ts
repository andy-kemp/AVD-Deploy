import { createServer } from 'node:http';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { createEntra } from './entra.ts';
import { loadConfig } from './config.ts';
import { MemoryStore, TableStore, type Store } from './store.ts';

const config = loadConfig();
const store: Store = config.storage.kind === 'memory' ? new MemoryStore() : await TableStore.create(config.storage);
const verify = createVerifier({ issuer: config.issuer, authorizedParties: config.authorizedParties, getKey: createRemoteJWKSet(new URL(config.jwksUrl)) });

const entra = config.entraClientId
  ? createEntra({ clientId: config.entraClientId, portalOrigin: config.portalOrigin, managedIdentityClientId: config.managedIdentityClientId || undefined })
  : undefined;

createServer(createApp({ verify, store, akcAdminUserIds: config.akcAdminUserIds, entra })).listen(config.port, () => {
  console.log(`AVD Deploy API on port ${config.port}: issuer ${config.issuer}, parties ${config.authorizedParties.join(', ')}, storage ${config.storage.kind}${config.storage.kind === 'memory' ? ' (data is lost on restart)' : ''}.`);
  if (!config.akcAdminUserIds.size) console.warn('AKC_ADMIN_USER_IDS is empty: nobody can approve organisations.');
  if (!entra) console.warn('ENTRA_CLIENT_ID is not set: Connect tenant is unavailable.');
});

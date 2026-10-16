import { createServer } from 'node:http';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { ManagedIdentityCredential } from '@azure/identity';
import { createEntra } from './entra.ts';
import { KeyVaultSealer, MemorySealer } from './sealer.ts';
import { loadConfig } from './config.ts';
import { MemoryStore, TableStore, type Store } from './store.ts';

const config = loadConfig();
const store: Store = config.storage.kind === 'memory' ? new MemoryStore() : await TableStore.create(config.storage);
const verify = createVerifier({ issuer: config.issuer, authorizedParties: config.authorizedParties, getKey: createRemoteJWKSet(new URL(config.jwksUrl)) });

const entra = config.entraClientId
  ? createEntra({ clientId: config.entraClientId, portalOrigin: config.portalOrigin, managedIdentityClientId: config.managedIdentityClientId || undefined })
  : undefined;

const sealer = config.keyVaultKeyId
  ? new KeyVaultSealer(config.keyVaultKeyId, new ManagedIdentityCredential(config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : {}))
  : new MemorySealer();

createServer(createApp({ verify, store, akcAdminUserIds: config.akcAdminUserIds, entra, sealer })).listen(config.port, () => {
  console.log(`AVD Deploy API on port ${config.port}: issuer ${config.issuer}, parties ${config.authorizedParties.join(', ')}, storage ${config.storage.kind}${config.storage.kind === 'memory' ? ' (data is lost on restart)' : ''}.`);
  if (!config.akcAdminUserIds.size) console.warn('AKC_ADMIN_USER_IDS is empty: nobody can approve organisations.');
  if (!entra) console.warn('ENTRA_CLIENT_ID is not set: Connect tenant is unavailable.');
  if (!config.keyVaultKeyId) console.warn('KEY_VAULT_KEY_ID is not set: linked accounts are sealed with an in-memory key and lost on restart.');
});

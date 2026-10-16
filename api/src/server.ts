import { createServer } from 'node:http';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { MemoryStore, TableStore, type Store } from './store.ts';

const config = loadConfig();
const store: Store = config.storage.kind === 'memory' ? new MemoryStore() : await TableStore.create(config.storage);
const verify = createVerifier({ issuer: config.issuer, authorizedParties: config.authorizedParties, getKey: createRemoteJWKSet(new URL(config.jwksUrl)) });

createServer(createApp({ verify, store, akcAdminUserIds: config.akcAdminUserIds })).listen(config.port, () => {
  console.log(`AVD Deploy API on port ${config.port}: issuer ${config.issuer}, parties ${config.authorizedParties.join(', ')}, storage ${config.storage.kind}${config.storage.kind === 'memory' ? ' (data is lost on restart)' : ''}.`);
  if (!config.akcAdminUserIds.size) console.warn('AKC_ADMIN_USER_IDS is empty: nobody can approve organisations.');
});

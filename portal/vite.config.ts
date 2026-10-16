import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Writes dist/staticwebapp.config.json with the worker's storage account as the only extra connect-src origin.
function staticWebAppConfig(storageAccount: string): Plugin {
  return {
    name: 'staticwebapp-config',
    apply: 'build',
    closeBundle() {
      if (storageAccount && !/^[a-z0-9]{3,24}$/.test(storageAccount)) throw new Error('VITE_AVD_WORKER_STORAGE is not a storage account name.');
      const template = readFileSync(resolve(import.meta.dirname, 'staticwebapp.config.template.json'), 'utf8');
      const origin = storageAccount ? `https://${storageAccount}.blob.core.windows.net` : '';
      writeFileSync(resolve(import.meta.dirname, 'dist/staticwebapp.config.json'), template.replace(' __WORKER_STORAGE_ORIGIN__', origin ? ` ${origin}` : ''));
    },
  };
}

// Two entries: the app, and the MSAL v5 redirect bridge that the app registration's redirect URI points at.
export default defineConfig(({ mode }) => ({
  plugins: [react(), staticWebAppConfig(loadEnv(mode, import.meta.dirname).VITE_AVD_WORKER_STORAGE ?? '')],
  // The sizing profiles are shared with avd.ps1 from ../contracts.
  server: { port: 5173, strictPort: true, fs: { allow: ['.', '../contracts'] } },
  preview: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        redirect: resolve(import.meta.dirname, 'redirect.html'),
      },
    },
  },
}));

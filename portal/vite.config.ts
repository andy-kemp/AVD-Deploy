import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two entries: the app, and the MSAL v5 redirect bridge that the app registration's redirect URI points at.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        redirect: resolve(import.meta.dirname, 'redirect.html'),
      },
    },
  },
});

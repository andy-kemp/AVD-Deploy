import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Locally the API runs on 7071 (api/: npm run dev); /api is same-origin, as it is behind the Static Web App.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, strictPort: true, proxy: { '/api': 'http://localhost:7071' } },
  preview: { port: 3000, strictPort: true },
});

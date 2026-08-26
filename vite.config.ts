import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.PORT) || 4322;
// localhost on the host, but the service name when this runs in the compose
// stack — there localhost is the Vite container, not the API's.
const API_TARGET = `http://${process.env.API_HOST || 'localhost'}:${API_PORT}`;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT) || 5177,
    host: true,
    // Vite 5.4.12+ 403s any Host header it does not recognise; the suffix
    // form covers every node on the tailnet and survives a machine rename.
    allowedHosts: ['.ts.net'],
    // One prefix, on purpose: every server route lives under /api, and
    // test/vite-proxy.test.ts asserts controllers never leave it. A route
    // outside /api would not 404 in dev — Vite's SPA fallback would answer it
    // with index.html.
    proxy: {
      '/api': { target: API_TARGET }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});

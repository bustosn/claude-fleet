import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Dev: Vite serves the app and proxies /api to the Node server. Prod: `vite build` writes dist/web, which the server serves.
const apiPort = process.env.FLEET_PORT || '7778';

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: path.resolve(__dirname, '../dist/web'), emptyOutDir: true },
  server: {
    port: Number(process.env.FLEET_WEB_PORT || 5178),
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, ws: true } },
  },
});

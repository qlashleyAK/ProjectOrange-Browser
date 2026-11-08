import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const server = process.env.ORANGE_SERVER ?? 'http://localhost:2567';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        viewer: resolve(import.meta.dirname, 'ship-viewer.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
      '/quickplay': server,
      '/ping': server,
      '/api': server,
    },
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Point the dev client at `wrangler dev` so the app runs from one origin.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});

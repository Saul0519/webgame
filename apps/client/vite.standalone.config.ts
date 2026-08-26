import { defineConfig } from 'vite';

/**
 * Build for a single self-contained HTML file: one JS chunk, no code splitting,
 * and online play compiled out. Used for the hosted demo, where the page has no
 * server to talk to.
 */
export default defineConfig({
  define: {
    'import.meta.env.VITE_OFFLINE_ONLY': JSON.stringify('1'),
  },
  build: {
    target: 'es2022',
    outDir: 'dist-standalone',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});

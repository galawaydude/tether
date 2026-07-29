import { defineConfig } from 'vite';

/**
 * No plugin: esbuild reads `jsx`/`jsxImportSource` from `tsconfig.json`, which is
 * the whole of what Preact needs. The proxy is for `npm run dev -w @tether/web`
 * against a `tether serve` on the default port — `ws: true` because the terminal
 * and conversation channels are upgrades on the same prefix.
 */
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
  },
});

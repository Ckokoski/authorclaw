import { defineConfig } from 'vitest/config';

// AuthorAgent runs on tsx (ESM, NodeNext module resolution, Node 22+).
// Vitest's default esbuild-based transform already understands TS + ESM
// without any extra config, so this stays intentionally minimal — just
// pointed at the right environment and test locations.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['gateway/src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'workspace'],
    globals: false,
    // Source files use NodeNext-style relative imports with explicit `.js`
    // extensions (e.g. `from '../security/vault.js'`) even though the files
    // are `.ts` — this is standard NodeNext/tsx convention and vitest/esbuild
    // resolve it correctly without extra config.
    restoreMocks: true,
    testTimeout: 15000,
  },
});

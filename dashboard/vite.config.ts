import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Root is this directory (dashboard/), independent of where the CLI is
// invoked from, so `npm run build:ui` works the same from anywhere.
const dashboardRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: dashboardRoot,
  esbuild: {
    // Preact's automatic JSX runtime — no @preact/preset-vite needed since
    // this code never imports React-flavored libraries that need aliasing.
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: 'dist',
    // dist/index.html is the legacy hand-authored SPA shell, not a Vite
    // build artifact — never let Vite clear the output dir before writing.
    emptyOutDir: false,
    lib: {
      entry: 'src/main.tsx',
      name: 'AuthorAgentReview',
      formats: ['iife'],
      fileName: () => 'review.js',
    },
  },
});

/**
 * Install root resolution + .env loading, shared by gateway/src/index.ts and
 * the `book` CLI (gateway/src/cli/book.ts). Extracted from index.ts so both
 * entry points resolve ROOT_DIR and load .env identically — a second copy of
 * this logic that drifted would silently reintroduce the exact bug this file
 * originally fixed (.env resolving relative to cwd instead of the install
 * directory; see git history on index.ts around AUTHORCLAW_WORKSPACE_DIR).
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Resolve ROOT_DIR from a caller's `import.meta.url`. `upsFromSrc` is how many
 * directories separate the caller from ROOT_DIR when running from source
 * (e.g. 2 for `gateway/src/index.ts`, 3 for `gateway/src/cli/book.ts`); a
 * `dist/` build output adds exactly one more level of nesting on top of that.
 */
export function resolveInstallRootDir(callerImportMetaUrl: string, upsFromSrc: number): string {
  const callerDir = dirname(fileURLToPath(callerImportMetaUrl));
  const ups = callerDir.includes('dist') ? upsFromSrc + 1 : upsFromSrc;
  return join(callerDir, ...Array(ups).fill('..'));
}

/**
 * Load `<rootDir>/.env`. A missing file is a normal, silent no-op for
 * installs that don't use one; any other load error is worth a visible
 * warning since a swallowed load failure means every env override silently
 * reverts to its default (this bit AUTHORCLAW_WORKSPACE_DIR once already).
 */
export function loadInstallDotenv(rootDir: string): void {
  const result = loadDotenv({ path: join(rootDir, '.env') });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn(`[startup] .env failed to load from ${join(rootDir, '.env')}: ${result.error.message}`);
  }
}

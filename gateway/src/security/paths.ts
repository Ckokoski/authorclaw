/**
 * AuthorAgent Path Safety
 *
 * Single source of truth for filesystem path safety. All user-supplied strings
 * that become filesystem paths MUST route through these pure functions.
 *
 * Consolidates three former duplicate implementations:
 *  - SandboxGuard.validatePath / sanitizeFilename (security/sandbox.ts)
 *  - safePath() (api/routes.ts)
 *  - MemoryService.sanitizeSegment (services/memory.ts)
 */

import { resolve, sep } from 'path';

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Normalize a resolved absolute path for prefix comparison.
 *
 * Filesystems on Windows (and macOS by default) are case-insensitive, and
 * inputs may arrive with mixed `/` and `\` separators. We lower-case on those
 * platforms and unify separators so an attacker can't dodge the boundary check
 * with `WORKSPACE\..\..\Etc` casing or slash tricks.
 */
function normalizeForCompare(p: string): string {
  const unified = p.split(/[\\/]/).join(sep);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? unified.toLowerCase()
    : unified;
}

/**
 * Resolve one or more path segments against a base directory and verify the
 * result stays inside that base. Throws on any escape.
 *
 * This is the ONLY approved way to turn user-supplied path input into an
 * absolute filesystem path. Returns the resolved absolute path (original
 * casing / separators preserved for actual fs use).
 *
 * @throws Error('Path escapes base directory') if the result is outside base.
 */
export function resolveWithin(baseDir: string, ...segments: string[]): string {
  const base = resolve(baseDir);
  // Reject null bytes outright — they can truncate paths in native fs calls.
  for (const seg of segments) {
    if (typeof seg !== 'string') {
      throw new Error('Path segment must be a string');
    }
    if (seg.includes('\x00')) {
      throw new Error('Path contains null byte');
    }
  }

  const resolved = resolve(base, ...segments);

  const baseCmp = normalizeForCompare(base);
  const resolvedCmp = normalizeForCompare(resolved);
  const baseWithSep = baseCmp.endsWith(sep) ? baseCmp : baseCmp + sep;

  if (resolvedCmp !== baseCmp && !resolvedCmp.startsWith(baseWithSep)) {
    throw new Error('Path escapes base directory');
  }

  return resolved;
}

/**
 * Non-throwing variant of resolveWithin. Returns the resolved path or null if
 * the input escapes the base directory. Convenience for HTTP handlers that
 * want to return a 403 rather than catch an exception.
 */
export function safeResolveWithin(baseDir: string, ...segments: string[]): string | null {
  try {
    return resolveWithin(baseDir, ...segments);
  } catch {
    return null;
  }
}

/**
 * True if `target` resolves to a location inside (or equal to) `baseDir`.
 * Unlike resolveWithin, this doesn't restrict how target was formed and never
 * throws — used to validate two independently-supplied absolute paths (e.g.
 * confirming a workspace dir actually sits inside a configured git repo root).
 */
export function isWithin(baseDir: string, target: string): boolean {
  const base = resolve(baseDir);
  const targetResolved = resolve(target);
  const baseCmp = normalizeForCompare(base);
  const targetCmp = normalizeForCompare(targetResolved);
  const baseWithSep = baseCmp.endsWith(sep) ? baseCmp : baseCmp + sep;
  return targetCmp === baseCmp || targetCmp.startsWith(baseWithSep);
}

/**
 * Sanitize a single path segment (a filename or a single directory name) so it
 * is safe to use as a leaf component. This does NOT permit sub-paths — every
 * separator is stripped. Use for filenames coming from user input.
 *
 * Handles: path separators, `..` / dots-only names, null bytes and control
 * chars, Windows-illegal characters, reserved Windows device names, leading
 * dots, and length capping.
 *
 * Returns `fallback` if the input reduces to something empty or unusable.
 */
export function sanitizeSegment(name: string, fallback = 'file'): string {
  let cleaned = String(name ?? '')
    .replace(/[\x00-\x1f]/g, '')       // control chars + null bytes
    .replace(/[\\/]/g, '_')            // path separators
    .replace(/[:*?"<>|]/g, '_')        // Windows-illegal chars
    .replace(/\.{2,}/g, '_')           // collapse ".." (and longer) runs
    .replace(/^\.+/, '')               // strip leading dots (hidden / dots-only)
    .trim()
    .slice(0, 200);

  // Reject names that are now empty or consist only of dots/spaces/underscores.
  if (!cleaned || /^[.\s_]*$/.test(cleaned)) {
    return fallback;
  }

  // Reject reserved Windows device names (base name before first dot).
  const baseName = cleaned.split('.')[0].toLowerCase();
  if (WINDOWS_RESERVED.has(baseName)) {
    return fallback;
  }

  return cleaned;
}

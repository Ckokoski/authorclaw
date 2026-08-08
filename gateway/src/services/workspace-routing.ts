/**
 * Per-book workspace routing (ALP-1596 / ALP-1547).
 *
 * Historically `AUTHORCLAW_WORKSPACE_DIR` pointed straight at ONE flat
 * directory holding every book's state (memory, soul, projects, costs,
 * images, ...), resolved once at boot into ~35 singleton services. One
 * running instance == one book, permanently.
 *
 * This module treats that same env var as a ROOT that can hold MANY
 * per-book workspaces at `<root>/<book-slug>/`, plus an "active book"
 * selector that decides which one boots. Switching is restart-scoped —
 * services are boot-time singletons, so there is no hot-swap.
 *
 * Backward compatibility is load-bearing: an existing flat install (has
 * `memory/`, `soul/`, or `projects/` directly under the root, no active book
 * selected) is detected as LEGACY and the root itself is used as the
 * workspace dir, unchanged from pre-ALP-1596 behavior. No migration is
 * required to keep an existing single-book install running. A book can still
 * be migrated into the multi-book layout on purpose via `migrateLegacyBook`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { mkdir, readdir, rename, cp } from 'fs/promises';
import { join, resolve } from 'path';

/** Directory/file names that already mean something at the workspace root — never valid book slugs. */
export const RESERVED_BOOK_SLUGS = new Set([
  'memory',
  'soul',
  'projects',
  'images',
  'audio',
  'character-voices',
  'plot-promises',
  'context',
  'documents',
  'data',
  'exports',
  'research',
  'config',
  'dashboard',
  '.audit',
  '.agent',
  '.config',
  '.active-book',
]);

/** Subset of the reserved names that, if present directly under the root, signal a legacy flat workspace. */
const LEGACY_SIGNAL_DIRS = ['memory', 'soul', 'projects'];

/** The empty directory skeleton a book workspace needs (mirrors scripts/setup-wizard.sh). */
const BOOK_SKELETON_DIRS = [
  'memory/conversations',
  'memory/book-bible',
  'memory/voice-data',
  'projects',
  'exports',
  'research',
  '.audit',
  'soul',
  'images',
  'audio',
  'character-voices',
  'plot-promises',
  'context',
  'documents',
  'data',
];

/** Known seed files/dirs copied from the install's bundled default skeleton when scaffolding a new book. */
const SEED_PATHS = [
  'soul/SOUL.md',
  'soul/PERSONALITY.md',
  'soul/STYLE-GUIDE.md',
  'soul/VOICE-PROFILE.template.md',
  'projects/.template',
];

const ACTIVE_BOOK_POINTER_FILE = '.active-book';

export type WorkspaceMode = 'legacy-flat' | 'active-book' | 'default-book';

export interface ResolvedWorkspace {
  /** The multi-book root (== AUTHORCLAW_WORKSPACE_DIR / AUTHORCLAW_PROJECTS_ROOT, resolved). */
  root: string;
  /** The directory actually passed to services as WORKSPACE_DIR. */
  workspaceDir: string;
  /** null in legacy-flat mode — there is no book slug, the root IS the book. */
  activeBook: string | null;
  mode: WorkspaceMode;
}

export function isValidBookSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !RESERVED_BOOK_SLUGS.has(slug);
}

/** Filesystem-safe slug of a book name. Never returns empty. */
export function slugifyBookName(text: string): string {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

/** The multi-book root: AUTHORCLAW_WORKSPACE_DIR, falling back to the AUTHORCLAW_PROJECTS_ROOT alias, then the default. */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv, defaultRoot: string): string {
  const override = env.AUTHORCLAW_WORKSPACE_DIR || env.AUTHORCLAW_PROJECTS_ROOT;
  return override ? resolve(override) : defaultRoot;
}

/** A flat single-book install: memory/, soul/, or projects/ sit directly under the root. */
export function looksLikeLegacyFlatWorkspace(root: string): boolean {
  return LEGACY_SIGNAL_DIRS.some((dir) => existsSync(join(root, dir)));
}

// Synchronous by design: resolveActiveWorkspace runs at gateway boot, before
// the async initialize() phase, so index.ts can keep computing WORKSPACE_DIR
// as a plain top-level const rather than introducing top-level await into a
// 2,600-line entry file for one small resolution step.
export function readActiveBookPointer(root: string): string | null {
  const pointerPath = join(root, ACTIVE_BOOK_POINTER_FILE);
  if (!existsSync(pointerPath)) return null;
  const raw = readFileSync(pointerPath, 'utf-8').trim();
  return raw || null;
}

export function writeActiveBookPointer(root: string, slug: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ACTIVE_BOOK_POINTER_FILE), `${slug}\n`, 'utf-8');
}

/**
 * Resolve which directory should be used as WORKSPACE_DIR for this boot.
 * Precedence for the active book: AUTHORCLAW_ACTIVE_BOOK env > `.active-book`
 * pointer file > legacy-flat detection > 'default' (fresh multi-book root).
 */
export function resolveActiveWorkspace(root: string, env: NodeJS.ProcessEnv): ResolvedWorkspace {
  const envActiveBook = env.AUTHORCLAW_ACTIVE_BOOK?.trim() || null;
  const activeBook = envActiveBook || readActiveBookPointer(root);

  if (!activeBook) {
    if (looksLikeLegacyFlatWorkspace(root)) {
      return { root, workspaceDir: root, activeBook: null, mode: 'legacy-flat' };
    }
    return { root, workspaceDir: join(root, 'default'), activeBook: 'default', mode: 'default-book' };
  }

  return { root, workspaceDir: join(root, activeBook), activeBook, mode: 'active-book' };
}

export interface BookInfo {
  slug: string;
  active: boolean;
}

/** List per-book workspace directories under root, marking the currently active one (if any). */
export async function listBooks(root: string): Promise<BookInfo[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const active = readActiveBookPointer(root);
  return entries
    .filter((e) => e.isDirectory() && !RESERVED_BOOK_SLUGS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => ({ slug: e.name, active: e.name === active }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Scaffold a new, isolated book workspace at `<root>/<slug>/`: the empty
 * directory skeleton plus the install's bundled default seed files (soul
 * docs, project template) copied from `<installRootDir>/workspace`.
 */
export async function scaffoldBookWorkspace(root: string, slug: string, installRootDir: string): Promise<string> {
  if (!isValidBookSlug(slug)) {
    throw new Error(
      `"${slug}" is not a valid book slug (lowercase letters/digits/hyphens, and not a reserved name like ${[...RESERVED_BOOK_SLUGS].slice(0, 3).join(', ')}, ...).`,
    );
  }
  const bookDir = join(root, slug);
  if (existsSync(bookDir)) {
    throw new Error(`Book workspace already exists: ${bookDir}`);
  }

  for (const dir of BOOK_SKELETON_DIRS) {
    await mkdir(join(bookDir, dir), { recursive: true });
  }

  const seedRoot = join(installRootDir, 'workspace');
  for (const seedPath of SEED_PATHS) {
    const src = join(seedRoot, seedPath);
    if (!existsSync(src)) continue;
    await cp(src, join(bookDir, seedPath), { recursive: true });
  }

  return bookDir;
}

/**
 * One-command migration for an existing flat/legacy install: move the known
 * legacy top-level entries into `<root>/<slug>/` and point `.active-book` at
 * it. No data is deleted — everything recognized is moved, nothing else is
 * touched. Idempotent-ish: refuses to run if `<root>/<slug>/` already exists,
 * so it can't be accidentally run twice and clobber a real book.
 */
export async function migrateLegacyWorkspace(root: string, slug: string): Promise<string> {
  if (!isValidBookSlug(slug)) {
    throw new Error(`"${slug}" is not a valid book slug.`);
  }
  if (!looksLikeLegacyFlatWorkspace(root)) {
    throw new Error(`${root} does not look like a legacy flat workspace (no memory/, soul/, or projects/ directly under it).`);
  }
  const bookDir = join(root, slug);
  if (existsSync(bookDir)) {
    throw new Error(`Migration target already exists: ${bookDir}. Refusing to overwrite — pick a different slug.`);
  }

  const entries = await readdir(root, { withFileTypes: true });
  await mkdir(bookDir, { recursive: true });

  for (const entry of entries) {
    if (entry.name === ACTIVE_BOOK_POINTER_FILE) continue;
    // A book slug directory that already exists at the root (e.g. from a
    // prior partial migration under a different slug) is left alone rather
    // than swept into this migration — only known-legacy entries move.
    if (entry.isDirectory() && !RESERVED_BOOK_SLUGS.has(entry.name) && !LEGACY_SIGNAL_DIRS.includes(entry.name)) continue;
    await rename(join(root, entry.name), join(bookDir, entry.name));
  }

  writeActiveBookPointer(root, slug);
  return bookDir;
}

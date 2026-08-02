import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveWorkspaceRoot,
  resolveActiveWorkspace,
  looksLikeLegacyFlatWorkspace,
  readActiveBookPointer,
  writeActiveBookPointer,
  listBooks,
  scaffoldBookWorkspace,
  migrateLegacyWorkspace,
  isValidBookSlug,
  slugifyBookName,
} from './workspace-routing.js';

describe('workspace-routing', () => {
  let root: string;
  let installRootDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `wsr-test-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    installRootDir = join(tmpdir(), `wsr-test-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
    // Minimal bundled skeleton scaffoldBookWorkspace seeds from.
    await mkdir(join(installRootDir, 'workspace', 'soul'), { recursive: true });
    await writeFile(join(installRootDir, 'workspace', 'soul', 'SOUL.md'), '# Soul\n');
    await mkdir(join(installRootDir, 'workspace', 'projects', '.template'), { recursive: true });
    await writeFile(join(installRootDir, 'workspace', 'projects', '.template', 'README.md'), 'template\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(installRootDir, { recursive: true, force: true });
  });

  describe('resolveWorkspaceRoot', () => {
    it('defaults to the given default root when no env override is set', () => {
      expect(resolveWorkspaceRoot({}, root)).toBe(root);
    });

    it('honors AUTHORCLAW_WORKSPACE_DIR', () => {
      const override = join(tmpdir(), 'override-a');
      expect(resolveWorkspaceRoot({ AUTHORCLAW_WORKSPACE_DIR: override }, root)).toBe(join(override));
    });

    it('falls back to the AUTHORCLAW_PROJECTS_ROOT alias', () => {
      const override = join(tmpdir(), 'override-b');
      expect(resolveWorkspaceRoot({ AUTHORCLAW_PROJECTS_ROOT: override }, root)).toBe(join(override));
    });

    it('prefers AUTHORCLAW_WORKSPACE_DIR over the alias when both are set', () => {
      const primary = join(tmpdir(), 'override-primary');
      const alias = join(tmpdir(), 'override-alias');
      expect(
        resolveWorkspaceRoot({ AUTHORCLAW_WORKSPACE_DIR: primary, AUTHORCLAW_PROJECTS_ROOT: alias }, root),
      ).toBe(join(primary));
    });
  });

  describe('legacy flat workspace (default/legacy resolution)', () => {
    it('is not detected as legacy when the root is empty', () => {
      expect(looksLikeLegacyFlatWorkspace(root)).toBe(false);
    });

    it('is detected as legacy when memory/, soul/, or projects/ sit directly under the root', async () => {
      await mkdir(join(root, 'soul'), { recursive: true });
      expect(looksLikeLegacyFlatWorkspace(root)).toBe(true);
    });

    it('resolves WORKSPACE_DIR to the root itself for a legacy install with no active book set', async () => {
      await mkdir(join(root, 'memory'), { recursive: true });
      await mkdir(join(root, 'soul'), { recursive: true });
      await mkdir(join(root, 'projects'), { recursive: true });

      const resolved = resolveActiveWorkspace(root, {});

      expect(resolved.mode).toBe('legacy-flat');
      expect(resolved.workspaceDir).toBe(root);
      expect(resolved.activeBook).toBeNull();
    });

    it('defaults an empty, non-legacy root to a "default" book subdirectory', () => {
      const resolved = resolveActiveWorkspace(root, {});

      expect(resolved.mode).toBe('default-book');
      expect(resolved.activeBook).toBe('default');
      expect(resolved.workspaceDir).toBe(join(root, 'default'));
    });
  });

  describe('active-book resolution (env + pointer)', () => {
    it('AUTHORCLAW_ACTIVE_BOOK env resolves to that book, even over a legacy-looking root', async () => {
      await mkdir(join(root, 'soul'), { recursive: true });

      const resolved = resolveActiveWorkspace(root, { AUTHORCLAW_ACTIVE_BOOK: 'book-two' });

      expect(resolved.mode).toBe('active-book');
      expect(resolved.activeBook).toBe('book-two');
      expect(resolved.workspaceDir).toBe(join(root, 'book-two'));
    });

    it('falls back to the .active-book pointer file when no env var is set', async () => {
      await writeActiveBookPointer(root, 'pointed-book');

      const resolved = resolveActiveWorkspace(root, {});

      expect(resolved.mode).toBe('active-book');
      expect(resolved.activeBook).toBe('pointed-book');
      expect(resolved.workspaceDir).toBe(join(root, 'pointed-book'));
    });

    it('env wins over the pointer file when both are set', async () => {
      await writeActiveBookPointer(root, 'pointer-book');

      const resolved = resolveActiveWorkspace(root, { AUTHORCLAW_ACTIVE_BOOK: 'env-book' });

      expect(resolved.activeBook).toBe('env-book');
    });

    it('readActiveBookPointer trims whitespace and returns null when no pointer file exists', async () => {
      expect(readActiveBookPointer(root)).toBeNull();
      await mkdir(root, { recursive: true });
      await writeFile(join(root, '.active-book'), '  spaced-book  \n');
      expect(readActiveBookPointer(root)).toBe('spaced-book');
    });
  });

  describe('slug validation', () => {
    it('accepts lowercase alphanumeric-hyphen slugs', () => {
      expect(isValidBookSlug('the-algorithm-of-wanting')).toBe(true);
      expect(isValidBookSlug('book2')).toBe(true);
    });

    it('rejects reserved names', () => {
      expect(isValidBookSlug('memory')).toBe(false);
      expect(isValidBookSlug('soul')).toBe(false);
      expect(isValidBookSlug('.active-book')).toBe(false);
    });

    it('slugifyBookName produces filesystem-safe, non-empty slugs', () => {
      expect(slugifyBookName('My Second Book!')).toBe('my-second-book');
      expect(slugifyBookName('')).toBe('untitled');
    });
  });

  describe('scaffoldBookWorkspace (new-book scaffolding)', () => {
    it('creates an isolated directory skeleton and seeds bundled default files', async () => {
      const bookDir = await scaffoldBookWorkspace(root, 'new-book', installRootDir);

      expect(bookDir).toBe(join(root, 'new-book'));
      for (const dir of ['memory/conversations', 'soul', 'projects', 'images', 'audio', '.audit']) {
        expect(existsSync(join(bookDir, dir))).toBe(true);
      }
      expect(existsSync(join(bookDir, 'soul', 'SOUL.md'))).toBe(true);
      expect(await readFile(join(bookDir, 'soul', 'SOUL.md'), 'utf-8')).toBe('# Soul\n');
      expect(existsSync(join(bookDir, 'projects', '.template', 'README.md'))).toBe(true);
    });

    it('rejects invalid slugs', async () => {
      await expect(scaffoldBookWorkspace(root, 'memory', installRootDir)).rejects.toThrow();
      await expect(scaffoldBookWorkspace(root, 'Not Valid', installRootDir)).rejects.toThrow();
    });

    it('refuses to overwrite an existing book workspace', async () => {
      await scaffoldBookWorkspace(root, 'dup-book', installRootDir);
      await expect(scaffoldBookWorkspace(root, 'dup-book', installRootDir)).rejects.toThrow(/already exists/);
    });

    it('two scaffolded books are fully isolated from each other', async () => {
      const bookA = await scaffoldBookWorkspace(root, 'book-a', installRootDir);
      const bookB = await scaffoldBookWorkspace(root, 'book-b', installRootDir);

      await writeFile(join(bookA, 'memory', 'note.md'), 'only in book a');

      expect(existsSync(join(bookB, 'memory', 'note.md'))).toBe(false);
    });
  });

  describe('migrateLegacyWorkspace', () => {
    it('moves legacy top-level entries into <root>/<slug>/ and sets the active-book pointer, losing nothing', async () => {
      await mkdir(join(root, 'memory'), { recursive: true });
      await mkdir(join(root, 'soul'), { recursive: true });
      await mkdir(join(root, 'projects', 'the-book'), { recursive: true });
      await writeFile(join(root, 'soul', 'SOUL.md'), 'existing soul content');
      await writeFile(join(root, 'costs.json'), '{}');

      const bookDir = await migrateLegacyWorkspace(root, 'my-book');

      expect(bookDir).toBe(join(root, 'my-book'));
      expect(await readFile(join(bookDir, 'soul', 'SOUL.md'), 'utf-8')).toBe('existing soul content');
      expect(existsSync(join(bookDir, 'projects', 'the-book'))).toBe(true);
      expect(existsSync(join(bookDir, 'costs.json'))).toBe(true);
      expect(readActiveBookPointer(root)).toBe('my-book');

      // Resolution now routes to the migrated book, not the (emptied) root.
      const resolved = resolveActiveWorkspace(root, {});
      expect(resolved.workspaceDir).toBe(bookDir);
    });

    it('refuses to migrate a root that does not look legacy', async () => {
      await expect(migrateLegacyWorkspace(root, 'my-book')).rejects.toThrow(/does not look like/);
    });

    it('refuses to overwrite an existing migration target', async () => {
      await mkdir(join(root, 'memory'), { recursive: true });
      await mkdir(join(root, 'my-book'), { recursive: true });

      await expect(migrateLegacyWorkspace(root, 'my-book')).rejects.toThrow(/already exists/);
    });
  });

  describe('listBooks', () => {
    it('returns an empty list for a nonexistent root', async () => {
      expect(await listBooks(join(root, 'does-not-exist'))).toEqual([]);
    });

    it('lists book directories and marks the active one', async () => {
      await scaffoldBookWorkspace(root, 'book-a', installRootDir);
      await scaffoldBookWorkspace(root, 'book-b', installRootDir);
      await writeActiveBookPointer(root, 'book-b');

      const books = await listBooks(root);

      expect(books).toEqual([
        { slug: 'book-a', active: false },
        { slug: 'book-b', active: true },
      ]);
    });
  });
});

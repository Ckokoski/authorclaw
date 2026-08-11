import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorkspaceGitSyncService } from './workspace-git-sync.js';

const execAsync = promisify(exec);

// Lightweight fakes — the subject under test only calls .get/.set/.list on
// the vault and .get/.setAndPersist on config, so a real encrypted Vault /
// file-backed ConfigService would be pure overhead here (their own behavior
// is covered by vault.test.ts and doesn't need re-proving through this file).
function makeFakeVault() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    set: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => store.delete(k),
    list: async () => Array.from(store.keys()),
  } as any;
}

function makeFakeConfig() {
  const data: Record<string, any> = {
    workspaceGit: { enabled: false, repoRoot: '', syncIntervalMinutes: 30, autoMergeEnabled: true },
  };
  return {
    get: (path: string, def?: any) => {
      const parts = path.split('.');
      let cur = data;
      for (const p of parts) {
        if (cur?.[p] === undefined) return def;
        cur = cur[p];
      }
      return cur ?? def;
    },
    setAndPersist: async (path: string, value: any) => {
      const parts = path.split('.');
      let cur = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    },
  } as any;
}

describe('WorkspaceGitSyncService', () => {
  let workDir: string;
  let originDir: string;
  let repoRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    const counter = Math.floor(Math.random() * 1_000_000_000);
    workDir = join(tmpdir(), `wgs-test-${counter}`);
    originDir = join(workDir, 'origin.git');
    repoRoot = join(workDir, 'repo-root');
    workspaceDir = join(repoRoot, 'books', 'authoragent-workspace');
    await mkdir(workDir, { recursive: true });
    // Real local bare repo standing in for GitHub — exercises the actual
    // runGit() clone/push/fetch path with zero network dependency.
    await execAsync(`git init --bare -q "${originDir}"`);
    // A fresh bare repo's HEAD symref points at whatever init.defaultBranch
    // is configured (often "master"), which won't exist once we only ever
    // push "main" below — an ambiguous HEAD makes `git clone` fetch refs but
    // skip checkout, leaving the working tree empty. Pin HEAD explicitly so
    // clone behaves like it would against a real GitHub repo.
    await execAsync(`git --git-dir="${originDir}" symbolic-ref HEAD refs/heads/main`);
    // Seed it with a main branch (a bare repo starts with none).
    const seedDir = join(workDir, 'seed');
    await mkdir(join(seedDir, 'books', 'authoragent-workspace'), { recursive: true });
    await writeFile(join(seedDir, 'books', 'authoragent-workspace', 'seed.md'), '# seed\n');
    await execAsync(`git init -q -b main "${seedDir}"`);
    await execAsync(`git -C "${seedDir}" config user.email test@example.com`);
    await execAsync(`git -C "${seedDir}" config user.name test`);
    await execAsync(`git -C "${seedDir}" add -A`);
    await execAsync(`git -C "${seedDir}" commit -q -m seed`);
    await execAsync(`git -C "${seedDir}" remote add origin "${originDir}"`);
    await execAsync(`git -C "${seedDir}" push -q origin main`);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeService(): WorkspaceGitSyncService {
    const svc = new WorkspaceGitSyncService(workspaceDir);
    svc.setServices(makeFakeVault(), makeFakeConfig());
    // Bypass real GitHub credential validation — git mechanics stay real
    // against the local bare repo above, only the GitHub API surface is faked.
    vi.spyOn(svc as any, 'testCredentials').mockResolvedValue({ ok: true, message: 'ok' });
    return svc;
  }

  describe('connect()', () => {
    it('clones into an empty repo root', async () => {
      const svc = makeService();
      const status = await svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot });
      expect(status.configured).toBe(true);
      expect(status.isGitRepo).toBe(true);
      expect(existsSync(join(repoRoot, '.git'))).toBe(true);
      expect(existsSync(join(workspaceDir))).toBe(true);
    });

    it('refuses a non-empty repo root with no .git directory', async () => {
      const svc = makeService();
      await mkdir(repoRoot, { recursive: true });
      await writeFile(join(repoRoot, 'some-file.txt'), 'pre-existing content\n');
      await expect(svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot }))
        .rejects.toThrow(/already exists, is not empty, and has no \.git directory/);
    });

    it('rejects when the workspace dir is not inside the repo root', async () => {
      const svc = new WorkspaceGitSyncService(join(workDir, 'somewhere-else'));
      svc.setServices(makeFakeVault(), makeFakeConfig());
      vi.spyOn(svc as any, 'testCredentials').mockResolvedValue({ ok: true, message: 'ok' });
      await expect(svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot }))
        .rejects.toThrow(/not inside the repo root/);
    });
  });

  describe('syncNow()', () => {
    it('reports nothing to sync on a clean workspace', async () => {
      const svc = makeService();
      await svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot });
      const result = await svc.syncNow();
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Nothing to sync/);
    });

    it('merges automatically when GitHub reports the PR cleanly mergeable', async () => {
      const svc = makeService();
      await svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot });
      await writeFile(join(workspaceDir, 'chapter-1.md'), '# Chapter 1\n');

      // originDir is a local bare-repo path, not a github.com URL — the real
      // git remote mechanics (fetch/push/pull) go through it fine via the
      // already-configured "origin" remote, but owner/repo parsing needs a
      // GitHub-shaped URL, which only matters for the mocked API calls below.
      vi.spyOn(svc as any, 'parseOwnerRepo').mockReturnValue({ owner: 'test-owner', repo: 'test-repo' });
      const githubApi = vi.spyOn(svc as any, 'githubApi').mockImplementation(async (...args: any[]) => {
        const [, method, path] = args as [any, string, string];
        if (method === 'POST' && path === '/pulls') return { number: 1, html_url: 'https://example.invalid/pr/1' };
        if (method === 'GET' && path === '/pulls/1') return { number: 1, mergeable: true, mergeable_state: 'clean', html_url: 'https://example.invalid/pr/1' };
        if (method === 'PUT' && path === '/pulls/1/merge') return { merged: true };
        if (method === 'DELETE') return {};
        throw new Error(`Unexpected githubApi call: ${method} ${path}`);
      });

      const result = await svc.syncNow();
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Synced and merged/);
      expect(result.status.lastSyncStatus).toBe('success');
      expect(githubApi).toHaveBeenCalled();
    });

    it('leaves the PR open and reports needs-manual-resolution when not cleanly mergeable', async () => {
      const svc = makeService();
      await svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot });
      await writeFile(join(workspaceDir, 'chapter-1.md'), '# Chapter 1\n');

      vi.spyOn(svc as any, 'parseOwnerRepo').mockReturnValue({ owner: 'test-owner', repo: 'test-repo' });
      vi.spyOn(svc as any, 'githubApi').mockImplementation(async (...args: any[]) => {
        const [, method, path] = args as [any, string, string];
        if (method === 'POST' && path === '/pulls') return { number: 2, html_url: 'https://example.invalid/pr/2' };
        if (method === 'GET' && path === '/pulls/2') return { number: 2, mergeable: false, mergeable_state: 'dirty', html_url: 'https://example.invalid/pr/2' };
        throw new Error(`Unexpected githubApi call: ${method} ${path}`);
      });

      const result = await svc.syncNow();
      expect(result.success).toBe(false);
      expect(result.status.lastSyncStatus).toBe('needs-manual-resolution');
      expect(result.status.openPrUrl).toBe('https://example.invalid/pr/2');
    });

    it('returns immediately when a sync is already in progress', async () => {
      const svc = makeService();
      await svc.connect({ repoUrl: originDir, pat: 'fake-pat', repoRoot });
      (svc as any).syncing = true;
      const result = await svc.syncNow();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/already in progress/);
    });
  });
});

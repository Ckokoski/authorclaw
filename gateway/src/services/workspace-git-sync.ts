/**
 * Workspace Git Sync (ALP — manuscript workspace git connection)
 *
 * Optional, first-class git connection for the manuscript workspace, so an
 * AuthorAgent instance can check its own work into version history instead
 * of relying on a human to do it by hand. Configured via the Connections tab
 * + encrypted vault, same as an LLM provider key — the app works exactly as
 * before if this is never connected.
 *
 * Design is deliberately simple, not gated: on sync, changes land on a fresh
 * branch, a PR is opened, and it's merged into `main` automatically as soon
 * as GitHub reports it cleanly mergeable. There is no protected integration
 * branch — git history itself is the rollback mechanism (a bad sync is
 * reverted with `git revert -m 1 <merge-sha>`, not blocked ahead of time).
 * The ONE case where nothing automatic happens is a conflicting PR: that's
 * the exact data-loss scenario this service exists to prevent, so it is
 * left open for manual resolution rather than force-resolved.
 *
 * Modeled after website-deploy.ts's shell-git pattern (execAsync with
 * cwd/timeout/maxBuffer, never throws out of the public API, returns result
 * objects) but adds real credential handling, which website-deploy.ts
 * deliberately does not — see runGit() below for why the token never touches
 * disk or `.git/config`.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { mkdir, writeFile, unlink, chmod, readdir } from 'fs/promises';
import { tmpdir, hostname } from 'os';
import { join, relative, sep } from 'path';
import { randomBytes } from 'crypto';
import type { Vault } from '../security/vault.js';
import type { ConfigService } from './config.js';
import type { CronSchedulerService } from './cron-scheduler.js';
import { isWithin } from '../security/paths.js';

const execAsync = promisify(exec);

export interface GitSyncStatus {
  configured: boolean;
  enabled: boolean;
  repoRoot: string | null;
  repoUrlSanitized: string | null;
  workspaceRelPath: string | null;
  isGitRepo: boolean;
  currentBranch: string | null;
  ahead: number;
  behind: number;
  dirtyFileCount: number;
  lastSyncAt: string | null;
  lastSyncStatus: 'success' | 'failed' | 'needs-manual-resolution' | null;
  lastSyncMessage: string | null;
  openPrUrl: string | null;
  syncInProgress: boolean;
}

interface SyncState {
  lastSyncAt: string | null;
  lastSyncStatus: GitSyncStatus['lastSyncStatus'];
  lastSyncMessage: string | null;
  openPrUrl: string | null;
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

const VAULT_REPO_URL_KEY = 'git_repo_url';
const VAULT_PAT_KEY = 'git_pat';
export const WORKSPACE_GIT_SYNC_HANDLER = 'workspace-git-sync';

export class WorkspaceGitSyncService {
  private vault!: Vault;
  private config!: ConfigService;
  private cronScheduler: CronSchedulerService | null = null;
  private syncing = false;
  private state: SyncState = { lastSyncAt: null, lastSyncStatus: null, lastSyncMessage: null, openPrUrl: null };

  constructor(private workspaceDir: string) {}

  setServices(vault: Vault, config: ConfigService, cronScheduler?: CronSchedulerService): void {
    this.vault = vault;
    this.config = config;
    if (cronScheduler) this.cronScheduler = cronScheduler;
  }

  /** Idempotently ensure the auto-sync cron job exists and is enabled. */
  private async ensureCronJob(): Promise<void> {
    if (!this.cronScheduler) return;
    const intervalMinutes: number = this.config.get('workspaceGit.syncIntervalMinutes', 30);
    const existing = this.cronScheduler.list().find(j => j.handler === WORKSPACE_GIT_SYNC_HANDLER);
    if (existing) {
      await this.cronScheduler.updateJob(existing.id, { enabled: true });
      return;
    }
    await this.cronScheduler.createJob({
      name: 'Workspace git sync',
      schedule: `*/${Math.max(1, Math.min(59, intervalMinutes))} * * * *`,
      handler: WORKSPACE_GIT_SYNC_HANDLER,
      enabled: true,
    });
  }

  /** Disable (not delete) the auto-sync cron job so reconnecting doesn't duplicate it. */
  private async disableCronJob(): Promise<void> {
    if (!this.cronScheduler) return;
    const existing = this.cronScheduler.list().find(j => j.handler === WORKSPACE_GIT_SYNC_HANDLER);
    if (existing) await this.cronScheduler.updateJob(existing.id, { enabled: false });
  }

  // ═══════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════

  async getStatus(): Promise<GitSyncStatus> {
    const repoRoot: string = this.config.get('workspaceGit.repoRoot', '');
    const enabled: boolean = this.config.get('workspaceGit.enabled', false);
    const repoUrl = await this.vault.get(VAULT_REPO_URL_KEY);
    const configured = !!(repoRoot && repoUrl);

    const base: GitSyncStatus = {
      configured,
      enabled,
      repoRoot: repoRoot || null,
      repoUrlSanitized: repoUrl ? this.sanitizeRepoUrl(repoUrl) : null,
      workspaceRelPath: repoRoot ? this.relWorkspacePath(repoRoot) : null,
      isGitRepo: false,
      currentBranch: null,
      ahead: 0,
      behind: 0,
      dirtyFileCount: 0,
      lastSyncAt: this.state.lastSyncAt,
      lastSyncStatus: this.state.lastSyncStatus,
      lastSyncMessage: this.state.lastSyncMessage,
      openPrUrl: this.state.openPrUrl,
      syncInProgress: this.syncing,
    };

    if (!configured || !existsSync(join(repoRoot, '.git'))) {
      return base;
    }
    base.isGitRepo = true;

    try {
      const pat = (await this.vault.get(VAULT_PAT_KEY)) || '';
      const branchRes = await this.runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], pat);
      base.currentBranch = branchRes.stdout.trim();

      const statusRes = await this.runGit(
        repoRoot,
        ['status', '--porcelain', '--', this.relWorkspacePath(repoRoot)],
        pat
      );
      base.dirtyFileCount = statusRes.stdout.split('\n').filter(l => l.trim()).length;

      try {
        const revRes = await this.runGit(repoRoot, ['rev-list', '--left-right', '--count', 'origin/main...HEAD'], pat);
        const [behind, ahead] = revRes.stdout.trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
        base.behind = behind;
        base.ahead = ahead;
      } catch {
        // origin/main not fetched yet, or repo not tracking it — leave at 0.
      }
    } catch {
      // Status is best-effort; any read failure just leaves defaults.
    }

    return base;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const repoUrl = await this.vault.get(VAULT_REPO_URL_KEY);
    const pat = await this.vault.get(VAULT_PAT_KEY);
    if (!repoUrl || !pat) {
      return { ok: false, message: 'No repo connected — set a repo URL and personal access token first.' };
    }
    return this.testCredentials(repoUrl, pat);
  }

  async connect(input: { repoUrl: string; pat: string; repoRoot: string }): Promise<GitSyncStatus> {
    const { repoUrl, pat, repoRoot } = input;
    if (!repoUrl || !pat || !repoRoot) {
      throw new Error('repoUrl, pat, and repoRoot are all required');
    }
    if (!isWithin(repoRoot, this.workspaceDir)) {
      throw new Error(
        `Workspace directory (${this.workspaceDir}) is not inside the repo root (${repoRoot}). ` +
        `Pick a repo root that actually contains the workspace as a subdirectory.`
      );
    }

    const test = await this.testCredentials(repoUrl, pat);
    if (!test.ok) throw new Error(test.message);

    if (!existsSync(repoRoot)) {
      await mkdir(repoRoot, { recursive: true });
    }
    if (existsSync(join(repoRoot, '.git'))) {
      try {
        await this.runGit(repoRoot, ['remote', 'set-url', 'origin', repoUrl], pat);
      } catch {
        await this.runGit(repoRoot, ['remote', 'add', 'origin', repoUrl], pat);
      }
      await this.runGit(repoRoot, ['fetch', 'origin'], pat);
    } else {
      const existing = existsSync(repoRoot) ? await readdir(repoRoot) : [];
      if (existing.length > 0) {
        throw new Error(
          `${repoRoot} already exists, is not empty, and has no .git directory. Reconcile it manually ` +
          `(git init / git remote add / merge existing content) before connecting — this is exactly the ` +
          `ambiguous-history case that shouldn't be automated.`
        );
      }
      await this.runGit(repoRoot, ['clone', repoUrl, '.'], pat);
    }

    await this.vault.set(VAULT_REPO_URL_KEY, repoUrl);
    await this.vault.set(VAULT_PAT_KEY, pat);
    await this.config.setAndPersist('workspaceGit.repoRoot', repoRoot);
    await this.config.setAndPersist('workspaceGit.enabled', true);
    await this.ensureCronJob();

    return this.getStatus();
  }

  async disconnect(): Promise<void> {
    // Pauses syncing only — deliberately does not delete the local clone or
    // forget vault credentials. A user who wants credentials fully removed
    // deletes the vault keys from the Connections tab directly, same as any
    // other provider.
    await this.config.setAndPersist('workspaceGit.enabled', false);
    await this.disableCronJob();
  }

  async syncNow(): Promise<{ success: boolean; message: string; status: GitSyncStatus }> {
    if (this.syncing) {
      return { success: false, message: 'A sync is already in progress', status: await this.getStatus() };
    }
    this.syncing = true;
    try {
      return await this.doSync();
    } finally {
      this.syncing = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Sync flow
  // ═══════════════════════════════════════════════════════════

  private async doSync(): Promise<{ success: boolean; message: string; status: GitSyncStatus }> {
    const repoRoot: string = this.config.get('workspaceGit.repoRoot', '');
    const repoUrl = await this.vault.get(VAULT_REPO_URL_KEY);
    const pat = await this.vault.get(VAULT_PAT_KEY);
    if (!repoRoot || !repoUrl || !pat) {
      return this.finishSync(false, 'Workspace git sync is not configured', null);
    }
    const relPath = this.relWorkspacePath(repoRoot);

    try {
      await this.runGit(repoRoot, ['checkout', 'main'], pat);
      await this.runGit(repoRoot, ['fetch', 'origin'], pat);

      const statusRes = await this.runGit(repoRoot, ['status', '--porcelain', '--', relPath], pat);
      if (!statusRes.stdout.trim()) {
        return this.finishSync(true, 'Nothing to sync — workspace is clean', null);
      }

      // Only needed once we actually have something to open a PR for.
      const owner = this.parseOwnerRepo(repoUrl);
      if (!owner) {
        return this.finishSync(false, `Could not parse owner/repo from ${this.sanitizeRepoUrl(repoUrl)}`, null);
      }

      const stamp = this.timestamp();
      const branch = `sync/${this.safeHostname()}-${stamp}`;
      await this.runGit(repoRoot, ['checkout', '-B', branch, 'origin/main'], pat);
      // A fresh clone (e.g. a new container) has no global git identity —
      // set it locally so commit doesn't fail. Harmless if already set.
      await this.runGit(repoRoot, ['config', 'user.email', 'authoragent@localhost'], pat);
      await this.runGit(repoRoot, ['config', 'user.name', 'AuthorAgent'], pat);
      await this.runGit(repoRoot, ['add', '--', relPath], pat);
      await this.runGit(repoRoot, ['commit', '-m', `Workspace sync from ${this.safeHostname()} — ${stamp}`], pat);
      await this.runGit(repoRoot, ['push', '-u', 'origin', branch], pat);

      const pr = await this.githubApi(owner, 'POST', '/pulls', pat, {
        title: `Workspace sync from ${this.safeHostname()} — ${stamp}`,
        head: branch,
        base: 'main',
        body: 'Automatic manuscript workspace sync opened by AuthorAgent.',
      });

      const cleanlyMergeable = await this.pollMergeable(owner, pr.number, pat);

      if (cleanlyMergeable) {
        await this.githubApi(owner, 'PUT', `/pulls/${pr.number}/merge`, pat, { merge_method: 'merge' });
        await this.githubApi(owner, 'DELETE', `/git/refs/heads/${branch}`, pat).catch(() => {});
        await this.runGit(repoRoot, ['checkout', 'main'], pat);
        await this.runGit(repoRoot, ['pull', 'origin', 'main'], pat);
        return this.finishSync(true, `Synced and merged (PR #${pr.number})`, null);
      }

      // Not cleanly mergeable — leave the PR and branch as-is for a human to
      // resolve. Never force anything here; this is the data-loss case.
      await this.runGit(repoRoot, ['checkout', 'main'], pat);
      return this.finishSync(
        false,
        `PR #${pr.number} is not cleanly mergeable — needs manual resolution.`,
        pr.html_url,
        'needs-manual-resolution'
      );
    } catch (err: any) {
      try {
        await this.runGit(repoRoot, ['checkout', 'main'], pat);
      } catch {
        // best-effort recovery — don't mask the original error
      }
      return this.finishSync(false, err?.message || 'Sync failed', null);
    }
  }

  private async pollMergeable(owner: OwnerRepo, prNumber: number, pat: string): Promise<boolean> {
    // GitHub computes mergeability asynchronously — mergeable is null until
    // it's done. Poll a bounded number of times rather than looping forever.
    for (let i = 0; i < 10; i++) {
      const pr = await this.githubApi(owner, 'GET', `/pulls/${prNumber}`, pat);
      if (pr.mergeable !== null && pr.mergeable !== undefined) {
        return pr.mergeable === true && pr.mergeable_state === 'clean';
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  private async finishSync(
    success: boolean,
    message: string,
    openPrUrl: string | null,
    statusOverride?: GitSyncStatus['lastSyncStatus']
  ): Promise<{ success: boolean; message: string; status: GitSyncStatus }> {
    this.state = {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: statusOverride || (success ? 'success' : 'failed'),
      lastSyncMessage: message,
      openPrUrl,
    };
    return { success, message, status: await this.getStatus() };
  }

  // ═══════════════════════════════════════════════════════════
  // GitHub REST API (fetch — no Octokit, no gh CLI dependency)
  // ═══════════════════════════════════════════════════════════

  private async testCredentials(repoUrl: string, pat: string): Promise<{ ok: boolean; message: string }> {
    const owner = this.parseOwnerRepo(repoUrl);
    if (!owner) {
      return { ok: false, message: `Could not parse an owner/repo from "${repoUrl}". Expected something like https://github.com/owner/repo.git` };
    }
    try {
      const repo = await this.githubApi(owner, 'GET', '', pat);
      if (!repo?.permissions?.push) {
        return { ok: false, message: `Token is valid but does not have push access to ${owner.owner}/${owner.repo}.` };
      }
      return { ok: true, message: `Connected to ${owner.owner}/${owner.repo} with push access.` };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Could not reach the GitHub API with this token.' };
    }
  }

  private async githubApi(owner: OwnerRepo, method: string, path: string, pat: string, body?: any): Promise<any> {
    const res = await fetch(`https://api.github.com/repos/${owner.owner}/${owner.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(`GitHub API ${method} ${path || '/'} failed (${res.status}): ${data?.message || text || 'unknown error'}`);
    }
    return data;
  }

  private parseOwnerRepo(repoUrl: string): OwnerRepo | null {
    const m = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  }

  private sanitizeRepoUrl(repoUrl: string): string {
    const owner = this.parseOwnerRepo(repoUrl);
    return owner ? `${owner.owner}/${owner.repo}` : '(unrecognized repo url)';
  }

  // ═══════════════════════════════════════════════════════════
  // git CLI + credential injection
  // ═══════════════════════════════════════════════════════════

  private relWorkspacePath(repoRoot: string): string {
    const rel = relative(repoRoot, this.workspaceDir);
    return rel.split(sep).join('/'); // git wants forward slashes even on Windows
  }

  private safeHostname(): string {
    return hostname().replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 40) || 'unknown-host';
  }

  private timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Run a git command with the PAT injected via a per-invocation GIT_ASKPASS
   * script that never contains the token itself — it reads it from a
   * child-process-only environment variable. This means:
   *   - the askpass script file on disk never has the secret in it
   *   - .git/config's remote URL is never token-embedded (no leaked PAT if
   *     someone reads the repo's config later)
   *   - the token only ever lives in this one process's env, for the
   *     duration of one git command
   * Script is deleted immediately after every call, success or failure.
   */
  private async runGit(cwd: string, args: string[], pat: string): Promise<{ stdout: string; stderr: string }> {
    const askpassPath = join(tmpdir(), `authorclaw-askpass-${randomBytes(8).toString('hex')}.sh`);
    const script = '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  Password*) echo "$AUTHORCLAW_GIT_SYNC_TOKEN" ;;\nesac\n';
    await writeFile(askpassPath, script, { mode: 0o700 });
    try {
      if (process.platform !== 'win32') {
        await chmod(askpassPath, 0o700).catch(() => {});
      }
      const cmd = `git ${args.map(a => this.shellQuote(a)).join(' ')}`;
      return await execAsync(cmd, {
        cwd,
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_ASKPASS: askpassPath,
          GIT_TERMINAL_PROMPT: '0',
          AUTHORCLAW_GIT_SYNC_TOKEN: pat,
        },
      });
    } finally {
      await unlink(askpassPath).catch(() => {});
    }
  }

  private shellQuote(s: string): string {
    if (process.platform === 'win32') {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }
}

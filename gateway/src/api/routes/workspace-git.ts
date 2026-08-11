/**
 * Workspace git connection routes — optional git-repo connectivity for the
 * manuscript workspace. See gateway/src/services/workspace-git-sync.ts for
 * the actual connect/sync/merge logic; this module is a thin REST wrapper.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerWorkspaceGitRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;

  app.get('/api/workspace-git/status', async (_req: Request, res: Response) => {
    if (!services.workspaceGitSync) return res.status(503).json({ error: 'Workspace git sync not initialized' });
    res.json(await services.workspaceGitSync.getStatus());
  });

  app.post('/api/workspace-git/connect', async (req: Request, res: Response) => {
    if (!services.workspaceGitSync) return res.status(503).json({ error: 'Workspace git sync not initialized' });
    const { repoUrl, pat, repoRoot } = req.body || {};
    if (!repoUrl || !pat || !repoRoot) {
      return res.status(400).json({ error: 'repoUrl, pat, and repoRoot are all required' });
    }
    try {
      const status = await services.workspaceGitSync.connect({ repoUrl, pat, repoRoot });
      res.json({ success: true, status });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || 'Connect failed' });
    }
  });

  app.post('/api/workspace-git/test', async (_req: Request, res: Response) => {
    if (!services.workspaceGitSync) return res.status(503).json({ error: 'Workspace git sync not initialized' });
    res.json(await services.workspaceGitSync.testConnection());
  });

  app.post('/api/workspace-git/disconnect', async (_req: Request, res: Response) => {
    if (!services.workspaceGitSync) return res.status(503).json({ error: 'Workspace git sync not initialized' });
    await services.workspaceGitSync.disconnect();
    res.json({ success: true });
  });

  app.post('/api/workspace-git/sync-now', async (_req: Request, res: Response) => {
    if (!services.workspaceGitSync) return res.status(503).json({ error: 'Workspace git sync not initialized' });
    res.json(await services.workspaceGitSync.syncNow());
  });
}

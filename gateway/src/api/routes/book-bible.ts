/**
 * book-bible routes — compile/fetch the canonical per-book book-bible.md.
 * Structured like the existing /api/projects/:id/compile route in
 * documents.ts: same project lookup, 404 handling, and baseDir usage.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { BookBibleService } from '../../services/book-bible.js';

export function registerBookBibleRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;
  const bookBible = new BookBibleService(baseDir);

  // Compile (or regenerate) the book bible for a project.
  app.post('/api/projects/:id/book-bible', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const contextEngine = services.contextEngine;
    if (!contextEngine) return res.status(503).json({ error: 'Context engine not available' });

    try {
      const projectId = String(req.params.id);
      const result = await bookBible.compile(engine, contextEngine, projectId);
      await services.memory.saveBookBibleEntry(projectId, 'book-bible.md', result.content);
      res.json({
        success: true,
        content: result.content,
        mergedProjectIds: result.mergedProjectIds,
        counts: result.counts,
      });
    } catch (err: any) {
      if (err?.code === 'PROJECT_NOT_FOUND') return res.status(404).json({ error: 'Project not found' });
      res.status(500).json({ error: 'Book bible compile failed: ' + String(err?.message || err) });
    }
  });

  // Fetch the currently persisted book bible.
  app.get('/api/projects/:id/book-bible', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const content = await services.memory.getBookBibleEntry(String(req.params.id), 'book-bible.md');
      if (content === null) {
        return res.status(404).json({ error: 'Book bible has not been compiled yet. POST to this endpoint to generate it.' });
      }
      res.json({ content });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to load book bible: ' + String(err?.message || err) });
    }
  });
}

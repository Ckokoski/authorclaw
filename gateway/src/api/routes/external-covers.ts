/**
 * external-covers routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';
import { safePath, gatherChapters } from '../context.js';

export function registerExternalCoversRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir, workspaceDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // External Tool Wrappers — sibling Python apps in ../Automations/
  // ═══════════════════════════════════════════════════════════

  app.post('/api/projects/:id/pacing-heatmap', async (req: Request, res: Response) => {
    const tools = services.externalTools;
    if (!tools) return res.status(503).json({ error: 'External tools not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No completed chapters found.' });
    }
    const manuscript = chapters.map(c => `# Chapter ${c.number}: ${c.title}\n\n${c.text}`).join('\n\n');
    const result = await tools.runManuscriptAutopsy(manuscript);
    res.json(result);
  });

  app.post('/api/projects/:id/format-pro', async (req: Request, res: Response) => {
    const tools = services.externalTools;
    if (!tools) return res.status(503).json({ error: 'External tools not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { outputFormat, trimSize, author } = req.body || {};
    const fmt = outputFormat || 'docx';
    if (!['docx', 'epub', 'pdf', 'md'].includes(fmt)) {
      return res.status(400).json({ error: 'outputFormat must be docx|epub|pdf|md' });
    }

    // Compile the manuscript first so Format Pro has an input file.
    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters to format.' });

    const { join: j, resolve: r } = await import('path');
    const { mkdir: mkd, writeFile: wf } = await import('fs/promises');
    const tmpDir = j(baseDir, 'workspace', 'tmp', 'format-input');
    await mkd(tmpDir, { recursive: true });
    const inputPath = j(tmpDir, `${project.id}.md`);
    const manuscript = chapters.map(c => `# Chapter ${c.number}: ${c.title}\n\n${c.text}`).join('\n\n');
    await wf(inputPath, manuscript, 'utf-8');

    const result = await tools.runFormatPro({
      manuscriptPath: r(inputPath),
      outputFormat: fmt,
      title: project.title,
      author: author || 'Anonymous',
      trimSize,
    });
    res.json(result);
  });

  // ═══════════════════════════════════════════════════════════
  // Cover Typography — overlay title/author on an AI-generated PNG
  // ═══════════════════════════════════════════════════════════

  app.post('/api/covers/apply-typography', async (req: Request, res: Response) => {
    const typo = services.coverTypography;
    if (!typo) return res.status(503).json({ error: 'Cover typography service not initialized' });

    const { imagePath, title, author, subtitle, seriesBadge, genre, titleColor, authorColor, width, height } = req.body || {};
    if (!imagePath || !title || !author) {
      return res.status(400).json({ error: 'imagePath, title, and author are required' });
    }

    // Harden against path traversal — imagePath must be inside workspace.
    // safePath handles absolute inputs (resolve(base, absPath) === absPath) and
    // rejects anything that escapes workspace/, with Windows case + separator
    // normalization via the shared helper.
    const workspaceDir = path.join(baseDir, 'workspace');
    const resolved = safePath(workspaceDir, String(imagePath));
    if (!resolved) {
      return res.status(400).json({ error: 'imagePath must be inside workspace/' });
    }

    try {
      const result = await typo.apply({
        imagePath: resolved, title, author, subtitle, seriesBadge, genre,
        titleColor, authorColor, width, height,
      });
      if (!result.success) return res.status(500).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Typography failed' });
    }
  });

}

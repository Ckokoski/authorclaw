/**
 * projects routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { resolveStepOutputPath, listProjectOutputFiles } from '../../services/project-paths.js';

export function registerProjectRoutes(ctx: ApiContext): void {
  const { app, gateway, services, workspaceDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Project Engine (autonomous project-based task planning)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/templates', async (_req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    // Merge built-in templates with custom templates
    const builtIn = engine.getTemplates();
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(workspaceDir, '.config', 'custom-project-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    const customMapped = custom.map((t: any) => ({
      ...t, label: t.title, stepCount: 0, custom: true,
    }));
    res.json({ templates: [...builtIn, ...customMapped] });
  });

  // Save a custom project template
  app.post('/api/projects/templates', async (req: Request, res: Response) => {
    const { title, description, type } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { randomBytes } = await import('crypto');
    const configDir = j(workspaceDir, '.config');
    await mkd(configDir, { recursive: true });
    const customPath = j(configDir, 'custom-project-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    custom.push({ id: randomBytes(6).toString('hex'), title, description, type: type || 'general', createdAt: new Date().toISOString() });
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Delete a custom project template
  app.delete('/api/projects/templates/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(workspaceDir, '.config', 'custom-project-templates.json');
    if (!ex(customPath)) {
      return res.json({ success: false, error: 'No custom templates' });
    }
    let custom: any[] = [];
    try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    custom = custom.filter((t: any) => t.id !== req.params.id);
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Create a new project — supports dynamic AI planning
  app.post('/api/projects/create', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const { type, title, description, context, planning, config, personaId, preferredProvider } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }

    // Helper to set optional fields on newly created projects
    const applyProjectOptions = (project: any) => {
      if (personaId) project.personaId = personaId;
      if (preferredProvider) project.preferredProvider = preferredProvider;
    };

    // ── Chapter-count + words-per-chapter field aliasing ──
    // Bug fix (2026-04): the dashboard sends `chapters` and `wordsPerChapter`
    // at the top level, but createBookProduction / createNovelPipeline expect
    // `config.targetChapters` and `config.targetWordsPerChapter`. Without this
    // translation, projects silently default to 25 chapters / 3000 words
    // regardless of what the user typed in the modal.
    const resolvedConfig: any = { ...(config || context || {}) };
    if (req.body.chapters !== undefined && resolvedConfig.targetChapters === undefined) {
      const n = Number(req.body.chapters);
      if (Number.isFinite(n) && n > 0) resolvedConfig.targetChapters = n;
    }
    if (req.body.wordsPerChapter !== undefined && resolvedConfig.targetWordsPerChapter === undefined) {
      const n = Number(req.body.wordsPerChapter);
      if (Number.isFinite(n) && n > 0) resolvedConfig.targetWordsPerChapter = n;
    }

    // Novel pipeline: use dedicated pipeline builder
    // Trust the explicitly-sent type; only infer from description if no type provided
    const inferredType = type || engine.inferProjectType(description);
    if (inferredType === 'novel-pipeline') {
      const project = engine.createNovelPipeline(title, description, resolvedConfig);
      applyProjectOptions(project);
      return res.json({ project, planning: 'novel-pipeline' });
    }

    // Book Production: uses dynamic chapter generation
    if (inferredType === 'book-production') {
      const project = engine.createBookProduction(title, description, resolvedConfig);
      applyProjectOptions(project);
      return res.json({ project, planning: 'book-production' });
    }

    // Dynamic planning: ask the AI to figure out the steps
    if (planning === 'dynamic') {
      const skillCatalog = services.skills.getSkillCatalog();
      const authorOSTools = services.authorOS?.getAvailableTools() || [];
      const project = await engine.planProject(title, description, skillCatalog, authorOSTools, context);
      applyProjectOptions(project);
      return res.json({ project, planning: 'dynamic' });
    }

    // Template-based fallback
    const projectType = inferredType;
    const project = engine.createProject(projectType, title, description, context);
    applyProjectOptions(project);
    res.json({ project, planning: 'template' });
  });

  // ── Pipeline Creation (chains all 6 phases) ──
  app.post('/api/pipeline/create', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const { title, description, personaId, config } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    try {
      const result = engine.createPipeline(title, description, personaId, config);
      res.json({
        pipelineId: result.pipelineId,
        phases: result.projects.map((p: any) => ({
          id: p.id,
          type: p.type,
          title: p.title,
          phase: p.pipelinePhase,
          steps: p.steps.length,
          status: p.status,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create pipeline: ' + String(err) });
    }
  });

  // ── Pipeline Status ──
  app.get('/api/pipeline/:pipelineId', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const projects = engine.getPipelineProjects(req.params.pipelineId);
    if (projects.length === 0) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    res.json({
      pipelineId: req.params.pipelineId,
      phases: projects.map((p: any) => ({
        id: p.id,
        type: p.type,
        title: p.title,
        phase: p.pipelinePhase,
        steps: p.steps.length,
        completedSteps: p.steps.filter((s: any) => s.status === 'completed' || s.status === 'skipped').length,
        status: p.status,
        progress: p.progress,
      })),
    });
  });

  app.get('/api/projects/list', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const status = (req.query as any).status;
    res.json({ projects: engine.listProjects(status) });
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // `activeSteps`: convenience list of every currently-running step so the
    // orchestra view can show 1–N live worker cards under the conductor engine
    // (multiple steps can be 'active' concurrently now). Truthful mirror of
    // project.steps[status==='active'].
    const activeSteps = project.steps
      .filter((s: any) => s.status === 'active')
      .map((s: any) => ({
        id: s.id, label: s.label, phase: s.phase,
        chapterNumber: s.chapterNumber, taskType: s.taskType,
      }));
    res.json({ project, activeSteps });
  });

  app.post('/api/projects/:id/start', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const step = engine.startProject(req.params.id);
    if (!step) {
      return res.status(404).json({ error: 'Project not found or no pending steps' });
    }
    res.json({ step, project: engine.getProject(req.params.id) });
  });

  // Single-step execution. All retry/failure-detection/response-shape logic now
  // lives in ProjectEngine.executeStepWithRetry — this handler just parses the
  // request, calls the engine, and maps the result to the original HTTP shapes.
  app.post('/api/projects/:id/execute', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }

    const result = await engine.executeStepWithRetry(req.params.id);

    if ('gated' in result && result.gated) {
      return res.json({
        success: true,
        gated: true,
        step: result.step,
        project: result.project,
      });
    }

    if (result.ok) {
      return res.json({
        success: true,
        completedStep: result.completedStep,
        response: result.response,
        nextStep: result.nextStep,
        project: result.project,
      });
    }

    switch (result.kind) {
      case 'no-project':
        return res.status(404).json({ error: 'Project not found' });
      case 'no-active-step':
        return res.status(400).json({ error: 'No active step. Start the project first.' });
      case 'provider-failure':
        return res.json({
          success: false,
          error: 'AI provider failure — see detail',
          detail: result.detail,
          project: result.project,
        });
      case 'short-response':
        return res.json({
          success: false,
          error: result.reason,
          project: result.project,
        });
      case 'error':
        return res.status(500).json({
          error: 'Step execution failed: ' + result.error,
          project: result.project,
        });
    }
  });

  // Auto-execute ALL steps of a project (fully autonomous mode)
  // ── Retry a single step (reset failed/completed → pending) ──
  // Useful when a step failed and the user wants to retry without restarting
  // the whole project. Optionally deletes the previous output file.
  app.post('/api/projects/:id/steps/:stepId/retry', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const step = engine.retryStep(req.params.id, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    // Optionally delete the step's output file so the next run starts clean.
    if (req.body?.deleteOutputFile) {
      try {
        const { unlink } = await import('fs/promises');
        const { join: jp } = await import('path');
        // Resolve the real path (ALP-1548) — deleting a hand-built flat path
        // silently no-opped for anything written into the per-phase dir, so
        // "start clean" left the old output in place.
        await unlink(resolveStepOutputPath(workspaceDir, project, step)).catch(() => {});
      } catch { /* non-fatal */ }
    }

    res.json({ step, project: engine.getProject(req.params.id) });
  });

  // ── Restart the whole project ──
  // Resets failed/active (and optionally completed) steps to pending so the
  // user can re-run from a clean state. Optionally deletes all output files.
  app.post('/api/projects/:id/restart', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const keepCompleted = !!req.body?.keepCompleted;
    const result = engine.restartProject(req.params.id, { keepCompleted });
    if (!result) return res.status(404).json({ error: 'Project not found' });

    if (req.body?.deleteOutputFiles) {
      try {
        const { rm } = await import('fs/promises');
        const { readdirSync, existsSync: ex } = await import('fs');
        const { join: jp } = await import('path');
        // Sweep BOTH the per-phase and legacy dirs (ALP-1548) — restarting a
        // project that had only flat-dir cleanup left every new output behind.
        for (const { name: f, path: filePath } of listProjectOutputFiles(workspaceDir, project)) {
          // Only delete .md files, preserve manuscript / compiled-output / revised files
          // unless restart is full (no keepCompleted).
          if (!f.endsWith('.md')) continue;
          if (keepCompleted && (f === 'manuscript.md' || f === 'compiled-output.md' || f === 'revised-manuscript.md' || f === 'revision-report.md')) continue;
          await rm(filePath).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    res.json(result);
  });

  app.post('/api/projects/:id/auto-execute', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.status === 'pending') {
      engine.startProject(req.params.id);
    } else if (project.status === 'paused') {
      project.status = 'active';
      const firstPending = project.steps.find((s: any) => s.status === 'pending');
      if (firstPending) firstPending.status = 'active';
    }

    // The full autonomous loop — retry, word-count continuation, quality loop,
    // file save, and the context-engine / auto-narrate / assembly hooks — now
    // lives in ProjectEngine.autoExecuteLoop. It re-checks pause/complete state
    // internally so /pause and /stop keep working during long runs.
    const { results } = await engine.autoExecuteLoop(req.params.id, { workspaceDir });

    const finalProject = engine.getProject(req.params.id);
    const activeSteps = (finalProject?.steps || [])
      .filter((s: any) => s.status === 'active')
      .map((s: any) => ({
        id: s.id, label: s.label, phase: s.phase,
        chapterNumber: s.chapterNumber, taskType: s.taskType,
      }));

    res.json({
      success: true,
      results,
      project: finalProject,
      activeSteps,
    });
  });


  app.post('/api/projects/:id/skip/:stepId', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const nextStep = engine.skipStep(req.params.id, req.params.stepId);
    res.json({ nextStep, project: engine.getProject(req.params.id) });
  });

  app.post('/api/projects/:id/pause', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    engine.pauseProject(req.params.id);
    res.json({ project: engine.getProject(req.params.id) });
  });

  // ── Resume a stuck/completed project that still has pending or active steps ──
  app.post('/api/projects/:id/resume', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Fix orphaned active steps — reset all but the first to pending
    const activeSteps = project.steps.filter((s: any) => s.status === 'active');
    if (activeSteps.length > 1) {
      // Keep only the first active step, reset the rest to pending
      for (let i = 1; i < activeSteps.length; i++) {
        activeSteps[i].status = 'pending';
      }
    }

    // If all remaining steps are 'pending' but none are 'active', activate the first one
    const hasActive = project.steps.some((s: any) => s.status === 'active');
    if (!hasActive) {
      const nextPending = project.steps.find((s: any) => s.status === 'pending');
      if (nextPending) nextPending.status = 'active';
    }

    // Set project status back to active
    const remaining = project.steps.filter((s: any) => s.status === 'pending' || s.status === 'active');
    if (remaining.length > 0) {
      project.status = 'active';
      delete (project as any).completedAt;
      project.updatedAt = new Date().toISOString();
    }

    // Recalculate progress
    const done = project.steps.filter((s: any) => s.status === 'completed' || s.status === 'skipped').length;
    project.progress = Math.round((done / project.steps.length) * 100);

    res.json({
      resumed: true,
      status: project.status,
      progress: project.progress,
      activeStep: project.steps.find((s: any) => s.status === 'active')?.label || null,
      remainingSteps: remaining.length,
    });
  });

  // ── Update a project's preferred provider ──
  app.post('/api/projects/:id/provider', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { provider } = req.body;
    const knownProviders: string[] = typeof services.aiRouter?.getKnownProviders === 'function'
      ? services.aiRouter.getKnownProviders()
      : ['gemini', 'deepseek', 'claude', 'openai', 'ollama'];
    const valid = [...knownProviders, '', null];
    if (!valid.includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    (project as any).preferredProvider = provider || undefined;
    project.updatedAt = new Date().toISOString();
    res.json({ success: true, preferredProvider: (project as any).preferredProvider || null });
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }

    // Get project info before deleting (to find files on disk)
    const project = engine.getProject(req.params.id);
    const deleteFiles = req.query.files === 'true';

    const deleted = engine.deleteProject(req.params.id);

    // Optionally delete workspace files too
    let filesDeleted = 0;
    if (deleted && deleteFiles && project) {
      try {
        const { join: j } = await import('path');
        const { rm } = await import('fs/promises');
        const { existsSync: ex } = await import('fs');
        const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const projectDir = j(workspaceDir, 'projects', projectSlug);
        if (ex(projectDir)) {
          const { readdir } = await import('fs/promises');
          const entries = await readdir(projectDir);
          filesDeleted = entries.length;
          await rm(projectDir, { recursive: true });
        }
      } catch { /* non-fatal */ }
    }

    res.json({ success: deleted, filesDeleted });
  });

}

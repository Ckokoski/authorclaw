/**
 * manuscript-quality routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';
import { safePath, gatherChapters } from '../context.js';

export function registerManuscriptQualityRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir, workspaceDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Manuscript Hub — aggregated dashboard stats
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hub', async (_req: Request, res: Response) => {
    const hub = services.manuscriptHub;
    const engine = gateway.getProjectEngine?.();
    const activityLog = gateway.getActivityLog?.();
    if (!hub || !engine || !activityLog) {
      return res.status(503).json({ error: 'Manuscript hub services not initialized' });
    }
    try {
      const projects = engine.listProjects();
      const dailyWordGoal = services.config.get('autonomous.dailyWordGoal', 1000) || 1000;
      const report = await hub.build(projects, activityLog, dailyWordGoal);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Hub build failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Beta Reader + Dialogue Auditor
  // ═══════════════════════════════════════════════════════════
  // NOTE: gatherChapters (helper: gather completed writing-phase chapters for
  // a project) is imported from ../context.js — it is shared with
  // external-covers.ts, matching the original routes.ts where both sections
  // called the same module-scope `gatherChapters` closure.

  // Get available beta reader archetypes
  app.get('/api/beta-reader/archetypes', (_req: Request, res: Response) => {
    const beta = services.betaReader;
    if (!beta) return res.json({ archetypes: [] });
    res.json({ archetypes: beta.getArchetypes() });
  });

  // Run beta reader panel on a project (async — uses SSE/socket for progress)
  app.post('/api/projects/:id/beta-reader', async (req: Request, res: Response) => {
    const beta = services.betaReader;
    if (!beta) return res.status(503).json({ error: 'Beta reader not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No completed chapters found. Write some chapters first.' });
    }

    const archetypes = Array.isArray(req.body?.archetypes) && req.body.archetypes.length > 0
      ? req.body.archetypes
      : undefined;

    // Respond immediately — client subscribes to progress via socket.
    res.json({ status: 'started', chapters: chapters.length, archetypes: (archetypes || beta.getArchetypes()).length });

    const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
    const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);

    (async () => {
      try {
        const report = await beta.scanManuscript(
          project.id, chapters, aiCompleteFn, aiSelectFn, archetypes,
          (msg: string) => {
            try { (gateway as any).io?.emit?.('beta-reader-progress', { projectId: project.id, message: msg }); } catch {}
          }
        );
        // Store the report alongside context data.
        try {
          const { join: j } = await import('path');
          const { writeFile: wf, mkdir: mkd } = await import('fs/promises');
          const dir = j(baseDir, 'workspace', 'beta-reports');
          await mkd(dir, { recursive: true });
          await wf(j(dir, `${project.id}.json`), JSON.stringify(report, null, 2));
        } catch { /* non-fatal */ }
        try { (gateway as any).io?.emit?.('beta-reader-complete', { projectId: project.id, report }); } catch {}
      } catch (err: any) {
        try { (gateway as any).io?.emit?.('beta-reader-error', { projectId: project.id, error: err?.message || String(err) }); } catch {}
      }
    })();
  });

  // Get the stored beta-reader report
  app.get('/api/projects/:id/beta-reader/report', async (req: Request, res: Response) => {
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    // req.params.id is user-controlled and joined into a filename — constrain
    // to the beta-reports directory to block traversal (e.g. ../../ or null byte).
    const betaDir = path.join(baseDir, 'workspace', 'beta-reports');
    const file = safePath(betaDir, `${req.params.id}.json`);
    if (!file) return res.status(400).json({ error: 'Invalid project id' });
    if (!ex(file)) return res.json({ report: null });
    try {
      const raw = await rf(file, 'utf-8');
      res.json({ report: JSON.parse(raw) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not read report' });
    }
  });

  // Run dialogue audit on a project
  app.post('/api/projects/:id/dialogue-audit', async (req: Request, res: Response) => {
    const auditor = services.dialogueAuditor;
    if (!auditor) return res.status(503).json({ error: 'Dialogue auditor not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No completed chapters found.' });
    }

    // Combine all chapters then audit across the whole manuscript.
    const combined = chapters.map(c => `# ${c.title}\n\n${c.text}`).join('\n\n');
    try {
      const report = auditor.audit(combined, project.id);
      res.json({ report });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Audit failed' });
    }
  });

  // Export the active blurb from a project's compiled output, if present
  app.post('/api/projects/:id/export-blurb', async (req: Request, res: Response) => {
    const exporter = services.kdpExporter;
    if (!exporter) return res.status(503).json({ error: 'KDP exporter not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Priority: req.body.blurb > the most recent step whose label contains "blurb"
    let blurb: string | undefined = req.body?.blurb;
    if (!blurb) {
      const blurbStep = [...project.steps].reverse().find((s: any) =>
        /blurb|description/i.test(s.label) && s.status === 'completed' && s.result
      );
      blurb = blurbStep?.result;
    }
    if (!blurb) {
      return res.status(400).json({ error: 'No blurb found. Pass { blurb: "..." } or run the blurb-writer skill first.' });
    }
    try {
      const result = exporter.exportBlurb(blurb);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Export failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Wave 2: Goals, Series Bible, Craft Critic, Audiobook, Style Clone
  // ═══════════════════════════════════════════════════════════

  // ── Author Goals ──

  app.get('/api/goals', (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.json({ goals: [] });
    const status = req.query.status as any;
    const type = req.query.type as any;
    const list = goals.listGoals({ status, type });
    const withProgress = list.map((g: any) => goals.computeProgress(g.id)).filter(Boolean);
    res.json({ goals: withProgress });
  });

  app.post('/api/goals', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const { type, title, description, target, unit, deadline, projectIds } = req.body || {};
    if (!type || !title || !target || !unit || !deadline) {
      return res.status(400).json({ error: 'type, title, target, unit, deadline required' });
    }
    try {
      const goal = await goals.createGoal({ type, title, description, target, unit, deadline, projectIds });
      res.json({ goal });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Create failed' });
    }
  });

  app.post('/api/goals/:id/progress', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const { current } = req.body || {};
    if (typeof current !== 'number') return res.status(400).json({ error: 'current (number) required' });
    const result = await goals.updateProgress(req.params.id, current, 'manual');
    if (!result) return res.status(404).json({ error: 'Goal not found' });
    res.json({ goal: result, progress: goals.computeProgress(req.params.id) });
  });

  app.post('/api/goals/:id/status', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const { status } = req.body || {};
    if (!['active', 'paused', 'completed', 'missed'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|paused|completed|missed' });
    }
    const result = await goals.setStatus(req.params.id, status);
    if (!result) return res.status(404).json({ error: 'Goal not found' });
    res.json({ goal: result });
  });

  app.delete('/api/goals/:id', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const removed = await goals.removeGoal(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true });
  });

  // ── Series Bible ──

  app.get('/api/series', (_req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.json({ series: [] });
    res.json({ series: sb.listSeries() });
  });

  app.post('/api/series', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { title, description, projectIds, readingOrder } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
      const series = await sb.createSeries({ title, description, projectIds, readingOrder });
      res.json({ series });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Create failed' });
    }
  });

  app.post('/api/series/:id/add-project', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const result = await sb.addProject(req.params.id, projectId);
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  });

  app.post('/api/series/:id/remove-project', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const result = await sb.removeProject(req.params.id, projectId);
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  });

  app.post('/api/series/:id/reading-order', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order (array of projectIds) required' });
    const result = await sb.setReadingOrder(req.params.id, order);
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  });

  app.get('/api/series/:id/report', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    const ctxEngine = services.contextEngine;
    const engine = gateway.getProjectEngine?.();
    if (!sb || !ctxEngine || !engine) {
      return res.status(503).json({ error: 'Series bible services not initialized' });
    }
    try {
      const resolver = (pid: string) => engine.getProject(pid)?.title;
      const report = await sb.buildReport(req.params.id, ctxEngine, resolver);
      if (!report) return res.status(404).json({ error: 'Series not found' });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Report failed' });
    }
  });

  app.delete('/api/series/:id', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const removed = await sb.deleteSeries(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Series not found' });
    res.json({ success: true });
  });

  // ── Craft Critic ──

  app.post('/api/projects/:id/craft-critique', async (req: Request, res: Response) => {
    const critic = services.craftCritic;
    if (!critic) return res.status(503).json({ error: 'Craft critic not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });
    try {
      const report = critic.analyze(project.id, chapters);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Critique failed' });
    }
  });

  // ── Audiobook Prep ──

  app.post('/api/projects/:id/audiobook/cleanup', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    if (!prep) return res.status(503).json({ error: 'Audiobook prep not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });

    const combined = chapters.map(c => `# Chapter ${c.number}: ${c.title}\n\n${c.text}`).join('\n\n');
    const result = prep.cleanupScript(combined);
    res.json(result);
  });

  app.post('/api/projects/:id/audiobook/pronunciation', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    const ctxEngine = services.contextEngine;
    if (!prep || !ctxEngine) return res.status(503).json({ error: 'Services not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    const combined = chapters.map(c => c.text).join('\n\n');
    try {
      const ctx = await ctxEngine.loadContext(req.params.id);
      const dict = prep.buildPronunciationDictionary(req.params.id, ctx.entities, combined);
      res.json({ dictionary: dict });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Pronunciation extraction failed' });
    }
  });

  app.post('/api/projects/:id/audiobook/ssml', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    const ctxEngine = services.contextEngine;
    if (!prep || !ctxEngine) return res.status(503).json({ error: 'Services not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const aiDisclosed = !!(project as any).aiNarrationDisclosed || !!req.body?.aiNarrationDisclosed;
    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });
    try {
      const ctx = await ctxEngine.loadContext(req.params.id);
      const combined = chapters.map(c => c.text).join('\n\n');
      const dict = prep.buildPronunciationDictionary(req.params.id, ctx.entities, combined);

      // Apply cleanup then build SSML.
      const cleanedChapters = chapters.map(c => {
        const { cleanedText } = prep.cleanupScript(c.text);
        return { number: c.number, title: c.title, text: cleanedText };
      });

      const result = prep.buildSSML(cleanedChapters, dict, aiDisclosed);
      res.json({ ...result, disclosureRequired: !aiDisclosed, disclosureIncluded: aiDisclosed });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'SSML build failed' });
    }
  });

  // ── Multi-voice audiobook attribution ──

  /**
   * POST /api/projects/:id/audiobook/attribute
   *   Body: { chapterNumber?, voiceMap?, customVoices? }
   *   - chapterNumber: which chapter to attribute (default = all)
   *   - voiceMap: optional explicit map { narratorVoice, characterVoices, defaultCharacterVoice }
   *   - customVoices: optional partial map merged into auto-assigned voices
   *
   * Returns per-chapter MultiVoiceScript with attributed segments. The
   * dashboard can then call /api/audio/generate per segment using the
   * resolved voiceId.
   */
  app.post('/api/projects/:id/audiobook/attribute', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    const ctxEngine = services.contextEngine;
    const tts = services.tts;
    if (!prep || !ctxEngine || !tts) return res.status(503).json({ error: 'Required services not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const ctx = await ctxEngine.loadContext(req.params.id);
      const characterNames = ctx.entities
        .filter((e: any) => e.type === 'character')
        .map((e: any) => e.name);

      // Build voice map: caller-provided > auto-distributed defaults.
      const presetIds = tts.listPresets().map((p: any) => p.voice);
      const narratorVoice = req.body?.voiceMap?.narratorVoice || tts.getActiveVoice();
      const voiceMap = req.body?.voiceMap || prep.buildDefaultVoiceMap({
        characterNames,
        presetVoiceIds: presetIds,
        narratorVoice,
        customVoices: req.body?.customVoices || {},
      });

      const chapters = await gatherChapters(workspaceDir, project);
      if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });

      const targetCh = req.body?.chapterNumber;
      const filtered = targetCh ? chapters.filter((c: any) => c.number === targetCh) : chapters;

      const scripts = filtered.map((c: any) =>
        prep.attributeMultiVoice({
          chapterNumber: c.number,
          title: c.title,
          text: c.text,
          characterNames,
          voiceMap,
        })
      );

      res.json({
        voiceMap,
        scripts,
        characters: characterNames,
        unmappedSpeakers: Array.from(new Set(scripts.flatMap((s: any) => s.unmappedSpeakers))).sort(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Attribution failed' });
    }
  });

  // ── Style Clone ──

  app.post('/api/style-clone/analyze', (req: Request, res: Response) => {
    const sc = services.styleClone;
    if (!sc) return res.status(503).json({ error: 'Style clone not initialized' });
    const { text, source } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) required' });
    try {
      const profile = sc.analyze(text, source || 'manual-paste');
      res.json({ profile });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Analysis failed' });
    }
  });

  app.post('/api/projects/:id/style-clone', async (req: Request, res: Response) => {
    const sc = services.styleClone;
    if (!sc) return res.status(503).json({ error: 'Style clone not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(workspaceDir, project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });
    const combined = chapters.map(c => c.text).join('\n\n');
    try {
      const profile = sc.analyze(combined, `project:${project.id}`);
      res.json({ profile });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Analysis failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GEPA-style Reflective Prose Evolution
  // ═══════════════════════════════════════════════════════════
  // Iteratively improves a prose passage using the WritingJudge as a fitness
  // signal: score → reflect (diagnose 2-3 highest-leverage fixes) → revise
  // (voice-preserving) → re-score. Keeps only candidates that strictly beat the
  // running best (Pareto / no-regression); varies the reflection angle after a
  // non-improving round; stops after 2 non-improving rounds. Returns an
  // auditable EvolutionResult (original vs best score, per-round trace, cost).
  //
  // Cost: ~3 AI calls per round (score + reflect + revise) plus 1 initial score.
  // Rounds default 3, hard-capped at 5. Never throws — on any AI failure it
  // returns the best-so-far (falling back to the original) with a warning.

  /**
   * POST /api/prose/evolve { passage, projectId?, goal?, rounds?, preserveVoice? }
   *   503 if the evolver or the judge (its fitness function) is unavailable.
   *   400 if the passage is missing or too short (< 40 chars).
   */
  app.post('/api/prose/evolve', async (req: Request, res: Response) => {
    const evolver = services.proseEvolver;
    const judge = services.writingJudge;
    if (!evolver || !judge) {
      return res.status(503).json({ error: 'Prose evolver or writing judge not initialized' });
    }

    const passage = typeof req.body?.passage === 'string' ? req.body.passage : '';
    if (!passage || passage.trim().length < 40) {
      return res.status(400).json({ error: 'passage (string, at least 40 characters) required' });
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
    const goal = typeof req.body?.goal === 'string' ? req.body.goal : undefined;
    const rounds = typeof req.body?.rounds === 'number' ? req.body.rounds : undefined;
    const preserveVoice = req.body?.preserveVoice !== false; // default true

    // Hydrate the project's CORE memory cache so voice-consistent revisions can
    // read it (best-effort — evolve() degrades gracefully if it's empty).
    if (projectId && services.contextEngine) {
      try { await services.contextEngine.loadContext(projectId); } catch { /* anchorless is fine */ }
    }

    const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
    const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);

    try {
      const result = await evolver.evolve(
        { passage, projectId, goal, rounds, preserveVoice },
        {
          writingJudge: judge,
          aiComplete: aiCompleteFn,
          aiSelectProvider: aiSelectFn,
          soul: services.soul ?? null,
          memoryTier: services.memoryTier ?? null,
        },
      );
      res.json(result);
    } catch (err: any) {
      // evolve() is designed never to throw, but guard the closure construction.
      res.status(500).json({ error: err?.message || 'Prose evolution failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Specialist Revision Passes — one prioritized findings report
  // ═══════════════════════════════════════════════════════════
  // Runs the coordinated set of narrow expert passes (continuity, voice,
  // craft, anti-slop) and aggregates them into a single RevisionReport. Each
  // pass routes to its own cost-appropriate tier; anti-slop is free/mechanical
  // (works with no API keys configured).

  /**
   * POST /api/revision/analyze { chapterText, projectId?, chapterId?, passes? }
   *   Body-driven — score arbitrary chapter text. projectId is optional; when
   *   omitted, project-scoped passes (continuity, voice) skip gracefully and
   *   the mechanical anti-slop + craft passes still run.
   */
  app.post('/api/revision/analyze', async (req: Request, res: Response) => {
    const orchestrator = services.revisionOrchestrator;
    if (!orchestrator) return res.status(503).json({ error: 'Revision orchestrator not initialized' });
    const { chapterText, projectId, chapterId, passes } = req.body || {};
    if (!chapterText || typeof chapterText !== 'string') {
      return res.status(400).json({ error: 'chapterText (string) required' });
    }
    try {
      const report = await orchestrator.analyze({
        chapterText,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        chapterId: typeof chapterId === 'string' ? chapterId : undefined,
        passes: Array.isArray(passes) ? passes : undefined,
      });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Revision analysis failed' });
    }
  });

  /**
   * POST /api/projects/:id/revision-report { chapterText?, chapterId?, passes? }
   *   Project-scoped. Runs the full specialist set against the project's entity
   *   DB (enables continuity + voice passes). chapterText may be passed
   *   explicitly; otherwise the project's completed chapters are combined.
   */
  app.post('/api/projects/:id/revision-report', async (req: Request, res: Response) => {
    const orchestrator = services.revisionOrchestrator;
    if (!orchestrator) return res.status(503).json({ error: 'Revision orchestrator not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let chapterText: string | undefined =
      typeof req.body?.chapterText === 'string' ? req.body.chapterText : undefined;
    if (!chapterText) {
      const chapters = await gatherChapters(workspaceDir, project);
      if (chapters.length === 0) {
        return res.status(400).json({ error: 'No chapterText provided and no completed chapters found.' });
      }
      chapterText = chapters.map(c => `# ${c.title}\n\n${c.text}`).join('\n\n');
    }

    try {
      const report = await orchestrator.analyze({
        chapterText,
        projectId: project.id,
        chapterId: typeof req.body?.chapterId === 'string' ? req.body.chapterId : undefined,
        passes: Array.isArray(req.body?.passes) ? req.body.passes : undefined,
      });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Revision analysis failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Active Contradiction Detection — evidence-chained consistency checker
  // ═══════════════════════════════════════════════════════════
  // Diffs a chapter against the project's persisted entity DB (attributes +
  // change-log) and prior chapter summaries, returning categorized,
  // evidence-backed contradictions (ConStory taxonomy). ONE mid-tier
  // ('consistency') AI call. A report may be empty if no entities are cached
  // for the project yet — extract entities on the chapters first.

  /**
   * POST /api/projects/:id/contradictions { chapterText, chapterId? }
   *   Runs the ContradictionDetector against the project's entity DB + prior
   *   summaries. chapterText required. 503 if the detector/context engine is
   *   unavailable. 404 if the project is unknown.
   */
  app.post('/api/projects/:id/contradictions', async (req: Request, res: Response) => {
    const detector = services.contradictionDetector;
    const ctxEngine = services.contextEngine;
    if (!detector || !ctxEngine) {
      return res.status(503).json({ error: 'Contradiction detector not initialized' });
    }

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapterText: string | undefined =
      typeof req.body?.chapterText === 'string' ? req.body.chapterText : undefined;
    if (!chapterText || chapterText.trim().length === 0) {
      return res.status(400).json({ error: 'chapterText (string) required' });
    }
    const chapterId = typeof req.body?.chapterId === 'string' ? req.body.chapterId : undefined;

    try {
      // Load the canonical entity DB + summaries the detector diffs against.
      // loadContext hydrates the in-memory cache; the pure getters read from it.
      await ctxEngine.loadContext(req.params.id);
      const entities = ctxEngine.getEntities(req.params.id);
      const priorSummaries = ctxEngine.getSummaries(req.params.id);

      const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
      const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);

      const report = await detector.detect(
        { projectId: req.params.id, chapterText, chapterId, priorSummaries, entities },
        aiCompleteFn,
        aiSelectFn,
      );
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Contradiction detection failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Character Persona Agents — per-character dialogue self-critique
  // ═══════════════════════════════════════════════════════════
  // Each major character becomes a standing critic of their OWN dialogue in a
  // chapter, flagging off-voice / anachronistic-knowledge / off-motivation
  // lines with in-voice rewrites. ONE mid-tier ('style_analysis') AI call per
  // reviewed character, capped at the top speakers. The knowledge horizon is
  // derived from which chapters each character has appeared in (per the entity
  // DB + chapter summaries). A report may be empty if no character entities are
  // cached yet — extract entities on the chapters first.

  /**
   * POST /api/projects/:id/character-critique { chapterText, chapterId?, characters? }
   *   Runs the character persona agents against the project's character entity
   *   DB + chapter summaries. chapterText required. Optional `characters` filters
   *   to specific characters (by name/alias). 503 if the agent/context engine is
   *   unavailable. 404 if the project is unknown. 400 if chapterText is missing.
   */
  app.post('/api/projects/:id/character-critique', async (req: Request, res: Response) => {
    const agent = services.characterAgent;
    const ctxEngine = services.contextEngine;
    if (!agent || !ctxEngine) {
      return res.status(503).json({ error: 'Character agent not initialized' });
    }

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapterText: string | undefined =
      typeof req.body?.chapterText === 'string' ? req.body.chapterText : undefined;
    if (!chapterText || chapterText.trim().length === 0) {
      return res.status(400).json({ error: 'chapterText (string) required' });
    }
    const chapterId = typeof req.body?.chapterId === 'string' ? req.body.chapterId : undefined;
    const characters = Array.isArray(req.body?.characters)
      ? req.body.characters.filter((c: any) => typeof c === 'string')
      : undefined;

    try {
      // Hydrate the in-memory cache, then read the canonical entity DB +
      // summaries (pure getters — never AI-call, never throw).
      await ctxEngine.loadContext(req.params.id);
      const entities = ctxEngine.getEntities(req.params.id);
      const summaries = ctxEngine.getSummaries(req.params.id);

      const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
      const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);

      const report = await agent.critiqueDialogue(
        { projectId: req.params.id, chapterText, chapterId, characters },
        aiCompleteFn,
        aiSelectFn,
        entities,
        summaries,
      );
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Character critique failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Learn-from-experience — distil recurring flags into durable lessons
  // ═══════════════════════════════════════════════════════════
  // Aggregates the RECURRING findings across the quality tools' reports and
  // writes them as lessons into the LessonStore. Those lessons already inject
  // into the writing system prompt (message-pipeline "# Lessons Learned"), so
  // learning here feeds forward into the next draft — the loop closes. CODE
  // aggregation + at most ONE free-tier AI phrasing call. Never throws.

  /**
   * POST /api/learn/from-reports { projectId?, reports: [{type, report}] }
   *   Learn directly from already-computed reports. `reports` is an array of
   *   { type: 'revision'|'contradiction'|'character', report }. Returns the
   *   LearnOutcome (patternsFound, lessonsAdded, lessonsSkippedDuplicate,
   *   summary). 503 if the learning service / lesson store is unavailable.
   */
  app.post('/api/learn/from-reports', async (req: Request, res: Response) => {
    const learning = services.learning;
    if (!learning || !services.lessons) {
      return res.status(503).json({ error: 'Learning service not initialized' });
    }
    const reports = Array.isArray(req.body?.reports) ? req.body.reports : null;
    if (!reports) {
      return res.status(400).json({ error: 'reports (array of {type, report}) required' });
    }
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;

    try {
      const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
      const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);
      const outcome = await learning.learnFromReports({ projectId, reports }, aiCompleteFn, aiSelectFn);
      res.json(outcome);
    } catch (err: any) {
      // learnFromReports never throws, but guard the AI-closure construction too.
      res.status(500).json({ error: err?.message || 'Learning failed' });
    }
  });

  /**
   * POST /api/projects/:id/learn { chapterText, chapterId?, characters? }
   *   Convenience one-shot: runs the revision orchestrator + contradiction
   *   detector (and character critique when available) on the provided
   *   chapterText, then learns from whatever results came back. Each tool is
   *   guarded — an unavailable or throwing tool is skipped, not fatal. Returns
   *   the LearnOutcome plus which reports fed it. 503 if learning is missing.
   */
  app.post('/api/projects/:id/learn', async (req: Request, res: Response) => {
    const learning = services.learning;
    if (!learning || !services.lessons) {
      return res.status(503).json({ error: 'Learning service not initialized' });
    }

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let chapterText: string | undefined =
      typeof req.body?.chapterText === 'string' ? req.body.chapterText : undefined;
    if (!chapterText) {
      const chapters = await gatherChapters(workspaceDir, project);
      if (chapters.length === 0) {
        return res.status(400).json({ error: 'No chapterText provided and no completed chapters found.' });
      }
      chapterText = chapters.map(c => `# ${c.title}\n\n${c.text}`).join('\n\n');
    }
    const chapterId = typeof req.body?.chapterId === 'string' ? req.body.chapterId : undefined;
    const characters = Array.isArray(req.body?.characters)
      ? req.body.characters.filter((c: any) => typeof c === 'string')
      : undefined;

    const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
    const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);

    // ── Run the quality tools, each guarded — a missing/throwing tool is
    // simply skipped so the loop still learns from whatever succeeded. ──
    const reports: Array<{ type: 'revision' | 'contradiction' | 'character'; report: any }> = [];
    const reportsRun: string[] = [];
    const reportsSkipped: string[] = [];

    // Revision orchestrator (project-scoped: enables continuity + voice passes).
    if (services.revisionOrchestrator) {
      try {
        const report = await services.revisionOrchestrator.analyze({
          chapterText, projectId: project.id, chapterId,
        });
        reports.push({ type: 'revision', report });
        reportsRun.push('revision');
      } catch { reportsSkipped.push('revision'); }
    } else {
      reportsSkipped.push('revision');
    }

    // Contradiction detector + character agent both need the entity DB.
    let entities: any[] = [];
    let summaries: any[] = [];
    if (services.contextEngine) {
      try {
        await services.contextEngine.loadContext(project.id);
        entities = services.contextEngine.getEntities(project.id);
        summaries = services.contextEngine.getSummaries(project.id);
      } catch { /* no cached context — detector/agent still run, just anchorless */ }
    }

    if (services.contradictionDetector && services.contextEngine) {
      try {
        const report = await services.contradictionDetector.detect(
          { projectId: project.id, chapterText, chapterId, priorSummaries: summaries, entities },
          aiCompleteFn, aiSelectFn,
        );
        reports.push({ type: 'contradiction', report });
        reportsRun.push('contradiction');
      } catch { reportsSkipped.push('contradiction'); }
    } else {
      reportsSkipped.push('contradiction');
    }

    if (services.characterAgent && services.contextEngine) {
      try {
        const report = await services.characterAgent.critiqueDialogue(
          { projectId: project.id, chapterText, chapterId, characters },
          aiCompleteFn, aiSelectFn, entities, summaries,
        );
        reports.push({ type: 'character', report });
        reportsRun.push('character');
      } catch { reportsSkipped.push('character'); }
    } else {
      reportsSkipped.push('character');
    }

    try {
      const outcome = await learning.learnFromReports({ projectId: project.id, reports }, aiCompleteFn, aiSelectFn);
      res.json({ ...outcome, reportsRun, reportsSkipped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Learning failed' });
    }
  });

}

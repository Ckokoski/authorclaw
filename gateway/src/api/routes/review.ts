/**
 * Review API routes (M1.5 — ALP-1559).
 *
 * Exposes the M1 gated-human-review pipeline (M1.1 doc versioning, M1.2 gate
 * state machine, M1.3 conductor wiring, M1.4 dirty dependency graph) over
 * HTTP so the whole review loop — inspect a step's version history, diff two
 * versions, approve or send back for revision, see what a change impacts
 * downstream, and configure which phases/steps gate at all — is reachable
 * without a UI (this file's own acceptance criteria: every route below is
 * curl-exercisable end to end).
 */
import { Request, Response } from 'express';
import { join } from 'path';
import type { ApiContext } from '../context.js';
import { docVersionService } from '../../services/doc-versions.js';
import { computeTransitiveDependents } from '../../services/dependency-graph.js';
import type { Project, ProjectStep } from '../../services/project-templates.js';

/** Same slugification `step-executor.ts` uses for the on-disk project directory. */
function projectDirFor(workspaceDir: string, project: Project): string {
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return join(workspaceDir, 'projects', slug);
}

/** Same slugification `step-executor.ts` uses for a step's canonical pointer file. */
function stepFileNameFor(step: ProjectStep): string {
  return `${step.id}-${step.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
}

function findStep(project: Project, stepId: unknown): ProjectStep | undefined {
  return project.steps.find((s) => s.id === stepId);
}

type DiffOp = { op: 'equal' | 'add' | 'remove'; line: string };

/**
 * Minimal line-level LCS diff — no external dependency for something this
 * small. O(n*m) on line counts, which is fine for step-output-sized documents
 * (hundreds to low thousands of lines, not whole-book manuscripts).
 */
function diffLines(fromText: string, toText: string): DiffOp[] {
  const a = fromText.split('\n');
  const b = toText.split('\n');
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'equal', line: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: 'remove', line: a[i] });
      i++;
    } else {
      ops.push({ op: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ op: 'remove', line: a[i] }); i++; }
  while (j < m) { ops.push({ op: 'add', line: b[j] }); j++; }
  return ops;
}

export function registerReviewRoutes(ctx: ApiContext): void {
  const { app, gateway, workspaceDir } = ctx;

  function getEngine(res: Response): any | null {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      res.status(503).json({ error: 'Project engine not initialized' });
      return null;
    }
    return engine;
  }

  // ═══════════════════════════════════════════════════════════
  // Cross-book review queue
  // ═══════════════════════════════════════════════════════════

  // GET /api/reviews — every step (across every project/"book") currently
  // awaiting a human decision or made stale by an upstream change. `dirty` is
  // orthogonal to status, so completed dirty steps must be selected explicitly.
  // Registered before /api/projects/:id/... below is irrelevant — this is its
  // own top-level path, no collision risk.
  app.get('/api/reviews', (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;

    const projects: Project[] = engine.listProjects();
    const queue = projects.flatMap((project) =>
      project.steps
        .filter((step) => step.status === 'awaiting_review' || Boolean(step.dirty))
        .map((step) => ({
          projectId: project.id,
          projectTitle: project.title,
          stepId: step.id,
          stepLabel: step.label,
          phase: step.phase,
          gate: step.gate,
          dirty: step.dirty,
        })),
    );

    res.json({ queue, count: queue.length });
  });

  // ═══════════════════════════════════════════════════════════
  // Step version history
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/:id/steps/:stepId/versions', async (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const projectDir = projectDirFor(workspaceDir, project);
    const canonicalPath = join(projectDir, stepFileNameFor(step));
    const versions = await docVersionService.getVersions(projectDir, step.id, canonicalPath);
    res.json({ stepId: step.id, versions });
  });

  app.get('/api/projects/:id/steps/:stepId/versions/:v', async (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const versionNumber = Number(req.params.v);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      return res.status(400).json({ error: 'Version must be a positive integer' });
    }

    const projectDir = projectDirFor(workspaceDir, project);
    const content = await docVersionService.getVersionContent(projectDir, step.id, versionNumber);
    if (content === null) return res.status(404).json({ error: `Version v${versionNumber} not found` });
    res.json({ stepId: step.id, v: versionNumber, content });
  });

  app.get('/api/projects/:id/steps/:stepId/diff', async (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      return res.status(400).json({ error: 'from and to query params must be positive integers' });
    }

    const projectDir = projectDirFor(workspaceDir, project);
    const [fromContent, toContent] = await Promise.all([
      docVersionService.getVersionContent(projectDir, step.id, from),
      docVersionService.getVersionContent(projectDir, step.id, to),
    ]);
    if (fromContent === null) return res.status(404).json({ error: `Version v${from} not found` });
    if (toContent === null) return res.status(404).json({ error: `Version v${to} not found` });

    res.json({ stepId: step.id, from, to, diff: diffLines(fromContent, toContent) });
  });

  // Manual save -> new version. Lets a reviewer edit a step's content directly
  // (e.g. a quick typo fix) without going through an agent rerun.
  app.post('/api/projects/:id/steps/:stepId/versions', async (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const { content, note } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content (non-empty string) required' });
    }

    const { writeFile, mkdir } = await import('fs/promises');
    const projectDir = projectDirFor(workspaceDir, project);
    await mkdir(projectDir, { recursive: true });
    const version = await docVersionService.appendVersion(projectDir, step.id, content, 'user', note);
    await writeFile(join(projectDir, stepFileNameFor(step)), content, 'utf-8');

    const updated = engine.saveStepResult(project.id, step.id, content);
    res.json({ stepId: step.id, version, step: updated });
  });

  // ═══════════════════════════════════════════════════════════
  // Gate decisions
  // ═══════════════════════════════════════════════════════════

  app.post('/api/projects/:id/steps/:stepId/approve', async (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });
    if (step.status !== 'awaiting_review') {
      return res.status(400).json({ error: `Step is "${step.status}", not awaiting_review` });
    }

    const projectDir = projectDirFor(workspaceDir, project);
    const currentVersion = await docVersionService.getCurrentVersion(projectDir, step.id);
    const decided = engine.decideStepGate(project.id, step.id, 'approved', currentVersion);
    res.json({ step: decided, project: engine.getProject(project.id) });
  });

  app.post('/api/projects/:id/steps/:stepId/revise', async (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const { comments, notes } = req.body || {};
    const feedback = [comments, notes].filter((s) => typeof s === 'string' && s.trim()).join('\n\n');
    if (!feedback) {
      return res.status(400).json({ error: 'comments and/or notes (string) required' });
    }

    const result = await engine.reviseStep(project.id, step.id, feedback, workspaceDir);

    if (result.ok) {
      return res.json({ success: true, response: result.response, version: result.version, project: result.project });
    }
    switch (result.kind) {
      case 'no-project':
        return res.status(404).json({ error: 'Project not found' });
      case 'no-step':
        return res.status(404).json({ error: 'Step not found' });
      case 'not-awaiting-review':
        return res.status(400).json({ error: `Step is "${step.status}", not awaiting_review` });
      case 'provider-failure':
        return res.json({ success: false, error: 'AI provider failure — see detail', detail: result.detail, project: result.project });
      case 'short-response':
        return res.json({ success: false, error: result.reason, project: result.project });
      case 'error':
        return res.status(500).json({ error: 'Revision failed: ' + result.error, project: result.project });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Downstream impact (M1.4 dependency graph)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/:id/steps/:stepId/impact', (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const dependentIds = computeTransitiveDependents(project.steps, step.id);
    const dirty = project.steps.filter((s) => dependentIds.has(s.id) && s.dirty);

    res.json({
      stepId: step.id,
      downstreamStepIds: [...dependentIds],
      dirty: dirty.map((s) => ({ stepId: s.id, label: s.label, marker: s.dirty })),
    });
  });

  app.post('/api/projects/:id/steps/:stepId/clean', (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const step = findStep(project, req.params.stepId);
    if (!step) return res.status(404).json({ error: 'Step not found' });

    const cleaned = engine.markStepClean(project.id, step.id);
    res.json({ step: cleaned });
  });

  // ═══════════════════════════════════════════════════════════
  // Gate configuration
  // ═══════════════════════════════════════════════════════════

  // PATCH /api/projects/:id/gates — { reviewGates?: {phase: bool}, stepGateOverrides?: {stepId: bool|null} }
  app.patch('/api/projects/:id/gates', (req: Request, res: Response) => {
    const engine = getEngine(res);
    if (!engine) return;
    const project: Project | undefined = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { reviewGates, stepGateOverrides } = req.body || {};
    if (reviewGates && (typeof reviewGates !== 'object' || Array.isArray(reviewGates))) {
      return res.status(400).json({ error: 'reviewGates must be an object of {phase: boolean}' });
    }
    if (stepGateOverrides && (typeof stepGateOverrides !== 'object' || Array.isArray(stepGateOverrides))) {
      return res.status(400).json({ error: 'stepGateOverrides must be an object of {stepId: boolean|null}' });
    }

    const updated = engine.updateReviewGates(project.id, { reviewGates, stepGateOverrides });
    res.json({ project: updated });
  });
}

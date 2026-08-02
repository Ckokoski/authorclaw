/**
 * Conductor engine tests — the true-parallel supervisor added to StepExecutor.
 *
 * Two surfaces are covered:
 *   1. deriveDependencies() — the conservative dependency model (rules a–d).
 *   2. autoExecuteLoop() conductor path — concurrent dispatch, chapter
 *      sequencing, failure isolation, pause responsiveness, ordered context
 *      hooks, and the concurrency cap.
 *
 * The message handler is fully STUBBED with per-step delays/results, so we can
 * assert overlap via timestamps without any real AI calls. A minimal in-memory
 * EnginePort double manages step status transitions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  StepExecutor,
  type EnginePort,
  type StepExecutorDeps,
  type MessageHandler,
  type StepServices,
} from './step-executor.js';
import {
  deriveDependencies,
  buildBookProductionSteps,
  buildNovelPipelineSteps,
  applyStepCompletion,
  type Project,
  type ProjectStep,
} from './project-templates.js';

// ═══════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════

let workspaceDir: string;
let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'conductor-'));
  workspaceDir = join(rootDir, 'workspace');
});
afterEach(() => {
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface StepCfg {
  delayMs?: number;
  respond?: string;
  fail?: boolean;         // emit an [AI provider failure] sentinel
  onStart?: () => void;   // side effect fired when this step's AI call begins
}

interface TimelineEvent { id: string; event: 'start' | 'end'; t: number; }

const LONG = 'word '.repeat(60); // 300 chars: >50 (real response) and >200 (triggers context hooks)

/** Build a stub message handler that maps `STEP:<id>` in the prompt to a config. */
function makeHandler(
  config: Record<string, StepCfg>,
  timeline: TimelineEvent[],
  liveCounter?: { cur: number; max: number },
): MessageHandler {
  return async (content, _channel, respond, _extra, _taskType) => {
    const m = content.match(/STEP:([\w-]+)/);
    const id = m ? m[1] : 'unknown';
    const cfg = config[id] || {};
    if (liveCounter) { liveCounter.cur++; liveCounter.max = Math.max(liveCounter.max, liveCounter.cur); }
    timeline.push({ id, event: 'start', t: Date.now() });
    cfg.onStart?.();
    await new Promise(r => setTimeout(r, cfg.delayMs ?? 15));
    timeline.push({ id, event: 'end', t: Date.now() });
    if (liveCounter) liveCounter.cur--;
    if (cfg.fail) { respond('[AI provider failure] simulated failure'); return; }
    respond(cfg.respond ?? LONG);
  };
}

/** Minimal EnginePort double over a single mutable project. */
function makeEngine(project: Project): EnginePort {
  return {
    getProject: (id) => (id === project.id ? project : undefined),
    completeStep: (_pid, sid, result) => {
      const s = project.steps.find(x => x.id === sid);
      if (s) { s.status = 'completed'; s.result = result; }
      // Legacy advance: activate the next pending step.
      const next = project.steps.find(x => x.status === 'pending');
      if (next) { next.status = 'active'; return next; }
      const remaining = project.steps.filter(x => x.status === 'pending' || x.status === 'active');
      if (remaining.length === 0) project.status = 'completed';
      return null;
    },
    completeStepBare: (_pid, sid, result) => {
      const s = project.steps.find(x => x.id === sid);
      if (s) { s.status = 'completed'; s.result = result; }
      const remaining = project.steps.filter(x => x.status === 'pending' || x.status === 'active');
      if (remaining.length === 0 && project.status !== 'paused') project.status = 'completed';
    },
    openStepGate: (_pid, sid, result) => {
      const s = project.steps.find(x => x.id === sid);
      if (s) applyStepCompletion(s, project, result);
    },
    activateStep: (_pid, sid) => {
      const s = project.steps.find(x => x.id === sid);
      if (s) s.status = 'active';
      return s || null;
    },
    failStep: (_pid, sid, error) => {
      const s = project.steps.find(x => x.id === sid);
      if (s) { s.status = 'failed'; s.error = error; }
    },
    buildProjectContext: async () => '',
  };
}

function makeDeps(
  handler: MessageHandler | null,
  services: StepServices = {},
  contextEngine?: any,
): StepExecutorDeps {
  return {
    getMessageHandler: () => handler,
    getStepServices: () => services,
    getContextEngine: () => contextEngine,
  };
}

/** Assemble a project from bare step descriptors (dependsOn already set). */
function makeProject(
  id: string,
  steps: Array<Partial<ProjectStep> & { id: string; dependsOn?: string[] }>,
): Project {
  return {
    id,
    type: 'book-production',
    title: `Test ${id}`,
    description: 'x',
    status: 'active',
    progress: 0,
    steps: steps.map(s => ({
      label: s.id,
      taskType: 'general',
      prompt: `STEP:${s.id}`,
      status: 'pending',
      ...s,
    })) as ProjectStep[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    context: {},
  };
}

const interval = (timeline: TimelineEvent[], id: string) => ({
  start: timeline.find(e => e.id === id && e.event === 'start')?.t ?? -1,
  end: timeline.find(e => e.id === id && e.event === 'end')?.t ?? -1,
});
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

// ═══════════════════════════════════════════════════════════
// 1. deriveDependencies — rules (a)–(d)
// ═══════════════════════════════════════════════════════════

describe('deriveDependencies', () => {
  it('(a) chapter WRITE steps are strictly sequential; (b) POLISH depends only on its own chapter', () => {
    const { steps } = buildBookProductionSteps('p', 'Book', 'desc', { targetChapters: 3, targetWordsPerChapter: 100 });
    const byLabel = (l: string) => steps.find(s => s.label === l)!;

    const w1 = byLabel('Write Chapter 1');
    const w2 = byLabel('Write Chapter 2');
    const w3 = byLabel('Write Chapter 3');
    const p1 = byLabel('Polish Chapter 1');
    const p2 = byLabel('Polish Chapter 2');

    // (a) each chapter draft depends on the previous chapter draft (continuity).
    expect(w1.dependsOn).toEqual([]);                 // first chapter, no prior write
    expect(w2.dependsOn).toEqual([w1.id]);
    expect(w3.dependsOn).toEqual([w2.id]);

    // (b) polish depends ONLY on its own chapter draft — NOT the prior polish —
    // so Polish ch1 can run while Write ch2 drafts.
    expect(p1.dependsOn).toEqual([w1.id]);
    expect(p2.dependsOn).toEqual([w2.id]);
    // Critically, Polish 1 does NOT depend on Write 2 → parallel with next chapter.
    expect(p1.dependsOn).not.toContain(w2.id);
  });

  it('(d) the terminal assembly step depends on ALL writing + polish steps', () => {
    const { steps } = buildBookProductionSteps('p', 'Book', 'desc', { targetChapters: 2, targetWordsPerChapter: 100 });
    const compile = steps.find(s => s.phase === 'assembly')!;
    const upstreamIds = steps
      .filter(s => s.phase === 'writing' || s.phase === 'polish')
      .map(s => s.id);
    expect(new Set(compile.dependsOn)).toEqual(new Set(upstreamIds));
  });

  it('novel-pipeline: writing chapters sequential + assembly waits on everything', () => {
    const { steps } = buildNovelPipelineSteps('n', 'Novel', 'desc', { targetChapters: 3, targetWordsPerChapter: 100 });
    const writes = steps.filter(s => s.phase === 'writing');
    // Chapter N depends on chapter N-1.
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i].dependsOn).toEqual([writes[i - 1].id]);
    }
    // Assembly depends on all writing + revision steps.
    const assembly = steps.find(s => s.phase === 'assembly')!;
    const upstream = steps.filter(s => s.phase === 'writing' || s.phase === 'revision').map(s => s.id);
    expect(new Set(assembly.dependsOn)).toEqual(new Set(upstream));
  });

  it('sequential fallback: independent-looking planning steps still chain to the previous step', () => {
    const steps: ProjectStep[] = [
      { id: 's1', label: 'Market analysis', taskType: 'research', prompt: '', status: 'pending' },
      { id: 's2', label: 'Premise', taskType: 'general', prompt: '', status: 'pending' },
      { id: 's3', label: 'Outline', taskType: 'outline', prompt: '', status: 'pending' },
    ];
    deriveDependencies(steps);
    expect(steps[0].dependsOn).toEqual([]);
    expect(steps[1].dependsOn).toEqual(['s1']);
    expect(steps[2].dependsOn).toEqual(['s2']);
  });

  it('revision_apply steps stay strictly sequential (never parallelized)', () => {
    const steps: ProjectStep[] = [
      { id: 'a', label: 'Analysis', taskType: 'revision', prompt: '', status: 'pending' },
      { id: 'm', label: 'Apply macro revisions (full manuscript rewrite)', phase: 'revision_apply', taskType: 'revision', prompt: '', status: 'pending' },
      { id: 's', label: 'Apply scene-level revisions (full manuscript rewrite)', phase: 'revision_apply', taskType: 'revision', prompt: '', status: 'pending' },
    ];
    deriveDependencies(steps);
    expect(steps[1].dependsOn).toEqual(['a']);
    expect(steps[2].dependsOn).toEqual(['m']);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Conductor loop behavior
// ═══════════════════════════════════════════════════════════

describe('conductor loop', () => {
  it('runs independent steps concurrently while chapters stay sequential', async () => {
    // write1 → write2 (chapter continuity); polish1 hangs off write1.
    const project = makeProject('cc', [
      { id: 'w1', skill: 'write', chapterNumber: 1, dependsOn: [] },
      { id: 'w2', skill: 'write', chapterNumber: 2, dependsOn: ['w1'] },
      { id: 'p1', phase: 'polish', skill: 'revise', chapterNumber: 1, dependsOn: ['w1'] },
    ]);
    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({
      w1: { delayMs: 20 }, w2: { delayMs: 60 }, p1: { delayMs: 60 },
    }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    expect(results.every(r => r.success)).toBe(true);
    expect(results.length).toBe(3);

    const w1i = interval(timeline, 'w1');
    const w2i = interval(timeline, 'w2');
    const p1i = interval(timeline, 'p1');

    // Chapters sequential: write2 starts only after write1 ends.
    expect(w2i.start).toBeGreaterThanOrEqual(w1i.end);
    // Independent branch: polish1 overlaps write2 (they run concurrently).
    expect(overlaps(p1i, w2i)).toBe(true);
    expect(project.status).toBe('completed');
  });

  it('a failed step blocks only its dependents; independent branches continue', async () => {
    // A → B → D  and  A → C. B fails, so only D is blocked.
    const project = makeProject('fail', [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B'] },
    ]);
    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({
      A: {}, B: { fail: true }, C: {}, D: {},
    }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    const byId = Object.fromEntries(project.steps.map(s => [s.id, s.status]));
    expect(byId.A).toBe('completed');
    expect(byId.B).toBe('failed');
    expect(byId.C).toBe('completed');   // independent branch ran despite B failing
    expect(byId.D).toBe('pending');     // dependent of B never became ready
    // D never executed.
    expect(results.find(r => r.step === 'D')).toBeUndefined();
    expect(project.status).not.toBe('completed'); // D still outstanding
  });

  it('pause stops NEW dispatches but lets in-flight steps finish', async () => {
    // A, B independent (both dispatched at concurrency 2); C independent, would
    // be dispatched next. A pauses the project mid-flight → C must NOT start.
    const project = makeProject('pause', [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: [] },
      { id: 'C', dependsOn: [] },
    ]);
    project.context = { conductorConcurrency: 2 };
    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({
      A: { delayMs: 30, onStart: () => { project.status = 'paused'; } },
      B: { delayMs: 30 },
      C: { delayMs: 30 },
    }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    const byId = Object.fromEntries(project.steps.map(s => [s.id, s.status]));
    // In-flight A and B finished…
    expect(byId.A).toBe('completed');
    expect(byId.B).toBe('completed');
    // …but the paused project stopped C from ever dispatching.
    expect(byId.C).toBe('pending');
    expect(results.find(r => r.step === 'C')).toBeUndefined();
    expect(project.status).toBe('paused');
  });

  it('respects the concurrency cap (project override)', async () => {
    const project = makeProject('cap', [
      { id: 's1', dependsOn: [] }, { id: 's2', dependsOn: [] },
      { id: 's3', dependsOn: [] }, { id: 's4', dependsOn: [] },
      { id: 's5', dependsOn: [] },
    ]);
    project.context = { conductorConcurrency: 2 };
    const timeline: TimelineEvent[] = [];
    const live = { cur: 0, max: 0 };
    const handler = makeHandler(
      Object.fromEntries(project.steps.map(s => [s.id, { delayMs: 25 }])),
      timeline, live,
    );

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    await exec.autoExecuteLoop(project.id, { workspaceDir });

    expect(live.max).toBe(2); // never more than 2 concurrent AI calls
  });

  it('clamps an out-of-range concurrency to the max of 3', async () => {
    const project = makeProject('clamp', [
      { id: 's1', dependsOn: [] }, { id: 's2', dependsOn: [] },
      { id: 's3', dependsOn: [] }, { id: 's4', dependsOn: [] },
      { id: 's5', dependsOn: [] },
    ]);
    project.context = { conductorConcurrency: 99 };
    const timeline: TimelineEvent[] = [];
    const live = { cur: 0, max: 0 };
    const handler = makeHandler(
      Object.fromEntries(project.steps.map(s => [s.id, { delayMs: 25 }])),
      timeline, live,
    );

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    await exec.autoExecuteLoop(project.id, { workspaceDir });

    expect(live.max).toBe(3);
  });

  it('processes context-engine hooks serially (never concurrently) even on simultaneous completions', async () => {
    // Three canonical steps ready at once: one chapter write + two bible steps.
    // Their AI calls run concurrently, but the context-engine hooks must NOT.
    const project = makeProject('hooks', [
      { id: 'w1', skill: 'write', chapterNumber: 1, dependsOn: [] },
      { id: 'b1', label: 'World bible', dependsOn: [] },
      { id: 'b2', label: 'Character bible', dependsOn: [] },
    ]);
    project.type = 'book-bible';
    project.context = { conductorConcurrency: 3 };

    const hookLive = { cur: 0, max: 0 };
    const hookOrder: string[] = [];
    const contextEngine = {
      async generateSummary(_pid: string, stepId: string) {
        hookLive.cur++; hookLive.max = Math.max(hookLive.max, hookLive.cur);
        hookOrder.push(stepId);
        await new Promise(r => setTimeout(r, 15));
        hookLive.cur--;
      },
      async extractEntities() { /* no-op */ },
    };

    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({
      w1: { delayMs: 10 }, b1: { delayMs: 10 }, b2: { delayMs: 10 },
    }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler, {}, contextEngine));
    await exec.autoExecuteLoop(project.id, { workspaceDir });

    // Hooks were serialized despite the three steps completing near-simultaneously.
    expect(hookLive.max).toBe(1);
    expect(hookOrder.length).toBe(3);
  });

  it('chapter WRITE hooks fire in ascending chapter order', async () => {
    // Strictly-sequential chapter chain → summaries recorded in chapter order.
    const project = makeProject('order', [
      { id: 'w1', skill: 'write', chapterNumber: 1, dependsOn: [] },
      { id: 'w2', skill: 'write', chapterNumber: 2, dependsOn: ['w1'] },
      { id: 'w3', skill: 'write', chapterNumber: 3, dependsOn: ['w2'] },
    ]);
    const summaryOrder: string[] = [];
    const contextEngine = {
      async generateSummary(_pid: string, stepId: string) { summaryOrder.push(stepId); },
      async extractEntities() { /* no-op */ },
    };
    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({ w1: {}, w2: {}, w3: {} }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler, {}, contextEngine));
    await exec.autoExecuteLoop(project.id, { workspaceDir });

    expect(summaryOrder).toEqual(['w1', 'w2', 'w3']);
  });

  // ── M1.3 — ALP-1557: gate-blocking ──
  it('a gated step opens its review gate and blocks only its own dependent branch; parallel siblings keep completing', async () => {
    // A gates on completion; B depends on A; C is fully independent.
    const project = makeProject('gate', [
      { id: 'A', dependsOn: [], gateEnabled: true },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: [] },
    ]);
    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({ A: {}, B: {}, C: {} }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    const byId = Object.fromEntries(project.steps.map(s => [s.id, s]));
    expect(byId.A.status).toBe('awaiting_review');
    expect(byId.A.gate).toEqual({ state: 'open', openedAt: expect.any(String) });
    // B never became ready — depsSatisfied() requires 'completed'/'skipped',
    // and 'awaiting_review' is neither. No new scheduling logic needed for this.
    expect(byId.B.status).toBe('pending');
    // C is on an independent branch and completes normally.
    expect(byId.C.status).toBe('completed');

    expect(results.find(r => r.step === 'A')).toMatchObject({ success: true, gated: true });
    expect(results.find(r => r.step === 'B')).toBeUndefined(); // never dispatched
    // The project can't be "done" while B is still blocked behind the gate.
    expect(project.status).not.toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Legacy sequential path (no dependsOn)
// ═══════════════════════════════════════════════════════════

describe('legacy projects (no dependsOn) run strictly sequentially', () => {
  it('executes steps one at a time in declared order — no overlap', async () => {
    // No dependsOn on any step → hasDeps=false → legacy loop.
    const project = makeProject('legacy', [
      { id: 'L1' }, { id: 'L2' }, { id: 'L3' },
    ]);
    // Strip dependsOn to simulate a pre-conductor persisted project.
    project.steps.forEach(s => { delete (s as any).dependsOn; });
    // Route pre-activates the first step in the sequential model.
    project.steps[0].status = 'active';

    const timeline: TimelineEvent[] = [];
    const live = { cur: 0, max: 0 };
    const handler = makeHandler({
      L1: { delayMs: 20 }, L2: { delayMs: 20 }, L3: { delayMs: 20 },
    }, timeline, live);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler, {}, undefined));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    // Order identical to declaration and strictly serial.
    expect(results.map(r => r.step)).toEqual(['L1', 'L2', 'L3']);
    expect(live.max).toBe(1); // never concurrent
    // Intervals do not overlap.
    const a = interval(timeline, 'L1');
    const b = interval(timeline, 'L2');
    const c = interval(timeline, 'L3');
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, c)).toBe(false);
    expect(project.status).toBe('completed');
  });

  it('a failure halts the whole legacy run (prior behavior preserved)', async () => {
    const project = makeProject('legacy-fail', [
      { id: 'F1' }, { id: 'F2' }, { id: 'F3' },
    ]);
    project.steps.forEach(s => { delete (s as any).dependsOn; });
    project.steps[0].status = 'active';

    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({ F1: {}, F2: { fail: true }, F3: {} }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    expect(results.map(r => r.step)).toEqual(['F1', 'F2']); // stopped at the failure
    expect(project.steps.find(s => s.id === 'F3')!.status).toBe('pending'); // never activated after the halt
  });

  // ── M1.3 — ALP-1557: gate-blocking ──
  it('halts cleanly at a gate — NOT as a failure — and never activates the next step', async () => {
    const project = makeProject('legacy-gate', [
      { id: 'G1' }, { id: 'G2', gateEnabled: true }, { id: 'G3' },
    ]);
    project.steps.forEach(s => { delete (s as any).dependsOn; });
    project.steps[0].status = 'active';

    const timeline: TimelineEvent[] = [];
    const handler = makeHandler({ G1: {}, G2: {}, G3: {} }, timeline);

    const exec = new StepExecutor(makeEngine(project), makeDeps(handler));
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    // Halted right after the gate — G3 never ran.
    expect(results.map(r => r.step)).toEqual(['G1', 'G2']);
    // A gate is NOT an error: every pushed result is success:true, and G2 is
    // flagged gated so callers can tell "halted" apart from "failed".
    expect(results.every(r => r.success)).toBe(true);
    expect(results.find(r => r.step === 'G2')).toMatchObject({ success: true, gated: true });

    const byId = Object.fromEntries(project.steps.map(s => [s.id, s]));
    expect(byId.G1.status).toBe('completed');
    expect(byId.G2.status).toBe('awaiting_review');
    expect(byId.G3.status).toBe('pending'); // never activated after the halt
    expect(project.status).not.toBe('completed');
  });
});

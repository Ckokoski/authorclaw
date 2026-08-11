/**
 * M1 exit-criterion regression (ALP-1560, plan.md "M1 — Foundations").
 *
 * "A pre-existing project created before this work still runs to completion
 * unchanged, with gates off." Real in-flight novel-pipeline projects predating
 * this fork have already cleared their premise/bible/outline steps — those
 * phases run first, and gating landed after real users already had books in
 * progress. Only writing/revision/assembly remain for such a project, and
 * those phases are auto (ungated) by GATED_PHASES_DEFAULT.
 *
 * This builds a project from the real production template (buildNovelPipelineSteps
 * — real phases, real dependsOn graph), fast-forwards it to that realistic
 * mid-flight state, and drives it through the real conductor with the real
 * gate-resolution code (resolveStepGate / applyStepCompletion are NOT stubbed)
 * to prove nothing gates and the run completes exactly as it would have
 * before M1.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  StepExecutor,
  type EnginePort,
  type StepExecutorDeps,
  type MessageHandler,
} from './step-executor.js';
import { buildNovelPipelineSteps, type Project } from './project-templates.js';

const LONG = 'word '.repeat(60); // >50 chars — clears the "unusably short response" retry path

function makeEngine(project: Project): EnginePort {
  return {
    getProject: (id) => (id === project.id ? project : undefined),
    completeStep: (_pid, sid, result) => {
      const s = project.steps.find(x => x.id === sid);
      if (s) { s.status = 'completed'; s.result = result; }
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
    openStepGate: (_pid, sid) => {
      // A pre-existing project must NEVER open a gate — fail loudly if it does.
      throw new Error(`unexpected gate opened on step ${sid} — a pre-existing project must run unchanged`);
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

const handler: MessageHandler = async (_content, _channel, respond) => { respond(LONG); };

const deps: StepExecutorDeps = {
  getMessageHandler: () => handler,
  getStepServices: () => ({}),
  getContextEngine: () => undefined,
};

describe('M1 regression — a pre-existing project runs to completion unchanged', () => {
  it('a novel-pipeline project already past premise/bible/outline gates on nothing and completes', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'm1-regression-'));
    const workspaceDir = join(rootDir, 'workspace');

    const { steps, chapters } = buildNovelPipelineSteps('legacy1', 'Legacy Book', 'A pre-fork project', {
      targetChapters: 2, targetWordsPerChapter: 100,
    });

    // Fast-forward to the realistic "already in flight" state: every
    // premise/bible/outline step already completed, as any real project
    // running before this fork would be (those phases run first).
    for (const s of steps) {
      if (s.phase === 'premise' || s.phase === 'bible' || s.phase === 'outline') {
        s.status = 'completed';
        s.result = `[pre-fork output] ${s.label}`;
      }
    }

    const project: Project = {
      id: 'legacy1',
      type: 'novel-pipeline',
      title: 'Legacy Book',
      description: 'A pre-fork project',
      status: 'active',
      progress: 0,
      steps,
      createdAt: '2026-01-01T00:00:00.000Z', // predates this work
      updatedAt: '2026-01-01T00:00:00.000Z',
      context: {}, // no reviewGates override — nothing fork-specific was ever set on this project
    };

    const exec = new StepExecutor(makeEngine(project), deps);
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    try {
      // Nothing gated — every dispatched step is a plain success.
      expect(results.every(r => r.success && !r.gated)).toBe(true);
      // Exactly the remaining steps ran: N chapters + 3 revision steps + 1 assembly.
      expect(results.length).toBe(chapters + 3 + 1);
      expect(project.steps.every(s => s.status === 'completed')).toBe(true);
      expect(project.steps.every(s => s.gate === undefined)).toBe(true);
      expect(project.status).toBe('completed');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('a fresh legacy project (no dependsOn at all) still runs strictly sequentially with no gates', async () => {
    // The oldest possible persisted shape — predates even the conductor engine.
    // No `phase` is set on any step, so resolveStepGate() falls through to
    // "never gates a phase-less step by default" for every single step.
    const rootDir = mkdtempSync(join(tmpdir(), 'm1-regression-legacy-'));
    const workspaceDir = join(rootDir, 'workspace');

    const project: Project = {
      id: 'ancient1',
      type: 'book-production',
      title: 'Ancient Book',
      description: 'x',
      status: 'active',
      progress: 0,
      steps: [
        { id: 'L1', label: 'Step 1', taskType: 'general', prompt: 'do 1', status: 'active' },
        { id: 'L2', label: 'Step 2', taskType: 'general', prompt: 'do 2', status: 'pending' },
        { id: 'L3', label: 'Step 3', taskType: 'general', prompt: 'do 3', status: 'pending' },
      ],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      context: {},
    };

    const exec = new StepExecutor(makeEngine(project), deps);
    const { results } = await exec.autoExecuteLoop(project.id, { workspaceDir });

    try {
      expect(results.map(r => r.step)).toEqual(['Step 1', 'Step 2', 'Step 3']);
      expect(results.every(r => r.success && !r.gated)).toBe(true);
      expect(project.steps.every(s => s.status === 'completed' && s.gate === undefined)).toBe(true);
      expect(project.status).toBe('completed');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

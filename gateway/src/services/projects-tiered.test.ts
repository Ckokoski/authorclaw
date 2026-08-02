/**
 * Chunk B1 integration tests: the tiered-memory wiring into the project-step
 * path (ProjectEngine.buildProjectContext) plus the step-executor
 * full-manuscript allowlist changes.
 *
 * These focus on the additive/guarded contract:
 *   - CORE injection appears when a MemoryTier + cache exist, is absent (and
 *     byte-identical to before) when the tier is unset.
 *   - The revision truncate() bug fix swaps chapter openings for ChapterSummary.
 *   - uploadedContent is not duplicated between system + user message.
 *   - Consistency steps now count as "needs full manuscript" for the cap, but
 *     NOT as full rewrites (no word-count continuation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ContextEngine, type ProjectContext } from './context-engine.js';
import { MemoryTierService } from './memory-tier.js';
import { ProjectEngine, type Project, type ProjectStep } from './projects.js';
import { StepExecutor, type EnginePort, type StepExecutorDeps } from './step-executor.js';

// ═══════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════

let rootDir: string;
let workspaceDir: string;
let engine: ContextEngine;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'authoragent-b1-'));
  workspaceDir = join(rootDir, 'workspace');
  mkdirSync(join(workspaceDir, '.config'), { recursive: true });
  engine = new ContextEngine(workspaceDir);
});

afterEach(() => {
  try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Seed a ContextEngine cache with two chapter summaries for `projectId`. */
async function seedSummaries(projectId: string): Promise<void> {
  const ctx: ProjectContext = {
    projectId,
    updatedAt: new Date().toISOString(),
    summaries: [
      {
        chapterId: `${projectId}-step-w1`,
        chapterNumber: 1,
        title: 'The Gathering Storm',
        summary: 'Aria meets Kael at the docks and agrees to find the missing heir.',
        wordCount: 3000,
        characters: ['Aria', 'Kael'],
        locations: ['The Docks'],
        timelineMarker: 'Day 1',
        plotThreads: ['the missing heir'],
        endingState: 'Aria sets sail into the storm, uncertain whom to trust.',
      },
      {
        chapterId: `${projectId}-step-w2`,
        chapterNumber: 2,
        title: 'The Sealed Vault',
        summary: 'Aria and Mira open the vault; Doran ambushes them inside.',
        wordCount: 3200,
        characters: ['Aria', 'Mira', 'Doran'],
        locations: ['The Vault'],
        timelineMarker: 'Day 3',
        plotThreads: ['the sealed vault'],
        endingState: 'THE_ENDING_MARKER: Doran holds them at swordpoint as the door seals shut.',
      },
    ],
    entities: [
      {
        name: 'Aria', type: 'character', aliases: [],
        description: 'A dockside courier searching for the truth.',
        firstAppearance: `${projectId}-step-w1`, lastSeen: `${projectId}-step-w2`,
        attributes: { role: 'protagonist' }, changes: [],
      },
    ],
  };
  const contextDir = join(workspaceDir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, `${projectId}.json`), JSON.stringify(ctx, null, 2), 'utf-8');
  await engine.loadContext(projectId);
}

/** A novel-pipeline project with two completed writing chapters + a revision step. */
function novelProject(id: string): Project {
  const steps: ProjectStep[] = [
    {
      id: `${id}-step-w1`, label: 'Write Chapter 1', phase: 'writing', skill: 'write',
      taskType: 'creative_writing',
      // Opening is bland; the ENDING is what carries the continuity signal.
      prompt: 'Write Chapter 1', status: 'completed', chapterNumber: 1,
      result: 'OPENING_ONE ' + 'a'.repeat(600) + ' HIDDEN_ENDING_ONE',
    } as any,
    {
      id: `${id}-step-w2`, label: 'Write Chapter 2', phase: 'writing', skill: 'write',
      taskType: 'creative_writing',
      prompt: 'Write Chapter 2', status: 'completed', chapterNumber: 2,
      result: 'OPENING_TWO ' + 'b'.repeat(600) + ' HIDDEN_ENDING_TWO',
    } as any,
    {
      id: `${id}-step-r1`, label: 'Consistency check', phase: 'revision', skill: 'revise',
      taskType: 'consistency', prompt: 'Run a consistency check across all chapters.',
      status: 'active',
    } as any,
  ];
  return {
    id, type: 'novel-pipeline', title: 'Test Novel', description: 'A test.',
    status: 'active', progress: 50, steps,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    context: {},
  } as Project;
}

// ═══════════════════════════════════════════════════════════
// CORE injection into buildProjectContext (3a + guard + flag)
// ═══════════════════════════════════════════════════════════

describe('buildProjectContext CORE injection (Chunk B1)', () => {
  it('injects the "# CORE STORY MEMORY" header when a MemoryTier + cache exist', async () => {
    const engineEng = new ProjectEngine(undefined, rootDir);
    engineEng.setContextEngine(engine);
    engineEng.setMemoryTier(new MemoryTierService(engine, null, workspaceDir));

    const project = novelProject('project-core-on');
    await seedSummaries(project.id);
    const activeStep = project.steps.find(s => s.status === 'active')!;

    const ctx = await engineEng.buildProjectContext(project, activeStep);
    expect(ctx).toContain('# CORE STORY MEMORY');
    // Bounded: the CORE block itself is ≤3,500; the whole context is small here.
    expect(ctx.length).toBeLessThan(20000);
  });

  it('produces NO CORE header (prior behavior) when no MemoryTier is wired', async () => {
    const engineEng = new ProjectEngine(undefined, rootDir);
    engineEng.setContextEngine(engine);
    // Intentionally NOT calling setMemoryTier.

    const project = novelProject('project-core-off');
    await seedSummaries(project.id);
    const activeStep = project.steps.find(s => s.status === 'active')!;

    const ctx = await engineEng.buildProjectContext(project, activeStep);
    expect(ctx).not.toContain('# CORE STORY MEMORY');
  });
});

// ═══════════════════════════════════════════════════════════
// truncate() → ChapterSummary swap (3c) in the revision phase
// ═══════════════════════════════════════════════════════════

describe('revision context truncate→summary swap (Chunk B1)', () => {
  it('uses the ChapterSummary (with ending) instead of the opening slice', async () => {
    const engineEng = new ProjectEngine(undefined, rootDir);
    engineEng.setContextEngine(engine);
    // MemoryTier not required for this path, but wire it to mirror production.
    engineEng.setMemoryTier(new MemoryTierService(engine, null, workspaceDir));

    const project = novelProject('project-rev');
    await seedSummaries(project.id);
    const activeStep = project.steps.find(s => s.status === 'active')!;

    const ctx = await engineEng.buildProjectContext(project, activeStep);

    // The summary carries the chapter ENDING; the old slice(0,500) would have
    // shown only the opening filler and dropped the ending entirely.
    expect(ctx).toContain('THE_ENDING_MARKER');
    expect(ctx).toContain('Chapter ends:');
    // The raw opening filler run should NOT be what represents the chapter here.
    expect(ctx).not.toContain('HIDDEN_ENDING_ONE'); // raw result ending never injected raw
  });

  it('falls back to the opening slice when no summary is cached', async () => {
    const engineEng = new ProjectEngine(undefined, rootDir);
    engineEng.setContextEngine(engine);

    const project = novelProject('project-rev-nosummary');
    // NOTE: do NOT seed summaries → getSummaries returns [].
    const activeStep = project.steps.find(s => s.status === 'active')!;

    const ctx = await engineEng.buildProjectContext(project, activeStep);
    // Old behavior preserved: opening slice of the chapter draft appears.
    expect(ctx).toContain('OPENING_ONE');
    expect(ctx).not.toContain('Chapter ends:');
  });
});

// ═══════════════════════════════════════════════════════════
// uploadedContent de-dup (3d)
// ═══════════════════════════════════════════════════════════

describe('uploadedContent de-dup (Chunk B1)', () => {
  it('does not inline the manuscript body in the system context when it is also in the user message', async () => {
    const engineEng = new ProjectEngine(undefined, rootDir);
    engineEng.setContextEngine(engine);

    const project: Project = {
      id: 'project-upload', type: 'deep-revision', title: 'Upload Test',
      description: 'x', status: 'active', progress: 0,
      steps: [{ id: 'project-upload-step-1', label: 'Edit pass', taskType: 'revision', prompt: 'Edit it.', status: 'active' } as any],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      context: {
        uploadedContent: 'UNIQUE_MANUSCRIPT_BODY_SENTINEL ' + 'm'.repeat(500),
        uploads: [{ filename: 'book.docx', wordCount: 100 }],
      },
    } as Project;
    const activeStep = project.steps[0];

    const ctx = await engineEng.buildProjectContext(project, activeStep);
    // Header retained for orientation…
    expect(ctx).toContain('## Uploaded Manuscript');
    expect(ctx).toContain('book.docx');
    // …but the body is NOT duplicated in the system context.
    expect(ctx).not.toContain('UNIQUE_MANUSCRIPT_BODY_SENTINEL');
    expect(ctx).toContain('provided in the task message below');
  });
});

// ═══════════════════════════════════════════════════════════
// step-executor allowlist (3e): consistency ⇒ full manuscript, NOT rewrite
// ═══════════════════════════════════════════════════════════

describe('StepExecutor full-manuscript allowlist (Chunk B1)', () => {
  const port: EnginePort = {
    getProject: () => undefined,
    completeStep: () => null,
    completeStepBare: () => {},
    openStepGate: () => {},
    activateStep: () => null,
    failStep: () => {},
    buildProjectContext: async () => '',
  };
  const deps: StepExecutorDeps = {
    getMessageHandler: () => null,
    getStepServices: () => ({}),
    getContextEngine: () => undefined,
  };
  const exec = new StepExecutor(port, deps);

  it('consistency steps need the full manuscript (cap) …', () => {
    expect(exec.stepNeedsFullManuscript({ taskType: 'consistency' })).toBe(true);
    expect(exec.stepNeedsFullManuscript({ label: 'Consistency check' })).toBe(true);
    expect(exec.stepNeedsFullManuscript({ label: 'World-building continuity scan' })).toBe(true);
  });

  it('… but consistency steps are NOT full rewrites (no continuation)', () => {
    expect(exec.stepIsFullRewrite({ taskType: 'consistency' })).toBe(false);
    expect(exec.stepIsFullRewrite({ label: 'Consistency check' })).toBe(false);
  });

  it('revision_apply steps are BOTH full-manuscript and full-rewrite', () => {
    const step = { phase: 'revision_apply', label: 'Apply macro revisions (full manuscript rewrite)' };
    expect(exec.stepNeedsFullManuscript(step)).toBe(true);
    expect(exec.stepIsFullRewrite(step)).toBe(true);
  });

  it('a plain writing step is neither (unchanged behavior)', () => {
    const step = { phase: 'writing', skill: 'write', label: 'Write Chapter 3' };
    expect(exec.stepNeedsFullManuscript(step)).toBe(false);
    expect(exec.stepIsFullRewrite(step)).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  slugify,
  projectPhaseSlug,
  projectOutputDir,
  stepOutputFileName,
  legacyProjectOutputDir,
  legacyStepOutputFileName,
  resolveStepArtifactDir,
  resolveStepOutputPath,
  projectOutputDirs,
  listProjectOutputFiles,
} from './project-paths.js';

const endsWith = (p: string, tail: string) => p.endsWith(tail) || p.endsWith(tail.replace(/\//g, '\\'));

/** Label ending in punctuation — the one case the two filename spellings disagree on. */
const dashStep = { id: 'project-18-step-4', label: 'Draft Chapter 1!' };

describe('project-paths (ALP-1548)', () => {
  const ws = '/work';
  it('slugifies titles and never returns empty', () => {
    expect(slugify('My Great Novel!')).toBe('my-great-novel');
    expect(slugify('  --Trim-- ')).toBe('trim');
    expect(slugify('')).toBe('untitled');
    expect(slugify('***')).toBe('untitled');
  });
  it('names the phase folder from the project type', () => {
    expect(projectPhaseSlug({ type: 'book-planning' })).toBe('book-planning');
    expect(projectPhaseSlug({ type: 'book-production', pipelinePhase: 3 })).toBe('phase-3-book-production');
    expect(projectPhaseSlug({})).toBe('project');
  });
  it('separates a titles phases into named sibling folders', () => {
    const dPlanning = projectOutputDir(ws, { title: 'My Novel', type: 'book-planning' });
    const dProduction = projectOutputDir(ws, { title: 'My Novel', type: 'book-production' });
    expect(endsWith(dPlanning, 'my-novel/book-planning')).toBe(true);
    expect(endsWith(dProduction, 'my-novel/book-production')).toBe(true);
    expect(dPlanning).not.toBe(dProduction);
  });
  it('keeps the project id in the filename so same-typed runs never collide', () => {
    expect(stepOutputFileName({ id: 'project-18-step-3', label: 'Write Chapter 1' })).toBe('project-18-step-3-write-chapter-1.md');
    expect(stepOutputFileName({ id: 'project-9-step-1', label: 'Premise' })).not.toBe(stepOutputFileName({ id: 'project-10-step-1', label: 'Premise' }));
  });
  it('exposes the legacy flat dir for backward-compatible reads', () => {
    const dir = legacyProjectOutputDir(ws, { title: 'My Novel' });
    expect(endsWith(dir, 'projects/my-novel')).toBe(true);
    expect(dir).not.toContain('book-production');
  });
});

describe('resolveStepArtifactDir (ALP-1548 reader/writer agreement)', () => {
  const project = { title: 'My Novel', type: 'book-production', pipelinePhase: 3 };
  const step = { id: 'project-18-step-3', label: 'Write Chapter 1' };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alp1548-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults to the per-phase dir when the step has no artifacts anywhere', () => {
    expect(resolveStepArtifactDir(root, project, step)).toBe(projectOutputDir(root, project));
  });

  it('falls back to the legacy flat dir when the version sidecar lives there', () => {
    mkdirSync(join(legacyProjectOutputDir(root, project), '.versions', step.id), { recursive: true });
    expect(resolveStepArtifactDir(root, project, step)).toBe(legacyProjectOutputDir(root, project));
  });

  it('falls back to the legacy flat dir when only the canonical .md lives there', () => {
    const legacy = legacyProjectOutputDir(root, project);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, stepOutputFileName(step)), '# Write Chapter 1');
    expect(resolveStepArtifactDir(root, project, step)).toBe(legacy);
  });

  it('prefers the per-phase dir when the step exists in both places', () => {
    const phaseDir = projectOutputDir(root, project);
    mkdirSync(join(phaseDir, '.versions', step.id), { recursive: true });
    mkdirSync(join(legacyProjectOutputDir(root, project), '.versions', step.id), { recursive: true });
    expect(resolveStepArtifactDir(root, project, step)).toBe(phaseDir);
  });

  it('does not confuse a sibling step in the legacy dir for this one', () => {
    mkdirSync(join(legacyProjectOutputDir(root, project), '.versions', 'project-18-step-9'), { recursive: true });
    expect(resolveStepArtifactDir(root, project, step)).toBe(projectOutputDir(root, project));
  });

  it('finds a legacy trailing-dash filename in the legacy dir', () => {
    const legacy = legacyProjectOutputDir(root, project);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, legacyStepOutputFileName(dashStep)), '# old');
    expect(resolveStepArtifactDir(root, project, dashStep)).toBe(legacy);
  });
});

describe('resolveStepOutputPath (ALP-1548 trailing-dash filenames)', () => {
  const project = { title: 'My Novel', type: 'book-production', pipelinePhase: 3 };
  const step = { id: 'project-18-step-3', label: 'Write Chapter 1' };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alp1548-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('spells a trailing-punctuation label differently than the pre-ALP-1548 writer did', () => {
    expect(stepOutputFileName(dashStep)).toBe('project-18-step-4-draft-chapter-1.md');
    expect(legacyStepOutputFileName(dashStep)).toBe('project-18-step-4-draft-chapter-1-.md');
    expect(stepOutputFileName(dashStep)).not.toBe(legacyStepOutputFileName(dashStep));
  });

  it('agrees with stepOutputFileName for ordinary labels', () => {
    expect(legacyStepOutputFileName(step)).toBe(stepOutputFileName(step));
  });

  it('defaults to the current dir + current filename when nothing exists yet', () => {
    expect(resolveStepOutputPath(root, project, dashStep)).toBe(
      join(projectOutputDir(root, project), stepOutputFileName(dashStep)),
    );
  });

  it('finds a legacy-named file in the legacy dir', () => {
    const legacy = legacyProjectOutputDir(root, project);
    mkdirSync(legacy, { recursive: true });
    const legacyPath = join(legacy, legacyStepOutputFileName(dashStep));
    writeFileSync(legacyPath, '# old');
    expect(resolveStepOutputPath(root, project, dashStep)).toBe(legacyPath);
  });

  it('rewrites a legacy-named file in place instead of dropping a second copy beside it', () => {
    const legacy = legacyProjectOutputDir(root, project);
    mkdirSync(legacy, { recursive: true });
    const legacyPath = join(legacy, legacyStepOutputFileName(dashStep));
    writeFileSync(legacyPath, '# old');

    // What reviseStep / the manual-save route now write to.
    writeFileSync(resolveStepOutputPath(root, project, dashStep), '# revised');

    expect(readFileSync(legacyPath, 'utf-8')).toBe('# revised');
    expect(existsSync(join(legacy, stepOutputFileName(dashStep)))).toBe(false);
  });

  it('prefers the per-phase dir over a legacy-named file elsewhere', () => {
    const phaseDir = projectOutputDir(root, project);
    mkdirSync(phaseDir, { recursive: true });
    const legacy = legacyProjectOutputDir(root, project);
    writeFileSync(join(legacy, legacyStepOutputFileName(dashStep)), '# old');
    const currentPath = join(phaseDir, stepOutputFileName(dashStep));
    writeFileSync(currentPath, '# current');
    expect(resolveStepOutputPath(root, project, dashStep)).toBe(currentPath);
  });
});

describe('projectOutputDirs / listProjectOutputFiles (ALP-1548 consumers)', () => {
  const project = { title: 'My Novel', type: 'book-production', pipelinePhase: 3 };
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'alp1548-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const phaseDir = () => projectOutputDir(root, project);
  const legacyDir = () => legacyProjectOutputDir(root, project);

  it('returns only dirs that exist, per-phase first', () => {
    expect(projectOutputDirs(root, project)).toEqual([]);
    mkdirSync(legacyDir(), { recursive: true });
    expect(projectOutputDirs(root, project)).toEqual([legacyDir()]);
    mkdirSync(phaseDir(), { recursive: true });
    expect(projectOutputDirs(root, project)).toEqual([phaseDir(), legacyDir()]);
  });

  // The exact regression: /files listed the flat dir and skipped non-files, so
  // everything written into the per-phase subfolder became invisible.
  it('lists per-phase outputs that a flat-dir-only listing would miss', () => {
    mkdirSync(phaseDir(), { recursive: true });
    writeFileSync(join(legacyDir(), 'project-9-step-1-old.md'), 'old');
    writeFileSync(join(phaseDir(), 'project-18-step-2-new.md'), 'new');
    writeFileSync(join(phaseDir(), 'manuscript.md'), 'assembled');

    const names = listProjectOutputFiles(root, project).map((f) => f.name).sort();
    expect(names).toEqual(['manuscript.md', 'project-18-step-2-new.md', 'project-9-step-1-old.md']);
  });

  it('never returns the phase dir itself as a file of the flat dir', () => {
    mkdirSync(phaseDir(), { recursive: true });
    writeFileSync(join(legacyDir(), 'a.md'), 'a');
    const names = listProjectOutputFiles(root, project).map((f) => f.name);
    expect(names).toEqual(['a.md']);
  });

  it('prefers the per-phase copy when a filename exists in both dirs', () => {
    mkdirSync(phaseDir(), { recursive: true });
    writeFileSync(join(legacyDir(), 'manuscript.md'), 'stale');
    writeFileSync(join(phaseDir(), 'manuscript.md'), 'current');
    const hit = listProjectOutputFiles(root, project).filter((f) => f.name === 'manuscript.md');
    expect(hit).toHaveLength(1);
    expect(readFileSync(hit[0].path, 'utf-8')).toBe('current');
  });
});

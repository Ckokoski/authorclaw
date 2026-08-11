import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  slugify,
  projectPhaseSlug,
  projectOutputDir,
  stepOutputFileName,
  legacyProjectOutputDir,
  resolveStepArtifactDir,
} from './project-paths.js';

const endsWith = (p: string, tail: string) => p.endsWith(tail) || p.endsWith(tail.replace(/\//g, '\\'));

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
});

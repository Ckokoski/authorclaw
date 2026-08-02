import { describe, it, expect } from 'vitest';
import { slugify, projectPhaseSlug, projectOutputDir, stepOutputFileName, legacyProjectOutputDir } from './project-paths.js';

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

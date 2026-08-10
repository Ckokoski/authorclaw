import { describe, it, expect } from 'vitest';
import { computeTransitiveDependents, markDependentsDirty } from './dependency-graph.js';
import type { ProjectStep } from './project-templates.js';

function makeStep(overrides: Partial<ProjectStep> = {}): ProjectStep {
  return {
    id: 's1',
    label: 'Step',
    taskType: 'general',
    prompt: 'do it',
    status: 'completed',
    ...overrides,
  };
}

describe('computeTransitiveDependents', () => {
  it('follows a chain of dependsOn edges transitively', () => {
    // A <- B <- C <- D (B depends on A, C depends on B, D depends on C)
    const steps = [
      makeStep({ id: 'A' }),
      makeStep({ id: 'B', dependsOn: ['A'] }),
      makeStep({ id: 'C', dependsOn: ['B'] }),
      makeStep({ id: 'D', dependsOn: ['C'] }),
    ];

    expect(computeTransitiveDependents(steps, 'A')).toEqual(new Set(['B', 'C', 'D']));
    expect(computeTransitiveDependents(steps, 'C')).toEqual(new Set(['D']));
    expect(computeTransitiveDependents(steps, 'D')).toEqual(new Set());
  });

  it('handles diamond dependencies without duplicating a dependent', () => {
    // A <- B, A <- C, B <- D, C <- D
    const steps = [
      makeStep({ id: 'A' }),
      makeStep({ id: 'B', dependsOn: ['A'] }),
      makeStep({ id: 'C', dependsOn: ['A'] }),
      makeStep({ id: 'D', dependsOn: ['B', 'C'] }),
    ];

    expect(computeTransitiveDependents(steps, 'A')).toEqual(new Set(['B', 'C', 'D']));
  });

  it('returns an empty set for a step with no dependents', () => {
    const steps = [makeStep({ id: 'A' }), makeStep({ id: 'B', dependsOn: ['A'] })];
    expect(computeTransitiveDependents(steps, 'B')).toEqual(new Set());
  });

  it('is defensive against cyclic-looking dependsOn input — terminates, excludes self', () => {
    // A -> B -> C -> A (a cycle that should never occur in practice)
    const steps = [
      makeStep({ id: 'A', dependsOn: ['C'] }),
      makeStep({ id: 'B', dependsOn: ['A'] }),
      makeStep({ id: 'C', dependsOn: ['B'] }),
    ];

    const result = computeTransitiveDependents(steps, 'A');
    expect(result).toEqual(new Set(['B', 'C']));
    expect(result.has('A')).toBe(false);
  });

  it('is defensive against a step depending on itself', () => {
    const steps = [makeStep({ id: 'A', dependsOn: ['A'] })];
    const result = computeTransitiveDependents(steps, 'A');
    expect(result.has('A')).toBe(false);
  });
});

describe('markDependentsDirty', () => {
  it('marks every transitively dependent completed step dirty with the correct cause', () => {
    const steps = [
      makeStep({ id: 'A', status: 'completed' }),
      makeStep({ id: 'B', dependsOn: ['A'], status: 'completed' }),
      makeStep({ id: 'C', dependsOn: ['B'], status: 'completed' }),
    ];

    const now = '2026-08-02T00:00:00.000Z';
    const marked = markDependentsDirty(steps, 'A', 3, 4, now);

    expect(marked.sort()).toEqual(['B', 'C']);

    const [, b, c] = steps;
    expect(b.dirty).toEqual({
      causeStepId: 'A',
      causeVersionFrom: 3,
      causeVersionTo: 4,
      markedAt: now,
    });
    expect(c.dirty).toEqual({
      causeStepId: 'A',
      causeVersionFrom: 3,
      causeVersionTo: 4,
      markedAt: now,
    });
    // severity is left undefined for M4 to fill in.
    expect(b.dirty?.severity).toBeUndefined();
  });

  it('leaves status untouched — dirty is orthogonal to status', () => {
    const steps = [
      makeStep({ id: 'A', status: 'completed' }),
      makeStep({ id: 'B', dependsOn: ['A'], status: 'completed' }),
    ];

    markDependentsDirty(steps, 'A', 1, 2);

    expect(steps[1].status).toBe('completed');
    expect(steps[1].dirty).toBeDefined();
  });

  it('only marks dependents whose status is completed', () => {
    const steps = [
      makeStep({ id: 'A', status: 'completed' }),
      makeStep({ id: 'B', dependsOn: ['A'], status: 'completed' }),
      makeStep({ id: 'C', dependsOn: ['A'], status: 'pending' }),
      makeStep({ id: 'D', dependsOn: ['A'], status: 'awaiting_review' }),
      makeStep({ id: 'E', dependsOn: ['A'], status: 'skipped' }),
      makeStep({ id: 'F', dependsOn: ['A'], status: 'failed' }),
      makeStep({ id: 'G', dependsOn: ['A'], status: 'active' }),
    ];

    const marked = markDependentsDirty(steps, 'A', 1, 2);

    expect(marked).toEqual(['B']);
    for (const id of ['C', 'D', 'E', 'F', 'G']) {
      expect(steps.find((s) => s.id === id)!.dirty).toBeUndefined();
    }
  });

  it('returns an empty array and mutates nothing when the cause step has no dependents', () => {
    const steps = [makeStep({ id: 'A', status: 'completed' })];
    const marked = markDependentsDirty(steps, 'A', 1, 2);
    expect(marked).toEqual([]);
  });

  it('terminates and marks correctly even against cyclic-looking dependsOn input', () => {
    // A -> B -> C -> A, all completed. Marking from A should not hang, and
    // should mark B and C (transitively dependent) without marking A itself.
    const steps = [
      makeStep({ id: 'A', dependsOn: ['C'], status: 'completed' }),
      makeStep({ id: 'B', dependsOn: ['A'], status: 'completed' }),
      makeStep({ id: 'C', dependsOn: ['B'], status: 'completed' }),
    ];

    const marked = markDependentsDirty(steps, 'A', 1, 2);

    expect(marked.sort()).toEqual(['B', 'C']);
    expect(steps[0].dirty).toBeUndefined();
  });

  it('overwrites a stale dirty marker with the newest cause when marked again', () => {
    const steps = [
      makeStep({ id: 'A', status: 'completed' }),
      makeStep({ id: 'B', dependsOn: ['A'], status: 'completed' }),
    ];

    markDependentsDirty(steps, 'A', 1, 2, '2026-08-01T00:00:00.000Z');
    markDependentsDirty(steps, 'A', 2, 3, '2026-08-02T00:00:00.000Z');

    expect(steps[1].dirty).toEqual({
      causeStepId: 'A',
      causeVersionFrom: 2,
      causeVersionTo: 3,
      markedAt: '2026-08-02T00:00:00.000Z',
    });
  });
});

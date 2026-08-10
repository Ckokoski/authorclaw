import { describe, it, expect } from 'vitest';
import {
  resolveStepGate,
  applyStepCompletion,
  GATED_PHASES_DEFAULT,
  type Project,
  type ProjectStep,
} from './project-templates.js';

function makeProject(context: Project['context'] = {}): Project {
  return {
    id: 'p1',
    type: 'novel-pipeline',
    title: 'Test',
    description: '',
    status: 'active',
    progress: 0,
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    context,
  };
}

function makeStep(overrides: Partial<ProjectStep> = {}): ProjectStep {
  return {
    id: 's1',
    label: 'Step',
    taskType: 'general',
    prompt: 'do it',
    status: 'active',
    ...overrides,
  };
}

describe('resolveStepGate', () => {
  it('applies the locked template default: premise/bible/outline gate', () => {
    const project = makeProject();
    for (const phase of ['premise', 'bible', 'outline']) {
      expect(resolveStepGate(makeStep({ phase }), project)).toBe(true);
    }
  });

  it('applies the locked template default: writing/revision/polish/assembly auto', () => {
    const project = makeProject();
    for (const phase of ['writing', 'revision', 'polish', 'assembly']) {
      expect(resolveStepGate(makeStep({ phase }), project)).toBe(false);
    }
  });

  it('never gates a phase-less step by default', () => {
    const project = makeProject();
    expect(resolveStepGate(makeStep({ phase: undefined }), project)).toBe(false);
  });

  it('context.reviewGates overrides the template default for its phase', () => {
    const project = makeProject({ reviewGates: { writing: true, outline: false } });
    expect(resolveStepGate(makeStep({ phase: 'writing' }), project)).toBe(true);
    expect(resolveStepGate(makeStep({ phase: 'outline' }), project)).toBe(false);
    // Phases not mentioned in reviewGates still fall through to the template default.
    expect(resolveStepGate(makeStep({ phase: 'bible' }), project)).toBe(true);
  });

  it('step.gateEnabled wins over both reviewGates and the template default', () => {
    const project = makeProject({ reviewGates: { outline: true } });
    expect(resolveStepGate(makeStep({ phase: 'outline', gateEnabled: false }), project)).toBe(false);
    expect(resolveStepGate(makeStep({ phase: 'writing', gateEnabled: true }), project)).toBe(true);
  });

  it('GATED_PHASES_DEFAULT is exactly premise/bible/outline', () => {
    expect(Array.from(GATED_PHASES_DEFAULT).sort()).toEqual(['bible', 'outline', 'premise']);
  });
});

describe('applyStepCompletion', () => {
  it('a gated step reaching completion enters awaiting_review with an open gate, not completed', () => {
    const project = makeProject();
    const step = makeStep({ phase: 'outline' });

    applyStepCompletion(step, project, 'the outline text', '2026-01-02T00:00:00.000Z');

    expect(step.status).toBe('awaiting_review');
    expect(step.result).toBe('the outline text');
    expect(step.gate).toEqual({ state: 'open', openedAt: '2026-01-02T00:00:00.000Z' });
  });

  it('an ungated step completes exactly as it does today — byte-for-byte', () => {
    const project = makeProject();
    const step = makeStep({ phase: 'writing' });

    applyStepCompletion(step, project, 'chapter prose', '2026-01-02T00:00:00.000Z');

    expect(step).toEqual(makeStep({ phase: 'writing', status: 'completed', result: 'chapter prose' }));
    expect(step.gate).toBeUndefined();
  });

  it('respects a per-step gateEnabled override even for an auto-default phase', () => {
    const project = makeProject();
    const step = makeStep({ phase: 'writing', gateEnabled: true });

    applyStepCompletion(step, project, 'chapter prose');

    expect(step.status).toBe('awaiting_review');
    expect(step.gate?.state).toBe('open');
  });

  it('respects context.reviewGates turning off a normally-gated phase', () => {
    const project = makeProject({ reviewGates: { premise: false } });
    const step = makeStep({ phase: 'premise' });

    applyStepCompletion(step, project, 'premise text');

    expect(step.status).toBe('completed');
    expect(step.gate).toBeUndefined();
  });
});

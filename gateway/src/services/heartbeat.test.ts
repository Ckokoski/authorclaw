/**
 * Heartbeat autonomous-mode gate-blocking (M1.3 — ALP-1557).
 *
 * A gated step (StepExecutor.runStep opening a review gate instead of
 * completing — see step-executor-conductor.test.ts for the executor side)
 * must never be treated as a failure by the autonomous wake cycle: no
 * ❌ broadcast, no 'difficulty' journal entry, no contribution to
 * stepsThisWake / totalAutonomousSteps (the "failure or retry budget").
 * autonomousWake() is private; called directly via a cast, same as any
 * other white-box unit test of a private method.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { HeartbeatService, type AutonomousRunFunc, type AutonomousProjectListFunc } from './heartbeat.js';
import { MemoryService } from './memory.js';

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), 'heartbeat-test-'));
});
afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

/** quietHoursStart === quietHoursEnd (both 0) never trips the quiet-hours guard, at any hour. */
function makeHeartbeat(): HeartbeatService {
  const memory = new MemoryService(memoryDir, {});
  return new HeartbeatService({
    autonomousEnabled: true,
    quietHoursStart: 0,
    quietHoursEnd: 0,
    maxAutonomousStepsPerWake: 5,
  }, memory);
}

const oneActiveProject: AutonomousProjectListFunc = () => [{
  id: 'p1', title: 'Test Book', status: 'active', progress: '50%', progressNum: 50,
  stepsRemaining: 1, type: 'novel-pipeline',
}];

describe('heartbeat autonomous mode never touches a gated step (M1.3 — ALP-1557)', () => {
  it('a gated result is skipped silently — not counted toward failure or retry budgets', async () => {
    const hb = makeHeartbeat();
    const broadcasts: string[] = [];
    let calls = 0;
    const runStep: AutonomousRunFunc = async () => {
      calls++;
      return { gated: true, step: 'Outline' };
    };

    hb.setAutonomous(runStep, oneActiveProject, (msg) => broadcasts.push(msg));
    await (hb as any).autonomousWake();

    // Never retried within the same wake cycle despite maxAutonomousStepsPerWake=5.
    expect(calls).toBe(1);

    const status = hb.getAutonomousStatus();
    expect(status.totalStepsExecuted).toBe(0);
    expect(status.totalWordsGenerated).toBe(0);

    // No alarming failure broadcast — a gate is not a breakage.
    expect(broadcasts.some(m => m.includes('❌'))).toBe(false);
    expect(broadcasts.some(m => m.includes('🔒'))).toBe(true);

    // Journal records it as 'idle' (a pause), never 'difficulty' (a failure).
    const journal = hb.getJournal();
    expect(journal.some(e => e.type === 'difficulty')).toBe(false);
    expect(journal.some(e => e.type === 'idle' && e.message.includes('review gate'))).toBe(true);
  });

  it('does not mistake a gate for project completion (no false "complete!" message)', async () => {
    const hb = makeHeartbeat();
    const broadcasts: string[] = [];
    const runStep: AutonomousRunFunc = async () => ({ gated: true, step: 'Bible' });

    hb.setAutonomous(runStep, oneActiveProject, (msg) => broadcasts.push(msg));
    await (hb as any).autonomousWake();

    expect(broadcasts.some(m => m.includes('complete'))).toBe(false);
  });

  it('a mid-run failure is still reported and counted as a failure (gate handling did not swallow real errors)', async () => {
    const hb = makeHeartbeat();
    const broadcasts: string[] = [];
    const runStep: AutonomousRunFunc = async () => ({ error: 'boom' });

    hb.setAutonomous(runStep, oneActiveProject, (msg) => broadcasts.push(msg));
    await (hb as any).autonomousWake();

    expect(broadcasts.some(m => m.includes('❌'))).toBe(true);
    const journal = hb.getJournal();
    expect(journal.some(e => e.type === 'difficulty')).toBe(true);
  });

  it('a project with no actionable steps left (fully blocked behind a gate) is never selected at all', async () => {
    const hb = makeHeartbeat();
    let calls = 0;
    const runStep: AutonomousRunFunc = async () => { calls++; return { gated: true, step: 'x' }; };
    // stepsRemaining only counts pending/active steps — an awaiting_review
    // step (the gate) falls out of that count for free, so a project whose
    // only remaining step is gated reports 0 remaining and is filtered out
    // before autonomousRunStep is ever called.
    const listProjects: AutonomousProjectListFunc = () => [{
      id: 'p1', title: 'Fully Gated', status: 'active', progress: '90%', progressNum: 90,
      stepsRemaining: 0, type: 'novel-pipeline',
    }];

    hb.setAutonomous(runStep, listProjects, () => {});
    await (hb as any).autonomousWake();

    expect(calls).toBe(0);
  });
});

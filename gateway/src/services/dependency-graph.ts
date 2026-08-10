/**
 * Dirty Dependency Graph Service
 *
 * Computes the transitive closure of a project's step dependency graph
 * (edges are step.dependsOn, populated by deriveDependencies() in
 * project-templates.ts — no new graph data is created here) and marks every
 * completed step that transitively depends on a changed step `dirty`.
 *
 * Triggered when an already-approved step gains a new version: every
 * completed step downstream of it (directly or transitively) is stamped with
 * a DirtyMarker recording the cause and version range. `dirty` never touches
 * `status` — see DirtyMarker in project-templates.ts.
 */

import type { ProjectStep, DirtyMarker } from './project-templates.js';
import { logger } from './logger.js';

const log = logger.child('[dependency-graph]');

/**
 * Build a reverse adjacency map: stepId -> ids of the steps that list it in
 * their own `dependsOn` (its direct dependents).
 */
function buildDependentsIndex(steps: ProjectStep[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    if (!Array.isArray(step.dependsOn)) continue;
    for (const upstreamId of step.dependsOn) {
      const list = dependents.get(upstreamId);
      if (list) list.push(step.id);
      else dependents.set(upstreamId, [step.id]);
    }
  }
  return dependents;
}

/**
 * Compute every step id that transitively depends on `stepId` (directly, or
 * through any chain of dependsOn edges). Guarded with a visited set so
 * cyclic-looking `dependsOn` input terminates instead of hanging — cycles
 * should never occur in practice (deriveDependencies is acyclic by
 * construction) but this must not hang or crash if one somehow appears.
 */
export function computeTransitiveDependents(steps: ProjectStep[], stepId: string): Set<string> {
  const dependentsIndex = buildDependentsIndex(steps);
  const visited = new Set<string>();
  const queue: string[] = [stepId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const directDependents = dependentsIndex.get(current) ?? [];
    for (const dependentId of directDependents) {
      if (visited.has(dependentId)) continue; // cycle guard
      visited.add(dependentId);
      queue.push(dependentId);
    }
  }

  visited.delete(stepId); // a step is never its own dependent, even in a cycle
  return visited;
}

/**
 * Mark every completed step that transitively depends on `causeStepId`
 * dirty, mutating `steps` in place. Returns the ids of the steps actually
 * marked.
 *
 * Only `completed` steps are marked — pending/active/awaiting_review/
 * skipped/failed steps aren't touched; they'll pick up the new upstream
 * content the next time they run or get reviewed. `dirty` is orthogonal to
 * `status` (see DirtyMarker) — marking a step dirty never changes its status.
 */
export function markDependentsDirty(
  steps: ProjectStep[],
  causeStepId: string,
  causeVersionFrom: number,
  causeVersionTo: number,
  now: string = new Date().toISOString(),
): string[] {
  const dependentIds = computeTransitiveDependents(steps, causeStepId);
  if (dependentIds.size === 0) return [];

  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const marked: string[] = [];

  for (const id of dependentIds) {
    const step = stepsById.get(id);
    if (!step || step.status !== 'completed') continue;

    const marker: DirtyMarker = {
      causeStepId,
      causeVersionFrom,
      causeVersionTo,
      markedAt: now,
    };
    step.dirty = marker;
    marked.push(id);
  }

  if (marked.length > 0) {
    log.debug(`Marked ${marked.length} step(s) dirty (cause: ${causeStepId} v${causeVersionFrom}->v${causeVersionTo})`);
  }

  return marked;
}

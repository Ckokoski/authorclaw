/**
 * Project output path helpers (ALP-1548). Namespace step/manuscript outputs by
 * PHASE (project type, `phase-N-` prefixed in a chained pipeline) so a title's
 * phases live in named sibling folders instead of one intermixed heap. Filename
 * is unchanged (keeps the project id for uniqueness) — purely an added folder
 * level. Writer + assembly reader both go through these so they never drift.
 */
import { existsSync } from 'fs';
import { join } from 'path';

/** Filesystem-safe slug of a title/label. Never returns empty. */
export function slugify(text: string): string {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

/** Human-readable phase folder: project type, `phase-N-` prefixed in a pipeline. */
export function projectPhaseSlug(project: { type?: string; pipelinePhase?: number }): string {
  const type = slugify(project.type || 'project');
  return project.pipelinePhase ? `phase-${project.pipelinePhase}-${type}` : type;
}

/** Per-phase output dir: `projects/<title-slug>/<phase>`. */
export function projectOutputDir(
  workspaceDir: string,
  project: { title: string; type?: string; pipelinePhase?: number },
): string {
  return join(workspaceDir, 'projects', slugify(project.title), projectPhaseSlug(project));
}

/** Step filename within projectOutputDir — keeps project id so same-typed runs never collide. */
export function stepOutputFileName(step: { id: string; label: string }): string {
  return `${step.id}-${slugify(step.label)}.md`;
}

/** Legacy FLAT dir (pre-ALP-1548) for backward-compatible reads: `projects/<title-slug>`. */
export function legacyProjectOutputDir(
  workspaceDir: string,
  project: { title: string },
): string {
  return join(workspaceDir, 'projects', slugify(project.title));
}

/** True if `dir` holds this step's canonical .md or its `.versions/<id>/` sidecar. */
function hasStepArtifacts(dir: string, step: { id: string; label: string }): boolean {
  return existsSync(join(dir, '.versions', step.id)) || existsSync(join(dir, stepOutputFileName(step)));
}

/**
 * Dir holding ONE step's artifacts — canonical .md plus the `.versions/<id>/`
 * sidecar that doc-versions.ts and comments.ts both key off. Prefers the
 * per-phase dir, but falls back to the legacy flat dir when that's where this
 * step's artifacts already live, so version history and comments written before
 * ALP-1548 stay reachable (and a revision appends to the same version chain
 * rather than starting a second one in a sibling folder). Steps with no
 * artifacts anywhere resolve to the per-phase dir.
 *
 * Every reader/appender of a single step's artifacts must go through this —
 * the review routes and reviseStep previously each rebuilt the flat path
 * inline, which silently pointed them at a different folder than the writer.
 */
export function resolveStepArtifactDir(
  workspaceDir: string,
  project: { title: string; type?: string; pipelinePhase?: number },
  step: { id: string; label: string },
): string {
  const phaseDir = projectOutputDir(workspaceDir, project);
  if (hasStepArtifacts(phaseDir, step)) return phaseDir;
  const legacyDir = legacyProjectOutputDir(workspaceDir, project);
  if (hasStepArtifacts(legacyDir, step)) return legacyDir;
  return phaseDir;
}

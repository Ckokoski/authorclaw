/**
 * Project output path helpers (ALP-1548). Namespace step/manuscript outputs by
 * PHASE (project type, `phase-N-` prefixed in a chained pipeline) so a title's
 * phases live in named sibling folders instead of one intermixed heap. Filename
 * is unchanged (keeps the project id for uniqueness) — purely an added folder
 * level. Writer + assembly reader both go through these so they never drift.
 */
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

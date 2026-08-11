/**
 * AuthorAgent Book Bible Service
 *
 * Compiles a single canonical `book-bible.md` per book from data the
 * ContextEngine already maintains (entities, chapter summaries, open plot
 * threads) plus any authored planning-step files (character profiles,
 * world-building doc, premise) when present. Deterministic assembly — no AI
 * calls, no re-derivation of facts ContextEngine already tracked.
 *
 * Section structure mirrors skills/author/book-bible/SKILL.md: Characters,
 * Timeline, Locations, World Rules, Items & Objects.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ContextEngine, EntityEntry, ChapterSummary } from './context-engine.js';
import { resolveStepOutputPath } from './project-paths.js';

export interface ProjectStepLike {
  id: string;
  label: string;
  status: string;
}

export interface ProjectLike {
  id: string;
  title: string;
  steps: ProjectStepLike[];
}

export interface ProjectEngineLike {
  getProject(id: string): ProjectLike | undefined;
  listProjects(): ProjectLike[];
}

export interface BookBibleCompileResult {
  content: string;
  projectId: string;
  mergedProjectIds: string[];
  counts: {
    characters: number;
    locations: number;
    items: number;
    events: number;
    rules: number;
    chapters: number;
    planningNotes: number;
  };
}

class ProjectNotFoundError extends Error {
  code = 'PROJECT_NOT_FOUND';
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
  }
}

interface PlanningNote {
  kind: 'character' | 'world' | 'premise';
  label: string;
  body: string;
}

// Matches the step labels shipped in project-templates.ts ("Character
// profiles", "Character bible", "World-building document", "Develop
// premise") without hardcoding the exact phase-specific wording, so future
// label tweaks don't silently stop folding these in.
const CHARACTER_STEP_RE = /character/i;
const WORLD_STEP_RE = /world[\s-]?building/i;
const PREMISE_STEP_RE = /premise/i;

/** Same slug rule used throughout the codebase (documents.ts, projects.ts) for project directories. */
export function projectSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export class BookBibleService {
  constructor(private baseDir: string) {}

  /**
   * Compile the book bible for `projectId`. If sibling project ids share the
   * same title slug (e.g. a planning-phase project and a production-phase
   * project for the same book — see ALP-1548), their entities are merged in
   * too (deduped by lowercased name) so the bible isn't silently scoped to
   * one pipeline phase.
   */
  async compile(
    engine: ProjectEngineLike,
    contextEngine: ContextEngine,
    projectId: string,
  ): Promise<BookBibleCompileResult> {
    const project = engine.getProject(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    const slug = projectSlug(project.title);
    const siblingIds = engine
      .listProjects()
      .filter(p => projectSlug(p.title) === slug)
      .map(p => p.id);
    if (!siblingIds.includes(project.id)) siblingIds.push(project.id);

    // loadContext populates ContextEngine's in-memory cache — the
    // getEntitiesByType/getSummaries/getOpenPlotThreads reads below are pure
    // in-memory and return [] until this has run.
    for (const id of siblingIds) {
      await contextEngine.loadContext(id);
    }

    const characters = this.mergeEntities(contextEngine, siblingIds, 'character');
    const locations = this.mergeEntities(contextEngine, siblingIds, 'location');
    const items = this.mergeEntities(contextEngine, siblingIds, 'item');
    const events = this.mergeEntities(contextEngine, siblingIds, 'event');
    const rules = this.mergeEntities(contextEngine, siblingIds, 'rule');

    const summaries = siblingIds
      .flatMap(id => contextEngine.getSummaries(id))
      .sort((a, b) => a.chapterNumber - b.chapterNumber);

    const openThreads = this.mergeOpenThreads(contextEngine, siblingIds);
    const planningNotes = await this.collectPlanningNotes(engine, siblingIds);

    const content = renderBookBible({
      title: project.title,
      mergedProjectIds: siblingIds,
      characters,
      locations,
      items,
      events,
      rules,
      summaries,
      openThreads,
      planningNotes,
    });

    return {
      content,
      projectId,
      mergedProjectIds: siblingIds,
      counts: {
        characters: characters.length,
        locations: locations.length,
        items: items.length,
        events: events.length,
        rules: rules.length,
        chapters: summaries.length,
        planningNotes: planningNotes.length,
      },
    };
  }

  private mergeEntities(
    contextEngine: ContextEngine,
    projectIds: string[],
    type: EntityEntry['type'],
  ): EntityEntry[] {
    const merged: EntityEntry[] = [];
    const seen = new Set<string>();
    for (const id of projectIds) {
      for (const entity of contextEngine.getEntitiesByType(id, type)) {
        const key = entity.name.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entity);
      }
    }
    return merged;
  }

  private mergeOpenThreads(contextEngine: ContextEngine, projectIds: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of projectIds) {
      for (const thread of contextEngine.getOpenPlotThreads(id)) {
        const key = thread.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(thread);
      }
    }
    return merged;
  }

  /** Authored planning-step files are richer than the prose-extracted index — fold them in when present. */
  private async collectPlanningNotes(
    engine: ProjectEngineLike,
    projectIds: string[],
  ): Promise<PlanningNote[]> {
    const notes: PlanningNote[] = [];
    for (const id of projectIds) {
      const project = engine.getProject(id);
      if (!project) continue;

      for (const step of project.steps || []) {
        if (step.status !== 'completed') continue;
        const kind: PlanningNote['kind'] | null = CHARACTER_STEP_RE.test(step.label)
          ? 'character'
          : WORLD_STEP_RE.test(step.label)
            ? 'world'
            : PREMISE_STEP_RE.test(step.label)
              ? 'premise'
              : null;
        if (!kind) continue;

        // ALP-1548: resolve across the per-phase and legacy dirs. Keeps this
        // service's own baseDir/workspace convention — only the phase-vs-flat
        // lookup changes here.
        const filePath = resolveStepOutputPath(join(this.baseDir, 'workspace'), project, step);
        if (!existsSync(filePath)) continue;

        try {
          const raw = await readFile(filePath, 'utf-8');
          const body = raw.replace(/^# .+\n\n/, '').trim();
          if (body) notes.push({ kind, label: step.label, body });
        } catch {
          // Unreadable planning file — skip, don't fail the whole compile.
        }
      }
    }
    return notes;
  }
}

// ═══════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════

interface RenderInput {
  title: string;
  mergedProjectIds: string[];
  characters: EntityEntry[];
  locations: EntityEntry[];
  items: EntityEntry[];
  events: EntityEntry[];
  rules: EntityEntry[];
  summaries: ChapterSummary[];
  openThreads: string[];
  planningNotes: PlanningNote[];
}

function renderBookBible(d: RenderInput): string {
  const lines: string[] = [];

  lines.push(`# ${d.title} — Book Bible`, '');
  lines.push(
    d.mergedProjectIds.length > 1
      ? `_Merged from ${d.mergedProjectIds.length} pipeline phases: ${d.mergedProjectIds.join(', ')}._`
      : `_Compiled from ${d.mergedProjectIds[0]}._`,
    '',
  );

  const premiseNotes = d.planningNotes.filter(n => n.kind === 'premise');
  if (premiseNotes.length > 0) {
    lines.push('## Premise', '');
    for (const n of premiseNotes) lines.push(n.body, '');
  }

  lines.push('## Characters', '');
  lines.push(...renderEntitySection(d.characters, 'No characters tracked yet.'));
  const characterNotes = d.planningNotes.filter(n => n.kind === 'character');
  if (characterNotes.length > 0) {
    lines.push('### Authored Character Notes', '');
    for (const n of characterNotes) lines.push(`**${n.label}**`, '', n.body, '');
  }

  lines.push('## Timeline', '');
  if (d.summaries.length === 0) {
    lines.push('_No chapter timeline recorded yet._', '');
  } else {
    for (const s of d.summaries) {
      lines.push(`### Chapter ${s.chapterNumber} — ${s.title}`);
      if (s.timelineMarker) lines.push(`_${s.timelineMarker}_`);
      lines.push('', s.endingState || s.summary || '', '');
    }
  }
  if (d.events.length > 0) {
    lines.push('### Key Events', '');
    for (const e of d.events) lines.push(renderEntity(e));
  }
  lines.push('### Open Plot Threads', '');
  if (d.openThreads.length === 0) {
    lines.push('_None tracked yet._', '');
  } else {
    for (const t of d.openThreads) lines.push(`- ${t}`);
    lines.push('');
  }

  lines.push('## Locations', '');
  lines.push(...renderEntitySection(d.locations, 'No locations tracked yet.'));

  lines.push('## World Rules', '');
  lines.push(...renderEntitySection(d.rules, 'No world rules tracked yet.'));
  const worldNotes = d.planningNotes.filter(n => n.kind === 'world');
  if (worldNotes.length > 0) {
    lines.push('### Authored World-Building Notes', '');
    for (const n of worldNotes) lines.push(`**${n.label}**`, '', n.body, '');
  }

  lines.push('## Items & Objects', '');
  lines.push(...renderEntitySection(d.items, 'No items tracked yet.'));

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
}

function renderEntitySection(entities: EntityEntry[], emptyMessage: string): string[] {
  if (entities.length === 0) return [`_${emptyMessage}_`, ''];
  return entities.map(e => renderEntity(e));
}

function renderEntity(e: EntityEntry): string {
  const parts: string[] = [];
  const aliasStr = e.aliases && e.aliases.length ? ` (${e.aliases.join(', ')})` : '';
  parts.push(`### ${e.name}${aliasStr}`);
  if (e.description) parts.push(e.description);

  const attrs = Object.entries(e.attributes || {});
  if (attrs.length > 0) {
    parts.push(attrs.map(([k, v]) => `- **${k}:** ${v}`).join('\n'));
  }

  if (e.changes && e.changes.length > 0) {
    parts.push('**Changes:**\n' + e.changes.map(c => `- ${c.description} (${c.chapterId})`).join('\n'));
  }

  parts.push(`_First appearance: ${e.firstAppearance} · Last seen: ${e.lastSeen}_`);
  return parts.join('\n\n') + '\n';
}

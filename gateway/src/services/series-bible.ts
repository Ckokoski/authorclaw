/**
 * AuthorClaw Series Bible
 *
 * Cross-project memory for authors running multi-book series. Merges entity
 * indexes from every member project's ContextEngine into one canonical
 * series view, with alias-based deduplication, per-book delta tracking, and
 * contradiction detection across the whole universe.
 *
 * Complements (doesn't replace) the single-book ContextEngine: individual
 * projects still own their per-chapter summaries and entities; the Series
 * Bible unifies them when you're writing book 7 and need to remember a
 * background character's eye color from book 2.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { EntityEntry, ContextEngine } from './context-engine.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface SeriesEntity extends EntityEntry {
  firstBook: string;            // projectId where entity first appeared
  appearances: string[];        // projectIds the entity shows up in
  canonicalAttributes: Record<string, string>;  // reconciled across books
  bookDeltas: Array<{           // notable changes per book
    projectId: string;
    change: string;
  }>;
}

export interface TimelineEvent {
  projectId: string;
  chapterId: string;
  chapterNumber: number;
  bookTitle: string;
  timelineMarker: string;       // "Day 3, dawn" / "Two weeks later"
  endingState: string;
}

export interface SeriesContradiction {
  category: 'attribute' | 'timeline' | 'plot' | 'location';
  severity: 'warning' | 'error';
  entity?: string;
  description: string;
  books: string[];              // projectIds involved
  suggestion: string;
}

export interface Series {
  id: string;
  title: string;
  description: string;
  projectIds: string[];
  readingOrder: string[];       // project IDs in intended reading order
  createdAt: string;
  updatedAt: string;
}

export interface SeriesBibleReport {
  series: Series;
  entities: SeriesEntity[];
  timeline: TimelineEvent[];
  contradictions: SeriesContradiction[];
  stats: {
    totalBooks: number;
    totalWords: number;
    totalChapters: number;
    characterCount: number;
    locationCount: number;
  };
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class SeriesBibleService {
  private series: Map<string, Series> = new Map();
  private filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'series.json');
  }

  async initialize(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const series = Array.isArray(parsed.series) ? parsed.series : [];
      for (const s of series) this.series.set(s.id, s);
    } catch {
      // Corrupted — start fresh.
    }
  }

  // ── CRUD ──

  async createSeries(input: {
    title: string;
    description?: string;
    projectIds?: string[];
    readingOrder?: string[];
  }): Promise<Series> {
    const id = `series-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const series: Series = {
      id,
      title: input.title,
      description: input.description || '',
      projectIds: input.projectIds || [],
      readingOrder: input.readingOrder || input.projectIds || [],
      createdAt: now,
      updatedAt: now,
    };
    this.series.set(id, series);
    await this.persist();
    return series;
  }

  async addProject(seriesId: string, projectId: string): Promise<Series | null> {
    const series = this.series.get(seriesId);
    if (!series) return null;
    if (!series.projectIds.includes(projectId)) {
      series.projectIds.push(projectId);
      if (!series.readingOrder.includes(projectId)) {
        series.readingOrder.push(projectId);
      }
      series.updatedAt = new Date().toISOString();
      await this.persist();
    }
    return series;
  }

  async removeProject(seriesId: string, projectId: string): Promise<Series | null> {
    const series = this.series.get(seriesId);
    if (!series) return null;
    series.projectIds = series.projectIds.filter(id => id !== projectId);
    series.readingOrder = series.readingOrder.filter(id => id !== projectId);
    series.updatedAt = new Date().toISOString();
    await this.persist();
    return series;
  }

  async setReadingOrder(seriesId: string, order: string[]): Promise<Series | null> {
    const series = this.series.get(seriesId);
    if (!series) return null;
    // Only keep IDs that are actually in the series.
    series.readingOrder = order.filter(id => series.projectIds.includes(id));
    series.updatedAt = new Date().toISOString();
    await this.persist();
    return series;
  }

  getSeries(seriesId: string): Series | undefined {
    return this.series.get(seriesId);
  }

  listSeries(): Series[] {
    return Array.from(this.series.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteSeries(seriesId: string): Promise<boolean> {
    const existed = this.series.delete(seriesId);
    if (existed) await this.persist();
    return existed;
  }

  /**
   * Build the unified bible by pulling every project's ContextEngine data
   * and merging entities + timeline. Does NOT mutate the individual project
   * contexts — this is a read-only view.
   */
  async buildReport(
    seriesId: string,
    contextEngine: ContextEngine,
    projectTitleResolver: (projectId: string) => string | undefined,
  ): Promise<SeriesBibleReport | null> {
    const series = this.series.get(seriesId);
    if (!series) return null;

    const mergedEntities = new Map<string, SeriesEntity>();
    const timeline: TimelineEvent[] = [];
    const contradictions: SeriesContradiction[] = [];
    let totalWords = 0;
    let totalChapters = 0;

    // Preserve reading order.
    const orderedProjectIds = series.readingOrder.length > 0
      ? series.readingOrder
      : series.projectIds;

    for (const projectId of orderedProjectIds) {
      const bookTitle = projectTitleResolver(projectId) || projectId;
      let ctx;
      try {
        ctx = await contextEngine.loadContext(projectId);
      } catch {
        continue;
      }
      if (!ctx) continue;

      // Timeline events
      for (const summary of ctx.summaries) {
        timeline.push({
          projectId,
          chapterId: summary.chapterId,
          chapterNumber: summary.chapterNumber,
          bookTitle,
          timelineMarker: summary.timelineMarker || '',
          endingState: summary.endingState || '',
        });
        totalWords += summary.wordCount || 0;
        totalChapters++;
      }

      // Merge entities (alias-aware).
      for (const entity of ctx.entities) {
        const key = this.entityKey(entity);
        const existing = mergedEntities.get(key);
        if (existing) {
          // Same entity already seen in earlier book — merge.
          this.mergeEntity(existing, entity, projectId, contradictions, bookTitle);
        } else {
          // New entity — seed it.
          mergedEntities.set(key, {
            ...entity,
            firstBook: projectId,
            appearances: [projectId],
            canonicalAttributes: { ...entity.attributes },
            bookDeltas: (entity.changes || []).map(c => ({
              projectId,
              change: c.description,
            })),
          });
        }
      }
    }

    // Timeline ordering sanity check.
    this.checkTimelineMonotonic(timeline, contradictions);

    const entities = Array.from(mergedEntities.values());
    const characterCount = entities.filter(e => e.type === 'character').length;
    const locationCount = entities.filter(e => e.type === 'location').length;

    return {
      series,
      entities,
      timeline,
      contradictions,
      stats: {
        totalBooks: orderedProjectIds.length,
        totalWords,
        totalChapters,
        characterCount,
        locationCount,
      },
    };
  }

  /** Key used to merge entities across books — canonical name lowercase. */
  private entityKey(entity: EntityEntry): string {
    return (entity.name || '').toLowerCase().trim();
  }

  /** Merge a new entity into an existing canonical entry. */
  private mergeEntity(
    canonical: SeriesEntity,
    incoming: EntityEntry,
    projectId: string,
    contradictions: SeriesContradiction[],
    bookTitle: string,
  ): void {
    if (!canonical.appearances.includes(projectId)) {
      canonical.appearances.push(projectId);
    }

    // Merge aliases
    for (const alias of incoming.aliases || []) {
      if (!canonical.aliases.some(a => a.toLowerCase() === alias.toLowerCase())) {
        canonical.aliases.push(alias);
      }
    }

    // Check attribute contradictions and merge.
    for (const [key, value] of Object.entries(incoming.attributes || {})) {
      const canonicalValue = canonical.canonicalAttributes[key];
      if (canonicalValue && canonicalValue.toLowerCase().trim() !== value.toLowerCase().trim()) {
        // Soft-contradiction: flag it, but accept the newer value as a delta.
        contradictions.push({
          category: 'attribute',
          severity: 'warning',
          entity: canonical.name,
          description: `"${canonical.name}"'s ${key}: "${canonicalValue}" (earlier) vs "${value}" (${bookTitle}).`,
          books: [canonical.firstBook, projectId],
          suggestion: `Decide which book is canon for this attribute, or add a timeline event explaining the change.`,
        });
        canonical.bookDeltas.push({
          projectId,
          change: `${key} changed from "${canonicalValue}" to "${value}"`,
        });
      }
      canonical.canonicalAttributes[key] = value;
    }

    // Prefer the longest description.
    if (incoming.description && incoming.description.length > canonical.description.length) {
      canonical.description = incoming.description;
    }
  }

  /** Check that timeline markers in the same chapter don't jump backwards illogically. */
  private checkTimelineMonotonic(timeline: TimelineEvent[], contradictions: SeriesContradiction[]): void {
    // Extract weak ordering signals from timeline markers (days, weeks, years).
    const withDay = timeline
      .map((ev, idx) => ({ ev, idx, day: this.extractDay(ev.timelineMarker) }))
      .filter(t => t.day !== null);

    for (let i = 1; i < withDay.length; i++) {
      const prev = withDay[i - 1];
      const curr = withDay[i];
      // Only flag if in the same book to avoid cross-book time jumps.
      if (prev.ev.projectId !== curr.ev.projectId) continue;
      if ((curr.day! < prev.day!) && (prev.ev.chapterNumber < curr.ev.chapterNumber)) {
        contradictions.push({
          category: 'timeline',
          severity: 'warning',
          description: `Timeline moves backward: Ch ${prev.ev.chapterNumber} says "${prev.ev.timelineMarker}" but Ch ${curr.ev.chapterNumber} says "${curr.ev.timelineMarker}".`,
          books: [curr.ev.projectId],
          suggestion: `Review chapter order or clarify the timeline markers.`,
        });
      }
    }
  }

  /** Very rough day-number extractor from a timeline marker string. */
  private extractDay(marker: string): number | null {
    if (!marker) return null;
    const dayMatch = marker.match(/day\s+(\d+)/i);
    if (dayMatch) return parseInt(dayMatch[1], 10);
    const weekMatch = marker.match(/week\s+(\d+)/i);
    if (weekMatch) return parseInt(weekMatch[1], 10) * 7;
    const monthMatch = marker.match(/month\s+(\d+)/i);
    if (monthMatch) return parseInt(monthMatch[1], 10) * 30;
    return null;
  }

  // ── Persistence ──

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify({ series: Array.from(this.series.values()) }, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist series bible:', err);
    }
  }
}

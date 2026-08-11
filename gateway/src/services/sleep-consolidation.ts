/**
 * AuthorAgent Sleep-Time Consolidation Service
 *
 * Chunk C of the Tiered Memory + Sleep-Time Consolidation design. This is the
 * background job that MATERIALIZES the CoreDigest ({projectId}-core.json) read
 * on the hot path by MemoryTierService, plus keeps the surrounding memory
 * substrate tidy (preferences pruned, FTS index reindexed + ownership
 * backfilled, series bible refreshed).
 *
 * It owns NO new data. Every pass reads existing memory (ContextEngine,
 * SeriesBible, PreferenceStore, MemorySearch) and writes back into those same
 * stores or the small materialized digest. Nothing here is destructive beyond
 * the explicitly-scoped preference prune (which never touches explicit prefs).
 *
 * ── Governing constraints (from the design) ──
 *   1. COST RULE (critical): every AI call MUST resolve to a FREE-tier provider.
 *      We only ever request task types 'general' | 'research' | 'marketing',
 *      which the AI router maps to the free tier (gemini → ollama → deepseek).
 *      We NEVER use 'creative_writing' / 'consistency' / 'final_edit' here.
 *      Small maxTokens per call and a hard cap (~10) on total AI calls per
 *      project per run.
 *   2. RESILIENCE: the eight passes run IN ORDER, but each is wrapped in its own
 *      try/catch. A failing pass logs and the run continues — we never abort the
 *      whole job because one pass threw.
 *   3. GUARD: optional dependencies (memorySearch, seriesBible) degrade to a
 *      skipped pass when unavailable rather than crashing.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

import type { ContextEngine } from './context-engine.js';
import type { SeriesBibleService } from './series-bible.js';
import type { PreferenceStore } from './preferences.js';
import type { MemorySearchService } from './memory-search.js';
import type { MemoryTierService, CoreDigest } from './memory-tier.js';
import { resolveStepOutputPath } from './project-paths.js';

// ═══════════════════════════════════════════════════════════
// Injected closure / port types
// ═══════════════════════════════════════════════════════════

/** AI completion closure — identical shape to the router's complete(). */
export type SleepAICompleteFn = (request: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed: number; estimatedCost: number; provider: string }>;

/**
 * Provider selection closure. The real router returns the full AIProvider
 * (which carries a `tier`); we widen the return type to expose `tier` so the
 * cost-rule guard can assert free-tier before spending a call. `tier` is
 * optional so a bare `{ id }` stub still satisfies the type.
 */
export type SleepAISelectProviderFn = (taskType: string) => { id: string; tier?: string };

/** Narrow port over ProjectEngine — just enough to enumerate + resolve. */
export interface SleepProjectPort {
  listProjects(status?: string): Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    personaId?: string;
    steps: Array<{ id: string; label: string; chapterNumber?: number; status: string; phase?: string; result?: string }>;
  }>;
  getProject(id: string): {
    id: string;
    title: string;
    personaId?: string;
    steps: Array<{ id: string; label: string; chapterNumber?: number; status: string; phase?: string; result?: string }>;
  } | undefined;
}

// ═══════════════════════════════════════════════════════════
// Tuning constants
// ═══════════════════════════════════════════════════════════

/** Hard cap on AI calls per project per run (design: ~10). */
export const MAX_AI_CALLS_PER_PROJECT = 10;

/** Free-tier task types this job is allowed to request. Nothing else. */
const FREE_TASK_TYPES = new Set(['general', 'research', 'marketing']);

/** Per-call token budgets (kept small — this is background summarization). */
const TOKENS = {
  arc: 300,
  thread: 500,
  style: 400,
} as const;

/** How many newest chapters to (re)sweep for entities per run. */
const NEWEST_CHAPTERS_TO_SWEEP = 2;
/** How many promoted/major characters to (re)summarize per run. */
const MAX_ARCS_PER_RUN = 5;
/** Preference prune age threshold (design: >90 days, non-explicit only). */
const PREF_MAX_AGE_DAYS = 90;
/** Style digest hard cap (design: ≤600 chars). */
const STYLE_DIGEST_MAX = 600;

// ═══════════════════════════════════════════════════════════
// Result types
// ═══════════════════════════════════════════════════════════

interface PassOutcome {
  ok: boolean;
  detail: string;
}

export interface SleepRunProjectResult {
  projectId: string;
  title: string;
  aiCalls: number;
  passes: Record<string, PassOutcome>;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class SleepConsolidationService {
  private contextEngine: ContextEngine;
  private seriesBible: SeriesBibleService | null;
  private preferences: PreferenceStore;
  private memorySearch: MemorySearchService | null;
  private memoryTier: MemoryTierService;
  private projects: SleepProjectPort;
  private aiComplete: SleepAICompleteFn;
  private aiSelectProvider: SleepAISelectProviderFn;
  private workspaceDir: string;

  constructor(deps: {
    contextEngine: ContextEngine;
    seriesBible: SeriesBibleService | null;
    preferences: PreferenceStore;
    memorySearch: MemorySearchService | null;
    memoryTier: MemoryTierService;
    projects: SleepProjectPort;
    aiComplete: SleepAICompleteFn;
    aiSelectProvider: SleepAISelectProviderFn;
    workspaceDir: string;
  }) {
    this.contextEngine = deps.contextEngine;
    this.seriesBible = deps.seriesBible;
    this.preferences = deps.preferences;
    this.memorySearch = deps.memorySearch;
    this.memoryTier = deps.memoryTier;
    this.projects = deps.projects;
    this.aiComplete = deps.aiComplete;
    this.aiSelectProvider = deps.aiSelectProvider;
    this.workspaceDir = deps.workspaceDir;
  }

  /**
   * Cron entry point (CronHandler shape). Consolidates one project (when
   * payload.projectId is given) or every enumerable project.
   *
   * Never rejects on a pass failure — each pass is independently guarded and
   * failures are surfaced in `details` while the run reports success.
   */
  async run(
    payload: { projectId?: string } = {},
  ): Promise<{ success: boolean; message: string; details?: any }> {
    const targets = this.resolveTargets(payload.projectId);
    if (targets.length === 0) {
      return { success: true, message: 'No projects to consolidate', details: { projects: [] } };
    }

    const results: SleepRunProjectResult[] = [];
    for (const t of targets) {
      results.push(await this.consolidateProject(t));
    }

    const totalCalls = results.reduce((n, r) => n + r.aiCalls, 0);
    const failedPasses = results.reduce(
      (n, r) => n + Object.values(r.passes).filter(p => !p.ok).length,
      0,
    );
    return {
      success: true,
      message:
        `Consolidated ${results.length} project(s), ${totalCalls} free-tier AI call(s)` +
        (failedPasses > 0 ? `, ${failedPasses} pass(es) skipped/failed` : ''),
      details: { projects: results },
    };
  }

  // ── Target resolution ─────────────────────────────────────

  private resolveTargets(projectId?: string): Array<{ id: string; title: string; personaId?: string }> {
    if (projectId) {
      const p = this.projects.getProject(projectId);
      return p ? [{ id: p.id, title: p.title, personaId: p.personaId }] : [];
    }
    return this.projects
      .listProjects()
      .map(p => ({ id: p.id, title: p.title, personaId: p.personaId }));
  }

  // ── Per-project orchestration ─────────────────────────────

  private async consolidateProject(
    target: { id: string; title: string; personaId?: string },
  ): Promise<SleepRunProjectResult> {
    const projectId = target.id;
    const passes: Record<string, PassOutcome> = {};
    // Budget object threaded through passes so the ~10-call cap is shared.
    const budget = { calls: 0, max: MAX_AI_CALLS_PER_PROJECT };

    // Load the context once so passes work off cached data.
    try {
      await this.contextEngine.loadContext(projectId);
    } catch { /* empty/absent context is fine — passes degrade */ }

    // Accumulate the digest fields as passes produce them; merge onto any
    // existing digest so a partial run never wipes prior good data.
    const prior = this.memoryTier.loadCoreDigest(projectId) ?? {};
    const digest: CoreDigest = { ...prior };

    // ── Pass 1: refresh entity index on newest un-swept chapters ──
    passes.entityRefresh = await this.guard('entityRefresh', () =>
      this.passRefreshEntities(projectId, budget),
    );

    // ── Pass 2: re-summarize each promoted/major character's arc ──
    passes.arcs = await this.guard('arcs', async () => {
      const arcs = await this.passSummarizeArcs(projectId, budget);
      if (Object.keys(arcs).length > 0) digest.arcs = { ...(digest.arcs ?? {}), ...arcs };
      return `${Object.keys(arcs).length} arc(s) summarized`;
    });

    // ── Pass 3: classify plot threads open|resolved ──
    passes.threads = await this.guard('threads', async () => {
      const { open, resolved } = await this.passClassifyThreads(projectId, budget);
      digest.openThreads = open;
      digest.resolvedThreads = resolved;
      return `${open.length} open, ${resolved.length} resolved`;
    });

    // ── Pass 4: distill style digest ──
    passes.style = await this.guard('style', async () => {
      const style = await this.passDistillStyle(budget);
      if (style) digest.styleDigest = style;
      return style ? `${style.length} chars` : 'no style source';
    });

    // ── Pass 5: refresh Series Bible for this project's series ──
    passes.seriesBible = await this.guard('seriesBible', () =>
      this.passRefreshSeriesBible(projectId),
    );

    // ── Pass 6: prune stale preferences ──
    passes.preferences = await this.guard('preferences', async () => {
      const removed = await this.preferences.prune(new Date().toISOString(), {
        maxAgeDays: PREF_MAX_AGE_DAYS,
        protectSources: ['explicit'],
      });
      return `${removed.length} pref(s) pruned`;
    });

    // ── Pass 7: reindex FTS + backfill project_id/persona_id ──
    passes.reindex = await this.guard('reindex', () => this.passReindexAndBackfill());

    // Compute the promoted baseline (top recurring characters) for the digest.
    digest.promotedBaseline = this.computePromotedBaseline(projectId);
    digest.computedAt = new Date().toISOString();

    // ── Pass 8: materialize CORE digest ──
    passes.materialize = await this.guard('materialize', async () => {
      this.memoryTier.writeCoreDigest(projectId, {
        styleDigest: digest.styleDigest,
        openThreads: digest.openThreads,
        resolvedThreads: digest.resolvedThreads,
        arcs: digest.arcs,
        promotedBaseline: digest.promotedBaseline,
        computedAt: digest.computedAt,
      });
      return 'core.json written';
    });

    return { projectId, title: target.title, aiCalls: budget.calls, passes };
  }

  /** Run a pass body, converting throws into a failed PassOutcome (never rethrows). */
  private async guard(name: string, body: () => Promise<string>): Promise<PassOutcome> {
    try {
      const detail = await body();
      return { ok: true, detail };
    } catch (err: any) {
      const detail = err?.message || String(err);
      console.warn(`  [sleep-consolidation] pass "${name}" failed: ${detail}`);
      return { ok: false, detail };
    }
  }

  // ── AI helper (enforces the cost rule) ────────────────────

  /**
   * Select a FREE-tier provider for `taskType` and run a completion, counting
   * it against the per-project budget. Throws (caught by the pass guard) when:
   *   - taskType isn't in the allow-list (programmer error / cost-rule breach),
   *   - the resolved provider is not free tier (cost-rule breach),
   *   - the budget is exhausted.
   */
  private async freeComplete(
    budget: { calls: number; max: number },
    taskType: 'general' | 'research' | 'marketing',
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<string> {
    if (budget.calls >= budget.max) {
      throw new Error(`AI call budget exhausted (${budget.max})`);
    }
    // resolveFreeProvider enforces the allow-list + free-tier rule (fails closed).
    const provider = this.resolveFreeProvider(taskType);
    budget.calls++;
    const res = await this.aiComplete({
      provider: provider.id,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      temperature: 0.2,
    });
    return (res.text || '').trim();
  }

  // ═══════════════════════════════════════════════════════════
  // Pass implementations
  // ═══════════════════════════════════════════════════════════

  /** Pass 1 — extract entities on the newest chapters we can read text for. */
  private async passRefreshEntities(
    projectId: string,
    budget: { calls: number; max: number },
  ): Promise<string> {
    const summaries = this.contextEngine.getSummaries(projectId);
    if (summaries.length === 0) return 'no chapters';

    // Newest chapters first.
    const newest = [...summaries]
      .sort((a, b) => b.chapterNumber - a.chapterNumber)
      .slice(0, NEWEST_CHAPTERS_TO_SWEEP);

    // Cost-rule gate: resolve the free provider ONCE up front. If it isn't free
    // (mis-set global preference), throw now so the guarded pass records a
    // failure WITHOUT ever spending a completion. extractEntities is then fed a
    // selector that returns this verified provider and a complete-closure that
    // re-checks the tier — so entity extraction can never escape the cost rule.
    const freeProvider = this.resolveFreeProvider('general');
    const selectFree = (): { id: string } => ({ id: freeProvider.id });
    const guardedComplete = (req: Parameters<SleepAICompleteFn>[0]) => {
      const p = this.aiSelectProvider('general');
      if (p.tier && p.tier !== 'free') {
        return Promise.reject(new Error(`cost-rule: provider "${p.id}" resolved to non-free tier "${p.tier}"`));
      }
      return this.aiComplete(req);
    };

    const project = this.projects.getProject(projectId);
    let swept = 0;
    for (const chapter of newest) {
      if (budget.calls >= budget.max) break;
      const text = await this.readChapterText(project, chapter.chapterId, chapter.summary);
      if (!text) continue;
      // extractEntities routes through 'general' internally (free tier). We
      // account for the call against our budget so the ~10 cap holds.
      budget.calls++;
      await this.contextEngine.extractEntities(
        projectId,
        chapter.chapterId,
        text,
        guardedComplete,
        selectFree,
      );
      swept++;
    }
    return `${swept} chapter(s) swept`;
  }

  /**
   * Resolve a provider for a free-tier task type, THROWING if the router hands
   * back a non-free provider (fail closed on any cost-rule breach). Only the
   * three allow-listed task types are accepted.
   */
  private resolveFreeProvider(taskType: 'general' | 'research' | 'marketing'): { id: string; tier?: string } {
    if (!FREE_TASK_TYPES.has(taskType)) {
      throw new Error(`cost-rule: task type "${taskType}" is not free-tier`);
    }
    const provider = this.aiSelectProvider(taskType);
    if (provider.tier && provider.tier !== 'free') {
      throw new Error(`cost-rule: provider "${provider.id}" resolved to non-free tier "${provider.tier}"`);
    }
    return provider;
  }

  /** Read a chapter's full prose from disk (preferred) or fall back to summary. */
  private async readChapterText(
    project: ReturnType<SleepProjectPort['getProject']>,
    chapterStepId: string,
    fallbackSummary: string,
  ): Promise<string> {
    if (project) {
      const step = project.steps.find(s => s.id === chapterStepId);
      // Inline result is cheapest.
      if (step?.result && step.result.length > 200) return step.result;
      // Else try the on-disk step file: workspace/projects/<slug>/<stepId>-<slug>.md
      try {
        if (step) {
          // ALP-1548: per-phase dir first, legacy flat dir as fallback.
          const path = resolveStepOutputPath(this.workspaceDir, project, step);
          if (existsSync(path)) {
            const raw = await readFile(path, 'utf-8');
            const body = raw.replace(/^#\s.+\n\n/, '');
            if (body.trim().length > 200) return body;
          }
        }
      } catch { /* fall through to summary */ }
    }
    // Last resort: the cached summary is short but still useful entity material.
    return (fallbackSummary || '').trim();
  }

  /** Pass 2 — 1–2 sentence arc per major/promoted character. */
  private async passSummarizeArcs(
    projectId: string,
    budget: { calls: number; max: number },
  ): Promise<Record<string, string>> {
    const characters = this.contextEngine.getEntitiesByType(projectId, 'character');
    if (characters.length === 0) return {};

    // Rank by recurrence (appearances across summaries + change-log length),
    // take the top few so we stay within the call cap.
    const summaries = this.contextEngine.getSummaries(projectId);
    const appearances = (name: string, aliases: string[]): number => {
      const names = new Set([name.toLowerCase().trim(), ...aliases.map(a => a.toLowerCase().trim())]);
      let n = 0;
      for (const s of summaries) for (const c of s.characters ?? []) if (names.has(c.toLowerCase().trim())) n++;
      return n;
    };
    const ranked = [...characters]
      .sort((a, b) =>
        (appearances(b.name, b.aliases) + (b.changes?.length ?? 0)) -
        (appearances(a.name, a.aliases) + (a.changes?.length ?? 0)),
      )
      .slice(0, MAX_ARCS_PER_RUN);

    const arcs: Record<string, string> = {};
    const system =
      'You are a story analyst. In AT MOST 2 sentences, summarize this ' +
      'character\'s arc so far (who they are + how they have changed). No ' +
      'preamble, no markdown, plain prose only.';
    for (const c of ranked) {
      if (budget.calls >= budget.max) break;
      const changeLog = (c.changes ?? []).map(ch => `- ${ch.description}`).join('\n');
      const attrs = Object.entries(c.attributes ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      const user =
        `Character: ${c.name}\n` +
        (c.description ? `Description: ${c.description}\n` : '') +
        (attrs ? `Attributes: ${attrs}\n` : '') +
        (changeLog ? `Changes across chapters:\n${changeLog}\n` : '');
      const arc = await this.freeComplete(budget, 'general', system, user, TOKENS.arc);
      if (arc) arcs[c.name] = this.clampSentences(arc, 2);
    }
    return arcs;
  }

  /** Pass 3 — classify each open plot thread as open|resolved. */
  private async passClassifyThreads(
    projectId: string,
    budget: { calls: number; max: number },
  ): Promise<{ open: string[]; resolved: string[] }> {
    const threads = this.contextEngine.getOpenPlotThreads(projectId);
    if (threads.length === 0) return { open: [], resolved: [] };

    const summaries = this.contextEngine.getSummaries(projectId);
    // Feed the classifier the most recent ending states as evidence of what has
    // been paid off — kept short to stay cheap.
    const recentStates = [...summaries]
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
      .slice(-6)
      .map(s => `Ch ${s.chapterNumber}: ${s.endingState || s.summary}`.slice(0, 300))
      .join('\n');

    const system =
      'You are a story analyst. Given a list of plot threads and recent ' +
      'chapter ending-states, classify each thread as "open" (still unresolved) ' +
      'or "resolved" (paid off / concluded). Return ONLY valid JSON: ' +
      '{"threads":[{"thread":"...","status":"open"}]}. No markdown, no commentary.';
    const user =
      `Plot threads:\n${threads.map(t => `- ${t}`).join('\n')}\n\n` +
      `Recent chapter endings:\n${recentStates}`;

    let raw = '';
    // Budget guard is inside freeComplete; if exhausted it throws → guarded pass
    // records failure but the digest keeps prior thread data (merged upstream).
    raw = await this.freeComplete(budget, 'research', system, user, TOKENS.thread);

    const open: string[] = [];
    const resolved: string[] = [];
    const parsed = this.safeJson(raw);
    const rows: Array<{ thread?: string; status?: string }> = parsed?.threads ?? [];
    const byLower = new Map(threads.map(t => [t.toLowerCase().trim(), t]));
    const classified = new Set<string>();
    for (const row of rows) {
      const t = byLower.get(String(row.thread || '').toLowerCase().trim());
      if (!t) continue;
      classified.add(t.toLowerCase().trim());
      if (String(row.status).toLowerCase().startsWith('resolv')) resolved.push(t);
      else open.push(t);
    }
    // Any thread the model didn't classify stays open (conservative default).
    for (const t of threads) {
      if (!classified.has(t.toLowerCase().trim())) open.push(t);
    }
    return { open, resolved };
  }

  /** Pass 4 — distill a ≤600-char style digest from SOUL/STYLE-GUIDE/VOICE. */
  private async passDistillStyle(budget: { calls: number; max: number }): Promise<string> {
    const soulDir = join(this.workspaceDir, 'soul');
    const sources: string[] = [];
    for (const file of ['SOUL.md', 'STYLE-GUIDE.md', 'VOICE-PROFILE.md']) {
      try {
        const path = join(soulDir, file);
        if (existsSync(path)) {
          const raw = await readFile(path, 'utf-8');
          if (raw.trim()) sources.push(`## ${file}\n${raw.trim().slice(0, 4000)}`);
        }
      } catch { /* skip unreadable file */ }
    }

    // Fallback: no AI budget or no sources → first 600 chars of STYLE-GUIDE.
    const styleGuideFallback = (): string => {
      try {
        const path = join(soulDir, 'STYLE-GUIDE.md');
        if (!existsSync(path)) return '';
        // NOTE: readFileSync-free path — reuse the already-read source if present.
        const sg = sources.find(s => s.startsWith('## STYLE-GUIDE.md'));
        const body = sg ? sg.replace(/^## STYLE-GUIDE\.md\n/, '') : '';
        return body.slice(0, STYLE_DIGEST_MAX).trim();
      } catch { return ''; }
    };

    if (sources.length === 0) return '';
    if (budget.calls >= budget.max) return styleGuideFallback();

    const system =
      'You are a style editor. Distill the author\'s writing voice and style ' +
      'rules into a single dense paragraph of AT MOST 600 characters. Focus on ' +
      'POV, tense, sentence rhythm, diction, and hard do/don\'t rules. Plain ' +
      'prose only, no headings, no preamble.';
    let digest = '';
    try {
      digest = await this.freeComplete(budget, 'general', system, sources.join('\n\n'), TOKENS.style);
    } catch {
      return styleGuideFallback();
    }
    digest = digest.trim();
    if (!digest) return styleGuideFallback();
    return digest.length > STYLE_DIGEST_MAX ? digest.slice(0, STYLE_DIGEST_MAX).trimEnd() : digest;
  }

  /** Pass 5 — refresh (rebuild) the Series Bible report for this project's series. */
  private async passRefreshSeriesBible(projectId: string): Promise<string> {
    if (!this.seriesBible) return 'series bible unavailable';
    const all = this.seriesBible.listSeries();
    const owning = all.find(s => s.projectIds.includes(projectId));
    if (!owning) return 'project not in any series';
    const report = await this.seriesBible.buildReport(
      owning.id,
      this.contextEngine,
      (id) => this.projects.getProject(id)?.title,
    );
    if (!report) return 'series report null';
    return `series "${owning.title}": ${report.entities.length} entities, ${report.contradictions.length} contradiction(s)`;
  }

  /** Pass 7 — reindex FTS then backfill project_id/persona_id via a slug→owner map. */
  private async passReindexAndBackfill(): Promise<string> {
    if (!this.memorySearch || !this.memorySearch.isAvailable()) return 'search unavailable';
    const r = await this.memorySearch.reindexAll();
    const slugMap = this.buildSlugMap();
    const bf = this.memorySearch.backfillOwnership(slugMap);
    return `indexed ${r.indexed}, skipped ${r.skipped}, backfilled ${bf.updated} row(s)`;
  }

  /**
   * Build a map of project SLUG → { projectId, personaId } for FTS ownership
   * backfill. Only slugs that map to EXACTLY one project are included — when two
   * projects share a slug the ownership is ambiguous, so we omit it entirely and
   * leave those rows null (never guess).
   */
  private buildSlugMap(): Map<string, { projectId: string; personaId: string | null }> {
    const bySlug = new Map<string, Array<{ projectId: string; personaId: string | null }>>();
    for (const p of this.projects.listProjects()) {
      const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const entry = { projectId: p.id, personaId: p.personaId ?? null };
      const arr = bySlug.get(slug);
      if (arr) arr.push(entry);
      else bySlug.set(slug, [entry]);
    }
    const map = new Map<string, { projectId: string; personaId: string | null }>();
    for (const [slug, entries] of bySlug) {
      if (entries.length === 1) map.set(slug, entries[0]); // unambiguous only
    }
    return map;
  }

  /** Baseline top recurring characters, for the digest's promotedBaseline. */
  private computePromotedBaseline(projectId: string): string[] {
    const characters = this.contextEngine.getEntitiesByType(projectId, 'character');
    if (characters.length === 0) return [];
    const summaries = this.contextEngine.getSummaries(projectId);
    const score = (name: string, aliases: string[]): number => {
      const names = new Set([name.toLowerCase().trim(), ...aliases.map(a => a.toLowerCase().trim())]);
      let n = 0;
      for (const s of summaries) for (const c of s.characters ?? []) if (names.has(c.toLowerCase().trim())) n++;
      return n;
    };
    return [...characters]
      .sort((a, b) => score(b.name, b.aliases) - score(a.name, a.aliases))
      .slice(0, 4)
      .map(c => c.name);
  }

  // ── small utils ───────────────────────────────────────────

  /** Best-effort JSON parse (strips code fences); returns null on failure. */
  private safeJson(text: string): any {
    if (!text) return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }

  /** Clamp free text to at most N sentences. */
  private clampSentences(text: string, n: number): string {
    const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g);
    if (!parts || parts.length <= n) return text.replace(/\s+/g, ' ').trim();
    return parts.slice(0, n).join(' ').trim();
  }
}

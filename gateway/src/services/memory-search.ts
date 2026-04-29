/**
 * AuthorClaw Memory Search
 *
 * SQLite + FTS5 full-text search across every conversation turn AuthorClaw
 * has ever logged + every project step output. Inspired by Hermes Agent's
 * persistent-memory architecture.
 *
 * Design goals:
 *   1. Cross-session recall — find that scene you wrote 3 months ago
 *   2. Per-persona isolation — pen-name A's memory doesn't pollute pen-name B's
 *   3. Resilient indexing — incremental, never re-scans everything
 *   4. Graceful degradation — if SQLite fails to load (no native binary
 *      available on this machine), the rest of AuthorClaw keeps working
 *      and search just returns "unavailable"
 *
 * Data sources indexed:
 *   - workspace/memory/conversations/<date>.jsonl (every chat turn)
 *   - workspace/projects/<slug>/<step>.md (every completed step output)
 *
 * Search is case-insensitive, supports phrase matching ("dragon throne"),
 * NEAR queries (dragon NEAR throne), and BM25 ranking. Output is a list of
 * snippet hits with source path + timestamp + persona context.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type MemorySource = 'conversation' | 'project_step' | 'manuscript' | 'note';

export interface MemoryEntry {
  id?: number;
  source: MemorySource;
  /** What kind of identifier this entry refers to (sourceRefId interpretation). */
  sourceType: string;             // e.g., 'jsonl-line', 'project-step', 'manuscript-md'
  sourceRef: string;              // path / project-step-id / etc.
  personaId: string | null;       // null = unscoped
  projectId: string | null;       // null = unscoped
  timestamp: string;              // ISO
  title: string | null;           // Optional human label
  body: string;                   // The text we search across
}

export interface SearchHit {
  id: number;
  source: MemorySource;
  sourceRef: string;
  personaId: string | null;
  projectId: string | null;
  timestamp: string;
  title: string | null;
  snippet: string;                // Highlighted snippet from FTS5
  rank: number;                   // BM25 score (lower = better match in FTS5)
}

export interface SearchOptions {
  limit?: number;
  source?: MemorySource;
  personaId?: string | null;      // exact filter; pass `null` to scope to unscoped only
  projectId?: string;
  fromDate?: string;              // ISO; inclusive
  toDate?: string;                // ISO; inclusive
}

export interface SearchStats {
  available: boolean;
  totalEntries: number;
  bySource: Record<string, number>;
  lastIndexedAt: string | null;
  unavailableReason?: string;
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class MemorySearchService {
  private dbPath: string;
  private memoryDir: string;
  private workspaceDir: string;
  // Database is `any` so we don't import better-sqlite3 types unconditionally —
  // they'd force the dependency on every install. We lazy-load.
  private db: any = null;
  private unavailableReason: string | null = null;
  private lastIndexedAt: string | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.memoryDir = join(workspaceDir, 'memory');
    this.dbPath = join(workspaceDir, 'memory', 'memory-search.db');
  }

  /**
   * Initialize the SQLite database with FTS5 tables. If better-sqlite3 isn't
   * available (failed compile, missing prebuilt binary for this platform),
   * fall back gracefully — the service reports `available: false` and search
   * returns an empty result set.
   */
  async initialize(): Promise<void> {
    try {
      // @ts-ignore — better-sqlite3 types are optional; we lazy-load and treat as `any`.
      const mod: any = await import('better-sqlite3');
      const Database: any = mod.default || mod;
      const { mkdir } = await import('fs/promises');
      await mkdir(this.memoryDir, { recursive: true });
      this.db = new Database(this.dbPath);
      // WAL mode = better concurrent reads (dashboard) while writes happen.
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.applySchema();
    } catch (err: any) {
      this.unavailableReason = `better-sqlite3 unavailable: ${err?.message || err}. Memory search will be disabled. Run "npm rebuild better-sqlite3" or check that build tools are installed.`;
      console.warn(`  ⚠ ${this.unavailableReason}`);
      this.db = null;
    }
  }

  isAvailable(): boolean {
    return this.db !== null;
  }

  private applySchema(): void {
    // Main entries table — the single source of truth for indexed memory.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source       TEXT NOT NULL,
        source_type  TEXT NOT NULL,
        source_ref   TEXT NOT NULL,
        persona_id   TEXT,
        project_id   TEXT,
        timestamp    TEXT NOT NULL,
        title        TEXT,
        body         TEXT NOT NULL,
        UNIQUE(source, source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_persona ON entries(persona_id);
      CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);
      CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
    `);

    // FTS5 virtual table — content is in the entries table; FTS5 mirrors body+title.
    // External-content mode keeps DB size small and updates atomic via triggers.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title, body,
        content='entries',
        content_rowid='id',
        tokenize='porter unicode61 remove_diacritics 2'
      );
    `);

    // Triggers keep FTS in sync. Need to recreate idempotently — the
    // CREATE TRIGGER IF NOT EXISTS form is supported.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
        INSERT INTO entries_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
    `);

    // Metadata table — tracks last index timestamp so we can do incremental syncs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const lastSync = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'last_indexed_at'`).get() as any;
    if (lastSync?.value) this.lastIndexedAt = lastSync.value;
  }

  /**
   * Add or update a memory entry. Returns the row id.
   * Idempotent on (source, sourceRef) — re-indexing the same conversation
   * line / step output replaces the previous entry.
   */
  upsert(entry: MemoryEntry): number | null {
    if (!this.db) return null;
    try {
      // Body is stored as-is; the FTS index is built by the trigger.
      const stmt = this.db.prepare(`
        INSERT INTO entries (source, source_type, source_ref, persona_id, project_id, timestamp, title, body)
        VALUES (@source, @sourceType, @sourceRef, @personaId, @projectId, @timestamp, @title, @body)
        ON CONFLICT(source, source_ref) DO UPDATE SET
          source_type = excluded.source_type,
          persona_id  = excluded.persona_id,
          project_id  = excluded.project_id,
          timestamp   = excluded.timestamp,
          title       = excluded.title,
          body        = excluded.body
      `);
      const result = stmt.run({
        source: entry.source,
        sourceType: entry.sourceType,
        sourceRef: entry.sourceRef,
        personaId: entry.personaId,
        projectId: entry.projectId,
        timestamp: entry.timestamp,
        title: entry.title,
        body: entry.body,
      });
      return result.lastInsertRowid ? Number(result.lastInsertRowid) : null;
    } catch (err) {
      console.error('  [memory-search] upsert failed:', err);
      return null;
    }
  }

  /**
   * Full-text search across all indexed memory.
   * Query supports FTS5 syntax: phrases ("foo bar"), NEAR (foo NEAR bar),
   * column filter (title:foo), prefix (foo*), boolean (foo OR bar).
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!this.db || !query?.trim()) return [];

    // Basic FTS5 query sanitization — strip control characters but allow
    // FTS5 operators. Users putting weird input will just get no matches.
    const safeQuery = query.replace(/[\x00-\x1f]/g, '').trim();

    const filters: string[] = [];
    const params: any = { q: safeQuery };
    if (opts.source) { filters.push('e.source = @source'); params.source = opts.source; }
    if (opts.personaId === null) { filters.push('e.persona_id IS NULL'); }
    else if (opts.personaId) { filters.push('e.persona_id = @personaId'); params.personaId = opts.personaId; }
    if (opts.projectId) { filters.push('e.project_id = @projectId'); params.projectId = opts.projectId; }
    if (opts.fromDate) { filters.push('e.timestamp >= @fromDate'); params.fromDate = opts.fromDate; }
    if (opts.toDate) { filters.push('e.timestamp <= @toDate'); params.toDate = opts.toDate; }
    const whereExtra = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

    const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));

    // snippet() highlights matched terms with [...] markers; truncated to ~32 tokens.
    const sql = `
      SELECT
        e.id, e.source, e.source_ref, e.persona_id, e.project_id,
        e.timestamp, e.title,
        snippet(entries_fts, 1, '[', ']', '…', 32) AS snippet,
        bm25(entries_fts) AS rank
      FROM entries_fts
      JOIN entries e ON e.id = entries_fts.rowid
      WHERE entries_fts MATCH @q ${whereExtra}
      ORDER BY rank
      LIMIT ${limit}
    `;

    try {
      const rows = this.db.prepare(sql).all(params) as any[];
      return rows.map(r => ({
        id: r.id,
        source: r.source as MemorySource,
        sourceRef: r.source_ref,
        personaId: r.persona_id,
        projectId: r.project_id,
        timestamp: r.timestamp,
        title: r.title,
        snippet: r.snippet,
        rank: r.rank,
      }));
    } catch (err: any) {
      // FTS5 throws on syntax errors — return empty rather than 500.
      console.warn('  [memory-search] query failed:', err?.message || err);
      return [];
    }
  }

  /**
   * Index every JSONL conversation file + every project step output file
   * found on disk. Idempotent — re-running picks up only new entries.
   * Uses last-indexed-at timestamp to skip already-indexed days.
   */
  async reindexAll(opts: { force?: boolean } = {}): Promise<{ indexed: number; skipped: number }> {
    if (!this.db) return { indexed: 0, skipped: 0 };

    let indexed = 0;
    let skipped = 0;
    const lastIndexed = opts.force ? null : this.lastIndexedAt;

    // ── Conversations ──
    const convDir = join(this.memoryDir, 'conversations');
    if (existsSync(convDir)) {
      const files = await readdir(convDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(convDir, file);
        const dateStr = file.replace('.jsonl', '');
        // Skip if file's date is earlier than our last index pass (file is
        // append-only and dated; older files don't change).
        if (lastIndexed && dateStr < lastIndexed.split('T')[0] && !opts.force) {
          skipped++;
          continue;
        }
        try {
          const raw = await readFile(path, 'utf-8');
          const lines = raw.trim().split('\n').filter(Boolean);
          for (let i = 0; i < lines.length; i++) {
            try {
              const turn = JSON.parse(lines[i]);
              const sourceRef = `${file}#${i}`;
              this.upsert({
                source: 'conversation',
                sourceType: 'jsonl-line',
                sourceRef,
                personaId: turn.personaId || null,
                projectId: turn.projectId || null,
                timestamp: turn.timestamp || `${dateStr}T00:00:00Z`,
                title: null,
                body: `[user] ${turn.user || ''}\n[assistant] ${turn.assistant || ''}`.substring(0, 50000),
              });
              indexed++;
            } catch { /* malformed line — skip */ }
          }
        } catch { /* file unreadable — skip */ }
      }
    }

    // ── Project step outputs (each .md file in workspace/projects/<slug>/) ──
    const projectsDir = join(this.workspaceDir, 'projects');
    if (existsSync(projectsDir)) {
      const projects = await readdir(projectsDir);
      for (const slug of projects) {
        const dir = join(projectsDir, slug);
        try {
          const stats = await stat(dir);
          if (!stats.isDirectory()) continue;
          const files = await readdir(dir);
          for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const fullPath = join(dir, file);
            try {
              const fileStats = await stat(fullPath);
              const mtime = fileStats.mtime.toISOString();
              // Skip if last-modified is older than our last index pass.
              if (lastIndexed && mtime < lastIndexed && !opts.force) {
                skipped++;
                continue;
              }
              const content = await readFile(fullPath, 'utf-8');
              const titleMatch = content.match(/^#\s+(.+?)$/m);
              const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');
              this.upsert({
                source: file === 'manuscript.md' || file === 'compiled-output.md' || file === 'revised-manuscript.md'
                  ? 'manuscript' : 'project_step',
                sourceType: 'manuscript-md',
                sourceRef: `${slug}/${file}`,
                personaId: null,           // resolved later via project lookup
                projectId: null,
                timestamp: mtime,
                title,
                body: content.substring(0, 200000), // 200K char cap per file
              });
              indexed++;
            } catch { /* file gone or unreadable */ }
          }
        } catch { /* directory gone */ }
      }
    }

    // Update last-indexed-at
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sync_state (key, value) VALUES ('last_indexed_at', @now)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ now });
    this.lastIndexedAt = now;

    return { indexed, skipped };
  }

  /**
   * Index a single conversation turn as it happens (called from MemoryService).
   * Cheap — just one insert.
   */
  indexConversationTurn(input: {
    user: string;
    assistant: string;
    timestamp: string;
    personaId?: string | null;
    projectId?: string | null;
  }): void {
    if (!this.db) return;
    const date = input.timestamp.split('T')[0];
    const sourceRef = `${date}.jsonl#live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.upsert({
      source: 'conversation',
      sourceType: 'jsonl-line',
      sourceRef,
      personaId: input.personaId ?? null,
      projectId: input.projectId ?? null,
      timestamp: input.timestamp,
      title: null,
      body: `[user] ${input.user}\n[assistant] ${input.assistant}`.substring(0, 50000),
    });
  }

  /** Stats for the dashboard. */
  getStats(): SearchStats {
    if (!this.db) {
      return {
        available: false,
        totalEntries: 0,
        bySource: {},
        lastIndexedAt: null,
        unavailableReason: this.unavailableReason || 'Search service not initialized',
      };
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM entries`).get() as any)?.n || 0;
    const sourceRows = this.db.prepare(`SELECT source, COUNT(*) AS n FROM entries GROUP BY source`).all() as any[];
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.source] = r.n;
    return {
      available: true,
      totalEntries: total,
      bySource,
      lastIndexedAt: this.lastIndexedAt,
    };
  }

  /** Close the DB cleanly on shutdown. */
  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }
}

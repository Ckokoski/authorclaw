/**
 * AuthorClaw Universal Activity Log
 * Tracks ALL agent actions: goals, chats, file ops, skill matches, errors
 * Replaces the book-conductor-specific director's log with a unified feed.
 */

import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ActivityType =
  | 'project_created'
  | 'project_planned'
  | 'goal_created'
  | 'goal_planned'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'chat_message'
  | 'skill_matched'
  | 'file_saved'
  | 'provider_selected'
  | 'error'
  | 'system';

export type ActivitySource = 'telegram' | 'dashboard' | 'api' | 'internal';

export interface ActivityEntry {
  timestamp: string;
  type: ActivityType;
  source: ActivitySource;
  goalId?: string;
  stepLabel?: string;
  message: string;             // Human-readable description
  metadata?: {
    provider?: string;
    tokens?: number;
    cost?: number;
    wordCount?: number;
    fileName?: string;
    skillName?: string;
    stepNumber?: number;
    totalSteps?: number;
    [key: string]: any;
  };
}

// Keys that look like API secrets — strip from logged metadata
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /sk-[a-zA-Z0-9]{20,}/,
  /AIza[a-zA-Z0-9_-]{35}/,
];

// ═══════════════════════════════════════════════════════════
// Activity Log
// ═══════════════════════════════════════════════════════════

export class ActivityLog {
  private logDir: string;
  private sseClients: Set<any> = new Set();

  constructor(workspaceDir: string) {
    this.logDir = join(workspaceDir, '.activity');
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.logDir)) {
      await mkdir(this.logDir, { recursive: true });
    }
  }

  /**
   * Log an activity entry. Appends to daily JSONL file and pushes to SSE clients.
   */
  async log(entry: Omit<ActivityEntry, 'timestamp'>): Promise<void> {
    const full: ActivityEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      metadata: entry.metadata ? this.sanitize(entry.metadata) : undefined,
    };

    // Append to daily JSONL
    const dateStr = full.timestamp.slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.logDir, `${dateStr}.jsonl`);
    await appendFile(filePath, JSON.stringify(full) + '\n', 'utf-8');

    // Push to SSE clients
    this.broadcast(full);
  }

  /**
   * Get the most recent N activity entries (reads from today + yesterday if needed).
   */
  async getRecent(count: number = 50, goalId?: string): Promise<ActivityEntry[]> {
    const entries: ActivityEntry[] = [];
    const today = new Date();

    // Read up to 3 days back to gather enough entries
    for (let daysBack = 0; daysBack < 3 && entries.length < count; daysBack++) {
      const d = new Date(today);
      d.setDate(d.getDate() - daysBack);
      const dateStr = d.toISOString().slice(0, 10);
      const filePath = join(this.logDir, `${dateStr}.jsonl`);

      if (!existsSync(filePath)) continue;

      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);
        for (const line of lines.reverse()) {
          try {
            const entry = JSON.parse(line) as ActivityEntry;
            if (goalId && entry.goalId !== goalId) continue;
            entries.push(entry);
            if (entries.length >= count) break;
          } catch { /* skip malformed lines */ }
        }
      } catch { /* file read error — skip */ }
    }

    // Return in chronological order (oldest first)
    return entries.reverse();
  }

  // ── SSE (Server-Sent Events) ──

  /**
   * Register an SSE client. Returns cleanup function.
   */
  addSSEClient(res: any): () => void {
    this.sseClients.add(res);
    return () => this.sseClients.delete(res);
  }

  private broadcast(entry: ActivityEntry): void {
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  // ── Sanitization ──

  private sanitize(metadata: Record<string, any>): Record<string, any> {
    const clean: Record<string, any> = {};
    for (const [key, value] of Object.entries(metadata)) {
      // Skip keys that look like secrets
      if (SECRET_PATTERNS.some(p => p.test(key))) continue;

      // Sanitize string values that look like API keys
      if (typeof value === 'string' && SECRET_PATTERNS.some(p => p.test(value))) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }
}

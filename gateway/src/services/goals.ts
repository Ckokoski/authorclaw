/**
 * AuthorClaw Author Goals & Career Planner
 *
 * Long-horizon goal tracking for author careers:
 *   "Write 80,000 words in 90 days"
 *   "Release 4 books in 2026"
 *   "Reach 10,000 newsletter subscribers"
 *
 * Tracks target, deadline, current progress, daily velocity, and projects
 * a completion date based on recent pace. Persists to disk.
 *
 * Integrates with AuthorClaw's word-count tracking (via ProjectEngine's
 * completed writing steps) so word-count goals auto-advance without
 * manual updates.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type GoalType =
  | 'word_count'        // Writing target (auto-tracked via projects)
  | 'book_release'      // Publish N books
  | 'subscriber_count'  // Mailing-list growth
  | 'revenue'           // Financial target (manual entry)
  | 'review_count'      // Amazon/Goodreads reviews
  | 'custom';           // User-defined tracking

export type GoalStatus = 'active' | 'paused' | 'completed' | 'missed';

export interface AuthorGoal {
  id: string;
  type: GoalType;
  title: string;
  description: string;
  target: number;              // e.g., 80000 words, 4 books, 10000 subscribers
  current: number;             // current progress against target
  unit: string;                // "words", "books", "subscribers", "$", "reviews"
  startedAt: string;           // ISO
  deadline: string;            // ISO
  status: GoalStatus;
  projectIds?: string[];       // Linked projects (for word_count goals)
  history: Array<{ date: string; value: number }>; // Daily snapshots
  lastUpdatedAt: string;
}

export interface GoalProgress {
  goal: AuthorGoal;
  pctComplete: number;          // 0-100
  daysRemaining: number;
  daysElapsed: number;
  totalDays: number;
  pace: number;                 // units per day actual
  paceRequired: number;         // units per day needed to hit deadline
  projectedCompletion: string | null;  // ISO date, null if pace=0
  atRisk: boolean;
  message: string;              // Human-readable status
}

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class GoalsService {
  private goals: Map<string, AuthorGoal> = new Map();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'author-goals.json');
  }

  async initialize(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const goals = Array.isArray(parsed.goals) ? parsed.goals : [];
      for (const g of goals) this.goals.set(g.id, g);
    } catch {
      // Corrupted — start fresh.
    }
  }

  // ── CRUD ──

  async createGoal(input: {
    type: GoalType;
    title: string;
    description?: string;
    target: number;
    unit: string;
    deadline: string;
    projectIds?: string[];
  }): Promise<AuthorGoal> {
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const goal: AuthorGoal = {
      id,
      type: input.type,
      title: input.title,
      description: input.description || '',
      target: Math.max(1, Math.round(input.target)),
      current: 0,
      unit: input.unit,
      startedAt: now,
      deadline: input.deadline,
      status: 'active',
      projectIds: input.projectIds || [],
      history: [],
      lastUpdatedAt: now,
    };
    this.goals.set(id, goal);
    await this.schedulePersist();
    return goal;
  }

  async updateProgress(goalId: string, current: number, source: 'auto' | 'manual' = 'manual'): Promise<AuthorGoal | null> {
    const goal = this.goals.get(goalId);
    if (!goal) return null;
    goal.current = Math.max(0, Math.round(current));
    goal.lastUpdatedAt = new Date().toISOString();

    // Record daily snapshot (one per day, replacing today's if it exists).
    const today = goal.lastUpdatedAt.split('T')[0];
    const lastEntry = goal.history[goal.history.length - 1];
    if (lastEntry?.date === today) {
      lastEntry.value = goal.current;
    } else {
      goal.history.push({ date: today, value: goal.current });
    }
    // Keep history bounded to 365 days.
    if (goal.history.length > 365) {
      goal.history = goal.history.slice(-365);
    }

    // Auto-complete if hit target.
    if (goal.status === 'active' && goal.current >= goal.target) {
      goal.status = 'completed';
    }
    // Auto-miss if past deadline without completion.
    if (goal.status === 'active' && new Date(goal.deadline).getTime() < Date.now() && goal.current < goal.target) {
      goal.status = 'missed';
    }

    await this.schedulePersist();
    return goal;
  }

  async setStatus(goalId: string, status: GoalStatus): Promise<AuthorGoal | null> {
    const goal = this.goals.get(goalId);
    if (!goal) return null;
    goal.status = status;
    goal.lastUpdatedAt = new Date().toISOString();
    await this.schedulePersist();
    return goal;
  }

  async removeGoal(goalId: string): Promise<boolean> {
    const existed = this.goals.delete(goalId);
    if (existed) await this.schedulePersist();
    return existed;
  }

  getGoal(goalId: string): AuthorGoal | undefined {
    return this.goals.get(goalId);
  }

  listGoals(filter?: { status?: GoalStatus; type?: GoalType }): AuthorGoal[] {
    let result = Array.from(this.goals.values());
    if (filter?.status) result = result.filter(g => g.status === filter.status);
    if (filter?.type) result = result.filter(g => g.type === filter.type);
    // Sort active first, then by deadline ascending.
    return result.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return a.deadline.localeCompare(b.deadline);
    });
  }

  /**
   * Auto-advance word-count goals using current project word counts.
   * Call this after step completions / via heartbeat.
   */
  async autoAdvanceWordCountGoals(projectWordCounts: Map<string, number>): Promise<AuthorGoal[]> {
    const updated: AuthorGoal[] = [];
    for (const goal of this.goals.values()) {
      if (goal.type !== 'word_count' || goal.status !== 'active') continue;
      if (!goal.projectIds || goal.projectIds.length === 0) continue;

      let totalWords = 0;
      for (const pid of goal.projectIds) {
        totalWords += projectWordCounts.get(pid) || 0;
      }
      if (totalWords !== goal.current) {
        const result = await this.updateProgress(goal.id, totalWords, 'auto');
        if (result) updated.push(result);
      }
    }
    return updated;
  }

  /**
   * Compute derived progress metrics: pace, projected completion, at-risk flag.
   */
  computeProgress(goalId: string): GoalProgress | null {
    const goal = this.goals.get(goalId);
    if (!goal) return null;

    const now = Date.now();
    const started = new Date(goal.startedAt).getTime();
    const deadline = new Date(goal.deadline).getTime();
    const totalMs = Math.max(1, deadline - started);
    const elapsedMs = Math.max(0, now - started);
    const remainingMs = Math.max(0, deadline - now);

    const daysElapsed = Math.max(1, Math.floor(elapsedMs / 86400000));
    const daysRemaining = Math.max(0, Math.ceil(remainingMs / 86400000));
    const totalDays = Math.max(1, Math.round(totalMs / 86400000));

    const pctComplete = Math.min(100, Math.round((goal.current / goal.target) * 100));
    const remaining = Math.max(0, goal.target - goal.current);

    // Actual pace: units per day since goal start.
    const pace = goal.current / daysElapsed;
    // Required pace: remaining units / days left.
    const paceRequired = daysRemaining > 0 ? remaining / daysRemaining : remaining;
    // Projected completion: at current pace, when hit target?
    const daysToFinish = pace > 0 ? remaining / pace : Infinity;
    const projectedCompletion = pace > 0
      ? new Date(now + daysToFinish * 86400000).toISOString()
      : null;

    // At-risk if projected completion is past the deadline OR we're >20% behind the linear target.
    const linearExpected = (goal.target * elapsedMs) / totalMs;
    const behindLinear = goal.current < linearExpected * 0.8;
    const willMiss = projectedCompletion
      ? new Date(projectedCompletion).getTime() > deadline
      : true;
    const atRisk = goal.status === 'active' && (behindLinear || willMiss);

    let message: string;
    if (goal.status === 'completed') {
      message = `Done! Hit ${goal.current.toLocaleString()} ${goal.unit} on ${goal.lastUpdatedAt.split('T')[0]}.`;
    } else if (goal.status === 'missed') {
      message = `Missed deadline. Reached ${goal.current.toLocaleString()} of ${goal.target.toLocaleString()} ${goal.unit}.`;
    } else if (goal.status === 'paused') {
      message = `Paused. ${pctComplete}% complete.`;
    } else if (atRisk) {
      message = `Behind pace. Need ${Math.ceil(paceRequired).toLocaleString()} ${goal.unit}/day; doing ${Math.round(pace).toLocaleString()}/day.`;
    } else {
      message = `On track — ${Math.round(pace).toLocaleString()} ${goal.unit}/day, ${daysRemaining} days left.`;
    }

    return {
      goal,
      pctComplete,
      daysRemaining,
      daysElapsed,
      totalDays,
      pace: Math.round(pace * 10) / 10,
      paceRequired: Math.round(paceRequired * 10) / 10,
      projectedCompletion,
      atRisk,
      message,
    };
  }

  /** Compute progress for all active goals (dashboard convenience). */
  computeAllProgress(): GoalProgress[] {
    return Array.from(this.goals.values())
      .map(g => this.computeProgress(g.id))
      .filter((p): p is GoalProgress => p !== null);
  }

  // ── Persistence ──

  private async schedulePersist(): Promise<void> {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist().catch(() => {});
    }, 1000);
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      const tmp = this.filePath + '.tmp';
      await writeFile(tmp, JSON.stringify({ goals: Array.from(this.goals.values()) }, null, 2));
      const { rename } = await import('fs/promises');
      await rename(tmp, this.filePath);
    } catch (err) {
      console.error('  ✗ Failed to persist goals:', err);
    }
  }
}

/**
 * AuthorClaw Lesson Store
 * Manages improvement-log.jsonl — persistent lessons learned from
 * after-action reviews, user feedback, self-critique, and error recovery.
 *
 * Each lesson has a confidence score (0.0–1.0) that rises on acceptance
 * and decays on revision. High-confidence lessons are injected into
 * the system prompt so AuthorClaw gets smarter over time.
 *
 * Ported from Sneakers, adapted for author workflows.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface Lesson {
  id: string;              // "lesson-<timestamp>"
  timestamp: string;       // ISO date
  category: string;        // writing_quality | user_communication | error_patterns | research_quality | project_planning | style_voice | general
  lesson: string;          // The learned insight
  source: string;          // after-action-review | user-feedback | self-critique | error-recovery
  confidence: number;      // 0.0–1.0
  goalId?: string;         // If linked to a project
  appliedCount: number;    // How many times injected into prompts
}

export type LessonInput = Omit<Lesson, 'id' | 'appliedCount'>;

const VALID_CATEGORIES = [
  'writing_quality',
  'user_communication',
  'error_patterns',
  'research_quality',
  'project_planning',
  'style_voice',
  'general',
];

const VALID_SOURCES = [
  'after-action-review',
  'user-feedback',
  'self-critique',
  'error-recovery',
];

// ═══════════════════════════════════════════════════════════
// Lesson Store
// ═══════════════════════════════════════════════════════════

export class LessonStore {
  private lessons: Lesson[] = [];
  private filePath: string;

  constructor(memoryDir: string) {
    this.filePath = join(memoryDir, 'improvement-log.jsonl');
  }

  async initialize(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });

    if (existsSync(this.filePath)) {
      try {
        const raw = await readFile(this.filePath, 'utf-8');
        const lines = raw.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const lesson = JSON.parse(line) as Lesson;
            if (lesson.appliedCount === undefined) lesson.appliedCount = 0;
            if (lesson.confidence === undefined) lesson.confidence = 0.5;
            this.lessons.push(lesson);
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        this.lessons = [];
      }
    }
  }

  // ── Add a lesson ──

  async addLesson(input: LessonInput): Promise<Lesson> {
    const lesson: Lesson = {
      id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: input.timestamp || new Date().toISOString(),
      category: VALID_CATEGORIES.includes(input.category) ? input.category : 'general',
      lesson: input.lesson,
      source: VALID_SOURCES.includes(input.source) ? input.source : 'user-feedback',
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      goalId: input.goalId,
      appliedCount: 0,
    };

    this.lessons.push(lesson);

    try {
      await appendFile(this.filePath, JSON.stringify(lesson) + '\n', 'utf-8');
    } catch (err) {
      console.error('  ✗ Failed to persist lesson:', err);
    }

    return lesson;
  }

  // ── Query ──

  getAll(): Lesson[] {
    return [...this.lessons];
  }

  getRecent(count = 20): Lesson[] {
    return this.lessons.slice(-count);
  }

  getByCategory(category: string): Lesson[] {
    return this.lessons.filter(l => l.category === category);
  }

  getLesson(id: string): Lesson | undefined {
    return this.lessons.find(l => l.id === id);
  }

  // ── Confidence adjustment ──

  async adjustConfidence(lessonId: string, delta: number): Promise<Lesson | null> {
    const lesson = this.lessons.find(l => l.id === lessonId);
    if (!lesson) return null;

    lesson.confidence = Math.max(0, Math.min(1, lesson.confidence + delta));
    await this.persistAll();
    return lesson;
  }

  // ── System prompt context builder ──

  buildContext(maxTokens = 500): string {
    if (this.lessons.length === 0) return '';

    const sorted = [...this.lessons]
      .filter(l => l.confidence >= 0.3)
      .sort((a, b) => b.confidence - a.confidence);

    if (sorted.length === 0) return '';

    const lines: string[] = [];
    let tokenEstimate = 0;

    for (const lesson of sorted) {
      const line = `- [${lesson.category}] ${lesson.lesson} (confidence: ${(lesson.confidence * 100).toFixed(0)}%)`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokenEstimate + lineTokens > maxTokens) break;

      lines.push(line);
      tokenEstimate += lineTokens;
      lesson.appliedCount++;
    }

    this.persistAll().catch(() => {});

    return lines.join('\n');
  }

  // ── Reset ──

  async reset(): Promise<void> {
    this.lessons = [];
    try {
      await writeFile(this.filePath, '', 'utf-8');
    } catch {
      // Ignore
    }
  }

  // ── Internal ──

  private async persistAll(): Promise<void> {
    try {
      const data = this.lessons.map(l => JSON.stringify(l)).join('\n') + '\n';
      await writeFile(this.filePath, data, 'utf-8');
    } catch (err) {
      console.error('  ✗ Failed to persist lessons:', err);
    }
  }
}

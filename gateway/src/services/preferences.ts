/**
 * AuthorClaw Preference Store
 * Tracks user preferences — both explicitly stated and auto-detected
 * from conversation patterns. Persisted as JSON.
 *
 * Preferences are injected into the system prompt so AuthorClaw personalises
 * every interaction based on what the user likes/dislikes.
 *
 * Ported from Sneakers, enhanced with author-specific preference categories.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type PreferenceSource = 'explicit' | 'observed' | 'inferred';

interface PreferenceMetadata {
  source: PreferenceSource;
  updatedAt: string;
}

interface PreferenceData {
  preferences: Record<string, any>;
  metadata: Record<string, PreferenceMetadata>;
}

// ═══════════════════════════════════════════════════════════
// Detection patterns
// ═══════════════════════════════════════════════════════════

interface DetectionRule {
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => { key: string; value: string } | null;
}

const DETECTION_RULES: DetectionRule[] = [
  {
    pattern: /\bI prefer\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: val };
    },
  },
  {
    pattern: /\bI always want\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: val };
    },
  },
  {
    pattern: /\bI never want\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: `avoid: ${val}` };
    },
  },
  {
    pattern: /\bI (?:really )?like\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: val };
    },
  },
  {
    pattern: /\bdon'?t ever\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: `never: ${val}` };
    },
  },
  {
    pattern: /\bI don'?t like\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: `avoid: ${val}` };
    },
  },
  {
    pattern: /\bremember that I\s+(.+?)(?:\.|$)/i,
    extract: (m) => {
      const val = m[1].trim();
      if (val.length < 3 || val.length > 100) return null;
      return { key: inferPreferenceKey(val), value: val };
    },
  },
  // Author-specific patterns
  {
    pattern: /\bI write in\s+(first|second|third)\s+person\b/i,
    extract: (m) => ({ key: 'writing.pov', value: `${m[1]} person` }),
  },
  {
    pattern: /\bI write in\s+(past|present|future)\s+tense\b/i,
    extract: (m) => ({ key: 'writing.tense', value: `${m[1]} tense` }),
  },
  {
    pattern: /\bmy genre is\s+(.+?)(?:\.|$)/i,
    extract: (m) => ({ key: 'writing.genre', value: m[1].trim() }),
  },
  {
    pattern: /\bmy target (?:audience|reader)s?\s+(?:is|are)\s+(.+?)(?:\.|$)/i,
    extract: (m) => ({ key: 'writing.target_audience', value: m[1].trim() }),
  },
  {
    pattern: /\bI (?:publish|am publishing) (?:on|through|via)\s+(.+?)(?:\.|$)/i,
    extract: (m) => ({ key: 'publishing.platform', value: m[1].trim() }),
  },
];

/**
 * Infer a preference key from a value phrase.
 */
function inferPreferenceKey(value: string): string {
  const lower = value.toLowerCase();

  // Writing style
  if (lower.match(/\b(first person|third person|second person|pov|point of view)\b/)) return 'writing.pov';
  if (lower.match(/\b(past tense|present tense|future tense)\b/)) return 'writing.tense';
  if (lower.match(/\b(short chapters?|long chapters?|chapter length)\b/)) return 'writing.chapter_length';
  if (lower.match(/\b(dialogue tags?|said|asked)\b/)) return 'writing.dialogue_tags';
  if (lower.match(/\b(show.*tell|telling|showing)\b/)) return 'writing.show_dont_tell';
  if (lower.match(/\b(adverb|ly words?)\b/)) return 'writing.adverbs';
  if (lower.match(/\b(profanity|swearing|cursing|clean)\b/)) return 'writing.profanity';
  if (lower.match(/\b(romance|spicy|heat|fade to black)\b/)) return 'writing.romance_heat';
  if (lower.match(/\b(violence|gore|dark|gritty)\b/)) return 'writing.violence_level';

  // Response style
  if (lower.match(/\b(concise|brief|short|succinct|terse)\b/)) return 'response.style';
  if (lower.match(/\b(detailed|verbose|thorough|comprehensive|long)\b/)) return 'response.style';
  if (lower.match(/\b(bullet|list|point)\b/)) return 'response.format';

  // Tone
  if (lower.match(/\b(casual|informal|relaxed|friendly)\b/)) return 'tone';
  if (lower.match(/\b(formal|professional|serious)\b/)) return 'tone';
  if (lower.match(/\b(snarky|funny|humorous|witty)\b/)) return 'tone';

  // Formatting
  if (lower.match(/\b(emoji|emojis)\b/)) return 'formatting.emojis';
  if (lower.match(/\b(markdown|headers|bold)\b/)) return 'formatting.style';

  // Working style
  if (lower.match(/\b(morning|evening|night|afternoon)\b/)) return 'schedule.preferred_time';

  // Fallback
  return 'preference.' + lower.replace(/[^a-z0-9]+/g, '_').slice(0, 40);
}

// ═══════════════════════════════════════════════════════════
// Preference Store
// ═══════════════════════════════════════════════════════════

export class PreferenceStore {
  private data: PreferenceData = { preferences: {}, metadata: {} };
  private filePath: string;

  constructor(memoryDir: string) {
    this.filePath = join(memoryDir, 'user-preferences.json');
  }

  async initialize(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });

    if (existsSync(this.filePath)) {
      try {
        const raw = await readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = {
          preferences: parsed.preferences || {},
          metadata: parsed.metadata || {},
        };
      } catch {
        this.data = { preferences: {}, metadata: {} };
      }
    }
  }

  // ── CRUD ──

  get(key: string): any {
    return this.data.preferences[key];
  }

  async set(key: string, value: any, source: PreferenceSource = 'explicit'): Promise<void> {
    const existing = this.data.metadata[key];
    if (existing && existing.source === 'explicit' && source !== 'explicit') {
      return; // Don't override explicit with inferred
    }

    this.data.preferences[key] = value;
    this.data.metadata[key] = {
      source,
      updatedAt: new Date().toISOString(),
    };

    await this.persist();
  }

  async remove(key: string): Promise<boolean> {
    if (!(key in this.data.preferences)) return false;
    delete this.data.preferences[key];
    delete this.data.metadata[key];
    await this.persist();
    return true;
  }

  getAll(): Record<string, any> {
    return { ...this.data.preferences };
  }

  getAllWithMetadata(): PreferenceData {
    return {
      preferences: { ...this.data.preferences },
      metadata: { ...this.data.metadata },
    };
  }

  // ── System prompt context builder ──

  buildContext(maxTokens = 300): string {
    const entries = Object.entries(this.data.preferences);
    if (entries.length === 0) return '';

    const lines: string[] = [];
    let tokenEstimate = 0;

    for (const [key, value] of entries) {
      const meta = this.data.metadata[key];
      const sourceTag = meta?.source === 'explicit' ? '' : ` (${meta?.source || 'unknown'})`;
      const line = `- **${key}**: ${value}${sourceTag}`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokenEstimate + lineTokens > maxTokens) break;

      lines.push(line);
      tokenEstimate += lineTokens;
    }

    return lines.join('\n');
  }

  // ── Auto-detection from user messages ──

  async detectFromMessage(message: string): Promise<Array<{ key: string; value: string }>> {
    const detected: Array<{ key: string; value: string }> = [];

    for (const rule of DETECTION_RULES) {
      const match = message.match(rule.pattern);
      if (match) {
        const result = rule.extract(match);
        if (result) {
          await this.set(result.key, result.value, 'inferred');
          detected.push(result);
        }
      }
    }

    return detected;
  }

  // ── Reset ──

  async reset(): Promise<void> {
    this.data = { preferences: {}, metadata: {} };
    await this.persist();
  }

  // ── Internal ──

  private async persist(): Promise<void> {
    try {
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('  ✗ Failed to persist preferences:', err);
    }
  }
}

/**
 * Review Comments Service (M2.3 — ALP-1565).
 *
 * Comments anchor to a step's markdown content one of two ways:
 * - Section-anchored (the default): keyed to a `## heading` block. Robust
 *   across rewrites because it only cares that the heading survives, not
 *   what changed beneath it.
 * - Span-anchored: {quote, prefixContext, suffixContext, sectionId}. Tied to
 *   an exact substring, so a full rewrite of its section can invalidate it.
 *
 * Storage mirrors doc-versions.ts: workspace/projects/<slug>/.versions/<stepId>/comments.json
 * (a sibling of that service's v1.md/index.json), keyed by stepId the same
 * way version history is.
 *
 * On every new version (see doc-versions.ts's appendVersion, which calls
 * reanchorComments), span comments are re-anchored by exact match, then
 * fuzzy match within the same section, then degraded to a section comment —
 * a comment is never silently dropped.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

const log = logger.child('[comments]');

export type CommentStatus = 'open' | 'resolved';

export interface SectionAnchor {
  type: 'section';
  sectionId: string;
}

export interface SpanAnchor {
  type: 'span';
  sectionId: string;
  quote: string;
  prefixContext: string;
  suffixContext: string;
}

export type CommentAnchor = SectionAnchor | SpanAnchor;

export interface Comment {
  id: string;
  anchor: CommentAnchor;
  body: string;
  status: CommentStatus;
  author: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when a span anchor could no longer be exactly or fuzzily located in
   * a new version and was degraded to its enclosing section. The original
   * span is kept here purely as a record — never dropped.
   */
  degradedFrom?: {
    quote: string;
    prefixContext: string;
    suffixContext: string;
    reanchoredAt: string;
  };
}

export interface Section {
  id: string;
  heading: string;
  start: number;
  end: number;
  text: string;
}

export class CommentValidationError extends Error {}

// ═══════════════════════════════════════════════════════════
// Section parsing
// ═══════════════════════════════════════════════════════════

const SECTION_HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/gm;

/** Splits markdown content into `##`-headed blocks. Content before the first
 *  `##` (e.g. the `# Step Label` line doc-versions.ts prepends) belongs to
 *  no section and is not addressable — comments always anchor to a `##`. */
export function parseSections(content: string): Section[] {
  const matches: { index: number; heading: string }[] = [];
  SECTION_HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_HEADING_RE.exec(content))) {
    matches.push({ index: m.index, heading: m[1].trim() });
  }

  const seen = new Map<string, number>();
  return matches.map((entry, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const base = slugifyHeading(entry.heading);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base}-${n}`,
      heading: entry.heading,
      start: entry.index,
      end,
      text: content.slice(entry.index, end),
    };
  });
}

export function findSection(content: string, sectionId: string): Section | undefined {
  return parseSections(content).find((s) => s.id === sectionId);
}

function slugifyHeading(heading: string): string {
  return heading.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

// ═══════════════════════════════════════════════════════════
// Storage
// ═══════════════════════════════════════════════════════════

/** Same directory doc-versions.ts's private getVersionDir writes into. */
function commentsFilePath(projectDir: string, stepId: string): string {
  return join(projectDir, '.versions', stepId, 'comments.json');
}

async function readComments(projectDir: string, stepId: string): Promise<Comment[]> {
  const file = commentsFilePath(projectDir, stepId);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch (err) {
    log.error(`Failed to parse ${file}:`, err);
    return [];
  }
}

async function writeComments(projectDir: string, stepId: string, comments: Comment[]): Promise<void> {
  const file = commentsFilePath(projectDir, stepId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(comments, null, 2), 'utf-8');
}

// ═══════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════

export type NewCommentInput =
  | { type: 'section'; sectionId: string; body: string; author?: string }
  | {
      type: 'span';
      sectionId: string;
      quote: string;
      prefixContext: string;
      suffixContext: string;
      body: string;
      author?: string;
    };

export async function addComment(
  projectDir: string,
  stepId: string,
  currentContent: string,
  input: NewCommentInput,
): Promise<Comment> {
  if (!input.body || !input.body.trim()) throw new CommentValidationError('body is required');

  const section = findSection(currentContent, input.sectionId);
  if (!section) throw new CommentValidationError(`Unknown sectionId "${input.sectionId}"`);

  let anchor: CommentAnchor;
  if (input.type === 'section') {
    anchor = { type: 'section', sectionId: section.id };
  } else {
    if (!input.quote || !input.quote.trim()) {
      throw new CommentValidationError('quote is required for span comments');
    }
    if (!section.text.includes(input.quote)) {
      throw new CommentValidationError('quote not found within the given section');
    }
    anchor = {
      type: 'span',
      sectionId: section.id,
      quote: input.quote,
      prefixContext: input.prefixContext ?? '',
      suffixContext: input.suffixContext ?? '',
    };
  }

  const now = new Date().toISOString();
  const comment: Comment = {
    id: randomUUID(),
    anchor,
    body: input.body,
    status: 'open',
    author: input.author || 'user',
    createdAt: now,
    updatedAt: now,
  };

  const comments = await readComments(projectDir, stepId);
  comments.push(comment);
  await writeComments(projectDir, stepId, comments);
  return comment;
}

export async function listComments(projectDir: string, stepId: string): Promise<Comment[]> {
  return readComments(projectDir, stepId);
}

export async function setCommentStatus(
  projectDir: string,
  stepId: string,
  commentId: string,
  status: CommentStatus,
): Promise<Comment | null> {
  const comments = await readComments(projectDir, stepId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return null;
  comment.status = status;
  comment.updatedAt = new Date().toISOString();
  await writeComments(projectDir, stepId, comments);
  return comment;
}

// ═══════════════════════════════════════════════════════════
// Re-anchoring on new versions
// ═══════════════════════════════════════════════════════════

const FUZZY_THRESHOLD = 0.5;
const CONTEXT_CHARS = 40;

/** Called from doc-versions.ts's appendVersion right after a new version is
 *  written, so every step content change re-anchors that step's comments —
 *  regardless of which code path produced the new version. */
export async function reanchorComments(
  projectDir: string,
  stepId: string,
  newContent: string,
): Promise<void> {
  const comments = await readComments(projectDir, stepId);
  if (comments.length === 0) return;

  const newSectionById = new Map(parseSections(newContent).map((s) => [s.id, s]));
  let changed = false;

  for (const comment of comments) {
    const result = reanchorOne(comment.anchor, newSectionById);
    if (result.changed) {
      comment.anchor = result.anchor;
      comment.updatedAt = new Date().toISOString();
      if (result.degradedFrom) comment.degradedFrom = result.degradedFrom;
      changed = true;
    }
  }

  if (changed) await writeComments(projectDir, stepId, comments);
}

function reanchorOne(
  anchor: CommentAnchor,
  newSectionById: Map<string, Section>,
): { anchor: CommentAnchor; changed: boolean; degradedFrom?: Comment['degradedFrom'] } {
  if (anchor.type === 'section') {
    // Position-independent by design — unaffected by span-level edits
    // elsewhere in the section, and untouched even if the section itself
    // moved (we keep the id; if the heading is gone, it's simply orphaned,
    // never deleted).
    return { anchor, changed: false };
  }

  const section = newSectionById.get(anchor.sectionId);
  if (!section) {
    // The heading was removed or renamed, so there is nowhere valid to run
    // the exact/fuzzy search. Preserve the last known section id while
    // degrading the span and retaining its original details.
    return {
      anchor: { type: 'section', sectionId: anchor.sectionId },
      changed: true,
      degradedFrom: {
        quote: anchor.quote,
        prefixContext: anchor.prefixContext,
        suffixContext: anchor.suffixContext,
        reanchoredAt: new Date().toISOString(),
      },
    };
  }

  const withContext = anchor.prefixContext + anchor.quote + anchor.suffixContext;
  const exactWithContext = section.text.includes(withContext);
  const exactUnique = !exactWithContext && countOccurrences(section.text, anchor.quote) === 1;
  if (exactWithContext || exactUnique) {
    return { anchor, changed: false };
  }

  const fuzzy = findBestFuzzyMatch(section.text, anchor.quote);
  if (fuzzy && fuzzy.score >= FUZZY_THRESHOLD) {
    const reanchored: SpanAnchor = {
      type: 'span',
      sectionId: section.id,
      quote: section.text.slice(fuzzy.start, fuzzy.end),
      prefixContext: section.text.slice(Math.max(0, fuzzy.start - CONTEXT_CHARS), fuzzy.start),
      suffixContext: section.text.slice(fuzzy.end, fuzzy.end + CONTEXT_CHARS),
    };
    return { anchor: reanchored, changed: true };
  }

  // Neither exact nor fuzzy match survived the rewrite — degrade to a
  // section comment. Still anchored, still visible, never lost.
  const degraded: SectionAnchor = { type: 'section', sectionId: section.id };
  return {
    anchor: degraded,
    changed: true,
    degradedFrom: {
      quote: anchor.quote,
      prefixContext: anchor.prefixContext,
      suffixContext: anchor.suffixContext,
      reanchoredAt: new Date().toISOString(),
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

interface FuzzyMatch {
  start: number;
  end: number;
  score: number;
}

interface Token {
  word: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = normalizeWord(m[0]);
    if (word) tokens.push({ word, start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Sliding-window word-set Jaccard match — good enough to find where a
 *  sentence-or-so-sized quote landed after a rewrite, without pulling in a
 *  diff/edit-distance dependency for something this small. */
function findBestFuzzyMatch(haystack: string, quote: string): FuzzyMatch | null {
  const quoteTokens = tokenize(quote);
  if (quoteTokens.length === 0) return null;
  const quoteSet = new Set(quoteTokens.map((t) => t.word));

  const hayTokens = tokenize(haystack);
  if (hayTokens.length === 0) return null;

  const windowSize = quoteTokens.length;
  const minWindow = Math.max(1, Math.floor(windowSize * 0.6));
  const maxWindow = Math.ceil(windowSize * 1.4);

  let best: FuzzyMatch | null = null;
  for (let w = minWindow; w <= maxWindow; w++) {
    for (let i = 0; i + w <= hayTokens.length; i++) {
      const windowTokens = hayTokens.slice(i, i + w);
      const windowSet = new Set(windowTokens.map((t) => t.word));
      const score = jaccard(quoteSet, windowSet);
      if (!best || score > best.score) {
        best = { start: windowTokens[0].start, end: windowTokens[windowTokens.length - 1].end, score };
      }
    }
  }
  return best;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ═══════════════════════════════════════════════════════════
// Agent-facing formatting
// ═══════════════════════════════════════════════════════════

/** Renders open comments into a prompt block for reviseStep — resolved
 *  comments are deliberately excluded, matching the "carry status" contract. */
export function formatOpenCommentsForAgent(comments: Comment[]): string {
  const open = comments.filter((c) => c.status === 'open');
  if (open.length === 0) return '';

  const lines: string[] = ['## Open reviewer comments', ''];
  for (const c of open) {
    if (c.anchor.type === 'section') {
      lines.push(`- [section: ${c.anchor.sectionId}] ${c.body}`);
    } else {
      lines.push(`- [span in "${c.anchor.sectionId}"] on "${truncate(c.anchor.quote, 120)}": ${c.body}`);
    }
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

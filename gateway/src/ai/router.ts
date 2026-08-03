/**
 * AuthorAgent AI Router
 * Smart routing across free and paid LLM providers
 * Optimized for writing tasks
 */

import { createHash, randomUUID } from 'crypto';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Vault } from '../security/vault.js';
import { CostTracker } from '../services/costs.js';
import { logger } from '../services/logger.js';
import { getLLMPrice } from '../services/pricing.js';
import { ModelConfig } from './model-config.js';

const execFileAsync = promisify(execFile);

const log = logger.child('[router]');

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

interface AIProvider {
  id: string;
  name: string;
  model: string;
  // 'local' = an endpoint-configured local server (LM Studio/vLLM/llama.cpp)
  // reached through the openai slot — zero cost, exempt from the budget gate.
  // Distinct from 'free' (a provider that's free by nature, e.g. Ollama)
  // purely so provider listings can still label it accurately.
  tier: 'free' | 'cheap' | 'paid' | 'local';
  available: boolean;
  endpoint: string;
  maxTokens: number;
  costPer1kInput: number;
  costPer1kOutput: number;
}

interface CompletionRequest {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  /**
   * Reasoning effort. When set, the router instructs the underlying provider
   * to spend more model time on chain-of-thought before answering — useful for
   * continuity checks, final edits, and structural revision passes where
   * shallow responses produce noticeably worse output.
   *
   * Inspired by OpenClaw 2026.4.24/25's thinking-budget knobs.
   *
   * Provider mapping:
   *   Claude Sonnet/Opus  → thinking.budget_tokens (1024 / 4096 / 16384)
   *   Gemini 2.5 family   → generationConfig.thinkingConfig.thinkingBudget
   *   DeepSeek            → swaps to deepseek-reasoner model
   *   OpenAI o-series     → reasoning.effort (low/medium/high)
   *   OpenAI gpt-4o etc.  → silently ignored (no reasoning support)
   *   Ollama              → silently ignored
   */
  thinking?: 'low' | 'medium' | 'high';
}

interface CompletionResponse {
  text: string;
  tokensUsed: number;
  estimatedCost: number;
  provider: string;
}

// ═══════════════════════════════════════════════════════════
// Task Complexity Tiers
// ═══════════════════════════════════════════════════════════

type TaskTier = 'free' | 'mid' | 'premium';

const TASK_TIERS: Record<string, TaskTier> = {
  general:          'free',      // Basic chat, simple questions
  research:         'free',      // Web research, fact finding
  creative_writing: 'mid',       // Actual prose writing
  revision:         'mid',       // Editing and rewriting
  style_analysis:   'mid',       // Voice/style matching
  marketing:        'free',      // Blurbs, pitches
  outline:          'mid',       // Story structure
  book_bible:       'mid',       // World building
  consistency:      'mid',       // Consistency checks — same tier as book_bible
  final_edit:       'premium',   // Final polish needs best reasoning
};

// Provider preference order per tier (first available wins)
// OpenRouter is included but ranked behind dedicated providers because its
// pricing is opaque (depends on the model the user picks). Users who want
// OpenRouter as primary should set it as the global preferred provider.
const TIER_ROUTING: Record<TaskTier, string[]> = {
  free:    ['gemini', 'ollama', 'deepseek', 'openrouter', 'openai', 'claude'],
  mid:     ['gemini', 'deepseek', 'openrouter', 'claude', 'openai', 'ollama'],
  premium: ['claude', 'openai', 'openrouter', 'gemini', 'deepseek', 'ollama'],
};

/**
 * Default reasoning effort per task type. Tasks that benefit most from deep
 * thinking get auto-elevated; everything else lets the provider default apply.
 *
 * Note: outline / book_bible / creative_writing intentionally NOT here.
 * Those tasks are LENGTH-heavy not reasoning-heavy — burning the budget on
 * hidden CoT just truncates the visible answer. Use TASK_OUTPUT_BUDGET to
 * give them room instead.
 */
const TASK_REASONING: Record<string, 'low' | 'medium' | 'high'> = {
  consistency: 'high',
  final_edit:  'high',
  revision:    'medium',
};

/** Public helper: get the recommended reasoning effort for a task type. */
export function getRecommendedThinking(taskType: string): 'low' | 'medium' | 'high' | undefined {
  return TASK_REASONING[taskType];
}

/**
 * Per-task output token budget. The base provider.maxTokens (typically 4096)
 * is too small for character profiles, chapter-by-chapter outlines, and
 * full chapter prose — those tasks need 8K+ tokens to fit a complete answer.
 *
 * This was the actual root cause of the user-reported "stuck on character
 * profiles / chapter outline" failures: the model was producing a complete
 * answer but getting truncated mid-output, then either falling under the
 * 50-char threshold or returning a half-baked response that broke pipeline
 * steps downstream.
 */
const TASK_OUTPUT_BUDGET: Record<string, number> = {
  outline:          16384,  // 20-30 chapter outlines + beats per chapter
  book_bible:       12288,  // Multi-character profiles + worldbuilding
  creative_writing: 16384,  // Chapter prose; continuation logic handles overflow
  revision:         16384,  // Pass notes can be long
  consistency:      8192,   // Cross-chapter check report
  final_edit:       8192,   // Final-pass notes
  research:         8192,   // Research syntheses
  general:          4096,   // Default
};

/** Public helper: get the output token budget for a task type. */
export function getOutputBudget(taskType: string): number {
  return TASK_OUTPUT_BUDGET[taskType] || 4096;
}

// ═══════════════════════════════════════════════════════════
// Per-provider defaults
// ═══════════════════════════════════════════════════════════

/**
 * Hardcoded default model + fallback pricing per provider.
 *
 * `defaultModel` is the last resort in the model-resolution precedence
 * (model-config.json override → config.<provider>.model → this).
 *
 * `costPer1kInput/Output` are the provider's historical hardcoded numbers,
 * used ONLY as the fallback pricing when the active model isn't in the
 * LLM_PRICING table (see getLLMPrice). Keeping them here means an unknown /
 * custom model still bills like that provider's default instead of $0.
 */
interface ProviderDefault {
  defaultModel: string;
  tier: 'free' | 'cheap' | 'paid';
  costPer1kInput: number;
  costPer1kOutput: number;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefault> = {
  ollama:     { defaultModel: 'llama3.2',                       tier: 'free',  costPer1kInput: 0,       costPer1kOutput: 0 },
  gemini:     { defaultModel: 'gemini-2.5-flash',              tier: 'free',  costPer1kInput: 0,       costPer1kOutput: 0 },
  deepseek:   { defaultModel: 'deepseek-chat',                 tier: 'cheap', costPer1kInput: 0.00014, costPer1kOutput: 0.00028 },
  claude:     { defaultModel: 'claude-sonnet-4-5-20250929',    tier: 'paid',  costPer1kInput: 0.003,   costPer1kOutput: 0.015 },
  openai:     { defaultModel: 'gpt-4o',                        tier: 'paid',  costPer1kInput: 0.0025,  costPer1kOutput: 0.01 },
  openrouter: { defaultModel: 'anthropic/claude-sonnet-4-5',   tier: 'cheap', costPer1kInput: 0.003,   costPer1kOutput: 0.015 },
  // Rides a Claude Code CLI session (claude.ai OAuth login, e.g. Pro/Max
  // subscription) instead of a metered Anthropic API key. No separate
  // per-token bill, so cost is modeled as free — the CLI's own
  // total_cost_usd is an internal Anthropic estimate, not something
  // AuthorAgent gets billed for on top of the subscription.
  'claude-cli': { defaultModel: 'sonnet',                      tier: 'free',  costPer1kInput: 0,       costPer1kOutput: 0 },
  // Same CLI session, pinned to the opus alias. Not a separately configured
  // provider in the settings UI — selectProvider() swaps to this id for the
  // handful of task types where prose quality matters more than quota
  // headroom (see CLAUDE_CLI_PREMIUM_TASKS below). Everything else stays on
  // the sonnet-backed 'claude-cli' id.
  'claude-cli-opus': { defaultModel: 'opus',                   tier: 'free',  costPer1kInput: 0,       costPer1kOutput: 0 },
};

/** Known model slugs per provider, for a settings dropdown. Free-text custom
 *  models are ALSO allowed (see POST /api/models) — this is a convenience list,
 *  not a whitelist. Includes future models (fable-5, opus-4-8, gpt-5, etc.). */
export const KNOWN_MODELS: Record<string, string[]> = {
  ollama:   ['llama3.2', 'llama3.1:8b-instruct-q4_K_M', 'mistral', 'qwen2.5'],
  gemini:   ['gemini-2.5-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  claude:   ['claude-sonnet-4-5-20250929', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-haiku-4-5'],
  openai:   ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'],
  openrouter: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-8', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'meta-llama/llama-3.1-70b-instruct'],
  // CLI accepts aliases (always the latest of each tier) or full model names.
  'claude-cli': ['sonnet', 'opus', 'haiku', 'fable'],
  'claude-cli-opus': ['opus'],
};

/**
 * Task types that get bumped from the default claude-cli model (sonnet) to
 * the opus variant when claude-cli is the effective provider. Kept to a
 * short list deliberately — Opus burns through subscription usage caps
 * faster than Sonnet, so this is reserved for prose quality (drafting) and
 * the final polish pass, not every task that happens to route through
 * claude-cli.
 */
const CLAUDE_CLI_PREMIUM_TASKS = new Set(['creative_writing', 'final_edit']);

/** claude-cli and claude-cli-opus share ONE binary, ONE OAuth token, and ONE
 *  rate limiter. Anywhere we pick a "different" provider as a fallback or
 *  measure transport health, both ids must be treated as the same transport
 *  — routing a failed claude-cli call to claude-cli-opus is not a fallback,
 *  it's a retry of the same broken thing (confirmed in production logs: an
 *  auth failure on claude-cli was immediately followed by the identical
 *  auth failure on claude-cli-opus). */
const CLAUDE_CLI_TRANSPORT_IDS = new Set(['claude-cli', 'claude-cli-opus']);

// ═══════════════════════════════════════════════════════════
// Claude Code CLI provider helpers
// ═══════════════════════════════════════════════════════════

/**
 * A counting semaphore bounding how many `claude -p` child processes can run
 * at once. Each call spawns a full CLI session (its own auth check, model
 * session, etc.) — firing a dozen at once both hammers the local machine and
 * trips Claude Code's own rate limiter, which then fails every in-flight call
 * simultaneously instead of queueing cleanly. Configured via
 * config.ai['claude-cli'].maxConcurrent (config/default.json, overridable in
 * config/user.json — same pattern as ollama.endpoint), default 2.
 */
class Semaphore {
  private queue: Array<{ resolve: () => void }> = [];
  private active = 0;

  constructor(private max: number) {}

  setMax(max: number): void {
    this.max = max;
  }

  /** For diagnostics: how many calls are currently running vs. waiting for a slot. */
  debugState(): string {
    return `active=${this.active}/${this.max} queued=${this.queue.length}`;
  }

  /**
   * Runs `fn` once a slot is free. `queueTimeoutMs`, if given, bounds how
   * long a caller will wait for a slot — previously this wait was unbounded
   * and invisible (a burst of large background calls could starve an
   * interactive chat message for minutes with no signal anything was
   * wrong). A timed-out waiter is spliced out of the queue rather than
   * quietly resolving into a slot nobody wants anymore.
   */
  async run<T>(fn: () => Promise<T>, opts?: { queueTimeoutMs?: number }): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolveWait, rejectWait) => {
        const entry: { resolve: () => void } = { resolve: resolveWait };
        this.queue.push(entry);
        if (opts?.queueTimeoutMs) {
          const timer = setTimeout(() => {
            const idx = this.queue.indexOf(entry);
            if (idx >= 0) {
              this.queue.splice(idx, 1);
              rejectWait(new Error(
                `Timed out after ${opts.queueTimeoutMs}ms waiting for a claude-cli slot ` +
                `(queue depth was ${this.queue.length + 1}).`
              ));
            }
          }, opts.queueTimeoutMs);
          entry.resolve = () => { clearTimeout(timer); resolveWait(); };
        }
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next.resolve();
    }
  }
}

/**
 * Spaces out claude-cli spawns and backs off on failure. One AuthorAgent
 * revision step can fire ~11 completion calls (primary + fallback +
 * short-response retry + up to 6 word-count continuations + judge + quality
 * retry) with zero spacing between them today. Living at the transport layer
 * (rather than in step-executor's retry ladder) means every call site is
 * protected without touching that code.
 */
class CliPacer {
  private nextAllowedAt = 0;
  private backoffMs = 0;

  constructor(private minGapMs: number, private maxBackoffMs: number, private now: () => number = Date.now) {}

  configure(minGapMs: number, maxBackoffMs: number): void {
    this.minGapMs = minGapMs;
    this.maxBackoffMs = maxBackoffMs;
  }

  async waitTurn(): Promise<void> {
    const wait = this.nextAllowedAt - this.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  recordSuccess(): void {
    this.backoffMs = 0;
    this.nextAllowedAt = this.now() + this.minGapMs;
  }

  recordFailure(): void {
    this.backoffMs = Math.min(Math.max(2_000, this.backoffMs * 2), this.maxBackoffMs);
    const jitter = this.backoffMs * (0.8 + Math.random() * 0.4); // ±20%
    this.nextAllowedAt = this.now() + jitter;
  }
}

/** Classification of a claude-cli failure, used to decide whether to open
 *  the shared circuit breaker and how to pace retries. */
export type CliFailureKind = 'auth' | 'quota' | 'transient' | 'fatal';

export class ClaudeCliError extends Error {
  constructor(message: string, public kind: CliFailureKind = 'transient', public retryAfterMs?: number) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

const CLI_FATAL_PATTERNS = ['error_max_turns', 'system prompt file not found'];
const CLI_AUTH_PATTERNS = [
  'not logged in', 'authentication', 'oauth', 'invalid_grant',
  'token has expired', 'claude login', 'unauthenticated', 're-authenticate',
];
const CLI_QUOTA_PATTERNS = ['usage limit', 'rate limit', '429', 'resets at', 'overloaded_error', 'credit balance'];

/**
 * Classify a claude-cli failure from whatever text we have (the result
 * event's error text and/or buffered stderr). Fed from both the streaming
 * result-event path and the process-exited-without-a-result path, so the
 * two can't disagree about what kind of failure just happened.
 *
 * Important constraint (verified against the live CLI): `claude auth status`
 * reports `loggedIn: true` even when a USAGE CAP is exhausted, not just when
 * genuinely logged out. So an 'auth' classification can be cleared by a
 * lazy re-probe of auth status; a 'quota' classification cannot — it only
 * clears once its retry deadline passes.
 */
export function classifyClaudeCliFailure(input: { resultText?: string; stderr?: string }): {
  kind: CliFailureKind;
  message: string;
  retryAfterMs?: number;
} {
  const hay = `${input.resultText || ''} ${input.stderr || ''}`.toLowerCase();

  for (const p of CLI_FATAL_PATTERNS) {
    if (hay.includes(p)) return { kind: 'fatal', message: input.resultText || input.stderr || p };
  }
  for (const p of CLI_AUTH_PATTERNS) {
    if (hay.includes(p)) {
      return {
        kind: 'auth',
        message: 'Claude Code CLI auth expired or revoked. Run: claude logout && claude login',
      };
    }
  }
  for (const p of CLI_QUOTA_PATTERNS) {
    if (hay.includes(p)) {
      const m = hay.match(/resets at ([^.,\n]+)/);
      let retryAfterMs: number | undefined;
      if (m) {
        const parsed = Date.parse(m[1]);
        if (!isNaN(parsed)) retryAfterMs = Math.max(60_000, parsed - Date.now());
      }
      return {
        kind: 'quota',
        message: `Claude Code usage limit reached.${m ? ` Resets at ${m[1].trim()}.` : ''}`,
        retryAfterMs: retryAfterMs ?? 15 * 60_000,
      };
    }
  }
  return { kind: 'transient', message: input.resultText || input.stderr || 'unknown error' };
}

/** Parses a stream-json `result` event into either success text or an error. */
export function parseClaudeCliResultEvent(
  evt: any
): { ok: true; text: string; tokensUsed: number } | { ok: false; error: string } {
  const text = evt?.result ?? '';
  if (evt?.is_error) {
    return { ok: false, error: text || evt?.subtype || 'unknown error' };
  }
  if (!text) {
    return { ok: false, error: 'Claude Code CLI returned an empty result.' };
  }
  return {
    ok: true,
    text,
    tokensUsed: (evt?.usage?.input_tokens ?? 0) + (evt?.usage?.output_tokens ?? 0),
  };
}

/** Incremental newline-delimited-JSON line splitter for a streamed stdout. */
export function createNdjsonLineReader(onLine: (line: string) => void): { push(chunk: string): void } {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    },
  };
}

/**
 * How long to wait for the FIRST byte of output before treating a call as
 * stuck. A trivial prompt needs only the base budget; AuthorAgent's largest
 * prompts (up to ~600,000 chars for full-manuscript consistency checks) can
 * legitimately take minutes just to upload and begin generating. Scaled
 * linearly by prompt size, clamped to [base, ceiling].
 */
export function computeFirstTokenBudgetMs(promptChars: number, baseMs = 120_000, ceilingMs = 420_000): number {
  const scaled = baseMs + promptChars * 0.3;
  return Math.min(Math.max(scaled, baseMs), ceilingMs);
}

/**
 * The CLI has no `--max-tokens` flag and applies no output cap of its own —
 * so TASK_OUTPUT_BUDGET's per-task-type budgets (added specifically to fix
 * truncated outlines/character-profiles on other providers) can't be
 * enforced the same way here. What *is* worth preserving is the relative
 * signal "this task wants a long answer" — appended to the system prompt we
 * now fully control via --system-prompt-file. Only emitted for genuinely
 * long-output tasks (maxTokens >= 8192) so short tasks aren't padded.
 */
export function deriveLengthDirective(maxTokens?: number): string {
  if (!maxTokens || maxTokens < 8192) return '';
  const words = Math.round(maxTokens * 0.75);
  return (
    `\n\n## Response length\n` +
    `This task expects a substantial response (~${words} words). Do not truncate. ` +
    `Produce the complete answer in a single response.\n`
  );
}

const THINKING_TOKEN_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/** Maps AuthorAgent's abstract thinking level to the CLI's --max-thinking-tokens. */
export function mapThinkingToMaxThinkingTokens(thinking?: 'low' | 'medium' | 'high'): number | undefined {
  return thinking ? THINKING_TOKEN_BUDGETS[thinking] : undefined;
}

const SAFE_CLAUDE_CLI_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Defense-in-depth: the model string flows from user-editable config
 *  (model-config.json via setProviderModel) into a spawned argv element. */
export function isSafeClaudeCliModel(model: string): boolean {
  return SAFE_CLAUDE_CLI_MODEL_PATTERN.test(model);
}

/**
 * Exact argv for the hardened, NON-agentic invocation. Tools, skills,
 * slash-commands, and MCP are all disabled — AuthorAgent already injects
 * every piece of context (book bible, lessons, memory) directly into the
 * prompt, so the model never needed Claude Code's own tool access. Verified
 * empirically: dropping this scaffolding cuts ~28,800 tokens of dead weight
 * per call (measured: 28,845 -> 383 context tokens for an identical trivial
 * prompt; -> 139 with a neutral cwd, see resolveClaudeCliBin/CWD below).
 *
 * `--system-prompt-file` and `--max-turns` are real flags but UNDOCUMENTED —
 * absent from `claude --help`, confirmed only in the binary's own strings.
 * The CLI silently ignores unknown options with no error at all (verified:
 * `claude -p --definitely-not-a-flag` produces zero complaint), so a future
 * release renaming either flag would make AuthorAgent send NONE of the
 * soul/book-bible/voice-profile context with no error — see
 * verifyClaudeCliHardening() for the startup canary that guards against
 * exactly this.
 *
 * `--tools` is a VARIADIC option — it must never be placed last, or it will
 * greedily swallow whatever argv element follows it.
 */
export function buildClaudeCliArgs(o: {
  model: string;
  systemPromptFile: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
}): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', o.model,
    '--system-prompt-file', o.systemPromptFile,
    '--tools', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--max-turns', String(o.maxTurns ?? 1),
  ];
  if (o.maxThinkingTokens) {
    args.push('--max-thinking-tokens', String(o.maxThinkingTokens));
  }
  return args;
}

/** Env vars that must NEVER reach the claude-cli child. This repo ships
 *  .env.example and depends on dotenv — if an Anthropic API key or another
 *  provider's credentials leak into the child's environment, Claude Code
 *  prefers the key over OAuth and silently switches the user off their
 *  subscription onto metered per-token billing, which is exactly what was
 *  declined when choosing this provider. Matched by prefix so this stays
 *  effective even as new *_API_KEY-shaped vars are added elsewhere. */
const CLAUDE_CLI_ENV_DENYLIST_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'GOOGLE_', 'GEMINI_', 'OPENAI_',
  'DEEPSEEK_', 'OPENROUTER_', 'AUTHORCLAW_',
];

/** Env vars the OS/OAuth login genuinely depends on. OAuth credentials for
 *  the `claude.ai` login are resolved relative to the user's profile, so
 *  stripping these would break authentication, not just "clean up" the env. */
const CLAUDE_CLI_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'LANG', 'LC_ALL', 'USERNAME', 'COMPUTERNAME',
];

/**
 * Builds a sanitized environment for the claude-cli child: an explicit
 * allowlist of what the OS and OAuth login need, then a denylist pass over
 * whatever made it through (belt-and-braces against a name collision).
 */
export function buildClaudeCliEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CLAUDE_CLI_ENV_ALLOWLIST) {
    const v = parentEnv[key];
    if (v !== undefined) env[key] = v;
  }
  for (const key of Object.keys(env)) {
    if (CLAUDE_CLI_ENV_DENYLIST_PREFIXES.some(p => key.toUpperCase().startsWith(p))) {
      delete env[key];
    }
  }
  return env;
}

/** Dedicated scratch space, entirely outside the workspace directory. The
 *  workspace is a user document tree — often OneDrive/Dropbox-synced on
 *  Windows — and these temp files hold the author's unpublished manuscript
 *  text (soul + book bible + memory), so they don't belong there. */
const CLAUDE_CLI_SCRATCH_DIR = join(tmpdir(), 'authoragent-claude-cli');
/** Empty, dedicated cwd for the child. Claude Code auto-discovers CLAUDE.md
 *  and project context from its working directory — an empty dir means
 *  there's nothing to discover regardless of whether --setting-sources ""
 *  behaves as documented, and it can't wander into AuthorAgent's own source
 *  tree the way it did when the child inherited the gateway's cwd (this was
 *  the actual mechanism behind the error_max_turns failures). */
const CLAUDE_CLI_CWD_DIR = join(CLAUDE_CLI_SCRATCH_DIR, 'cwd');

/**
 * The CLI's `--output-format json` shape isn't a versioned public contract —
 * it's whatever the current `claude` build happens to emit. Pinning a
 * known-good minimum version means a schema change surfaces as a clear
 * "please update" error instead of a silent parse failure mid-pipeline.
 * Bump after manually verifying `claude -p "hi" --output-format json` still
 * returns the `{ result, usage: { input_tokens, output_tokens } }` shape
 * this adapter expects.
 */
const MIN_CLAUDE_CLI_VERSION = '2.0.0';

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(actual: string, min: string): boolean {
  const a = parseSemver(actual);
  const b = parseSemver(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// AI Router
// ═══════════════════════════════════════════════════════════

export class AIRouter {
  private providers: Map<string, AIProvider> = new Map();
  private config: any;
  private vault: Vault;
  private costs: CostTracker;
  private globalPreferredProvider: string | null = null;
  // Tried when globalPreferredProvider (or a per-call preferredId) is
  // configured but currently unavailable — e.g. "try openai, and if it's not
  // reachable, use claude-cli" instead of silently dropping to tier routing.
  private globalPreferredProviderFallback: string | null = null;
  private modelConfig: ModelConfig | null = null;

  // ── Prompt Cache ──
  // Caches system prompt hashes so repeated calls with the same soul/style
  // context can signal cache hits to providers that support it (e.g. Gemini cachedContent).
  private promptCache: Map<string, { hash: string; timestamp: number }> = new Map();
  private cacheHits = 0;
  private cacheMisses = 0;
  private savedTokens = 0;

  // ── Claude Code CLI provider state ──
  // Concurrency cap: config.ai['claude-cli'].maxConcurrent, default 2. Read
  // again in initialize() in case config was reloaded/reinitialized.
  private claudeCliSemaphore = new Semaphore(2);
  private claudeCliVersion: string | null = null;
  private claudeCliBinCache: { bin: string } | null = null;
  // Spacing/backoff between spawns — see CliPacer. Configured in initialize().
  private claudeCliPacer = new CliPacer(1_500, 120_000, () => this.now());
  // claude-cli and claude-cli-opus share one binary/token/rate-limiter — this
  // is the shared health state both providers are gated on. 'auth' failures
  // clear only via a successful lazy re-probe; 'quota' failures clear only
  // once reopenAt passes (claude auth status reports loggedIn:true even
  // while a usage cap is exhausted, so it cannot be used to clear a quota
  // circuit — see classifyClaudeCliFailure).
  private cliHealth: {
    state: 'closed' | 'open';
    reason: 'auth' | 'quota' | '';
    message: string;
    reopenAt: number;
    lastProbeAt: number;
  } = { state: 'closed', reason: '', message: '', reopenAt: 0, lastProbeAt: 0 };

  // Injectable for tests (default: real Node implementations). Not exposed
  // outside the constructor — production code always uses the defaults.
  // execFile is deliberately NOT injected: checkClaudeCLI()'s two calls are
  // simple, already-covered probes; spawn/now are what the streaming
  // rewrite and its timeout logic actually need to be deterministically
  // testable.
  private spawnFn: typeof nodeSpawn;
  private now: () => number;

  constructor(
    config: any,
    vault: Vault,
    costs: CostTracker,
    workspaceDir?: string,
    deps?: { spawn?: typeof nodeSpawn; now?: () => number }
  ) {
    this.config = config;
    this.vault = vault;
    this.costs = costs;
    // When a workspace is provided (production), model overrides are persisted
    // to workspace/data/model-config.json. Tests that omit it get default-only
    // behavior (no override store), matching pre-feature behavior.
    if (workspaceDir) {
      this.modelConfig = new ModelConfig(workspaceDir);
    }
    this.claudeCliSemaphore.setMax(this.config?.['claude-cli']?.maxConcurrent ?? 2);
    this.spawnFn = deps?.spawn ?? nodeSpawn;
    this.now = deps?.now ?? Date.now;
  }

  /**
   * Resolve the active model for a provider using the precedence:
   *   model-config.json override → this.config.<provider>.model → hardcoded default.
   */
  private resolveModel(provider: string, hardcodedDefault: string): string {
    const override = this.modelConfig?.get(provider);
    if (override && override.trim().length > 0) return override.trim();
    const configured = this.config?.[provider]?.model;
    if (configured && String(configured).trim().length > 0) return String(configured).trim();
    return hardcodedDefault;
  }

  /**
   * Build model-aware pricing for a provider's active model. Uses the
   * per-model LLM_PRICING table, falling back to the provider's historical
   * hardcoded numbers for unknown/custom model slugs (never throws).
   */
  private priceFor(provider: string, model: string): { costPer1kInput: number; costPer1kOutput: number } {
    const def = PROVIDER_DEFAULTS[provider];
    const price = getLLMPrice(model, def
      ? { costPer1kInput: def.costPer1kInput, costPer1kOutput: def.costPer1kOutput }
      : undefined);
    return { costPer1kInput: price.costPer1kInput, costPer1kOutput: price.costPer1kOutput };
  }

  async initialize(): Promise<void> {
    // Clear any stale providers (important for reinitialize)
    this.providers.clear();

    // Load persisted model overrides (safe no-op if no store / no file).
    if (this.modelConfig) {
      await this.modelConfig.load();
    }

    // ── Ollama (FREE - Local) ──
    if (this.config.ollama?.enabled !== false) {
      const ollamaAvailable = await this.checkOllama(
        this.config.ollama?.endpoint || 'http://localhost:11434'
      );
      if (ollamaAvailable) {
        const model = this.resolveModel('ollama', PROVIDER_DEFAULTS.ollama.defaultModel);
        const price = this.priceFor('ollama', model);
        this.providers.set('ollama', {
          id: 'ollama',
          name: 'Ollama',
          model,
          tier: 'free',
          available: true,
          endpoint: this.config.ollama?.endpoint || 'http://localhost:11434',
          // Ollama caps depend on the model's context window. 8192 is safe
          // for most modern instruct models without forcing the user to
          // tune num_ctx in their Modelfile.
          maxTokens: 8192,
          costPer1kInput: price.costPer1kInput,
          costPer1kOutput: price.costPer1kOutput,
        });
      }
    }

    // ── Google Gemini (FREE tier) ──
    const geminiKey = await this.vault.get('gemini_api_key');
    if (geminiKey) {
      const model = this.resolveModel('gemini', PROVIDER_DEFAULTS.gemini.defaultModel);
      const price = this.priceFor('gemini', model);
      this.providers.set('gemini', {
        id: 'gemini',
        name: 'Google Gemini',
        model,
        tier: 'free',
        available: true,
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        maxTokens: 65536,
        costPer1kInput: price.costPer1kInput, // Free tier for 2.5 flash/pro
        costPer1kOutput: price.costPer1kOutput,
      });
    }

    // ── DeepSeek (CHEAP) ──
    const deepseekKey = await this.vault.get('deepseek_api_key');
    if (deepseekKey) {
      const model = this.resolveModel('deepseek', PROVIDER_DEFAULTS.deepseek.defaultModel);
      const price = this.priceFor('deepseek', model);
      this.providers.set('deepseek', {
        id: 'deepseek',
        name: 'DeepSeek',
        model,
        tier: 'cheap',
        available: true,
        endpoint: 'https://api.deepseek.com/v1',
        maxTokens: 8192, // DeepSeek-chat supports 8K output tokens
        costPer1kInput: price.costPer1kInput,
        costPer1kOutput: price.costPer1kOutput,
      });
    }

    // ── Anthropic Claude (PAID) ──
    const claudeKey = await this.vault.get('anthropic_api_key');
    if (claudeKey) {
      const model = this.resolveModel('claude', PROVIDER_DEFAULTS.claude.defaultModel);
      const price = this.priceFor('claude', model);
      this.providers.set('claude', {
        id: 'claude',
        name: 'Anthropic Claude',
        model,
        tier: 'paid',
        available: true,
        endpoint: 'https://api.anthropic.com/v1',
        // Claude Sonnet 4.5 supports up to 64K output tokens. 16K is enough
        // for chapter prose + reasoning budget without becoming wasteful.
        maxTokens: 16384,
        costPer1kInput: price.costPer1kInput,
        costPer1kOutput: price.costPer1kOutput,
      });
    }

    // ── OpenAI GPT (PAID, or 'local' when pointed at a custom endpoint) ──
    const openaiKey = await this.vault.get('openai_api_key');
    if (openaiKey) {
      const isLocalEndpoint = Boolean(this.config.openai?.endpoint);
      const model = this.resolveModel('openai', PROVIDER_DEFAULTS.openai.defaultModel);
      // A custom endpoint (LM Studio, vLLM, llama.cpp server) is a
      // self-hosted, zero-cost server — bill it at $0 regardless of whether
      // its model slug happens to collide with a known-priced OpenAI model,
      // rather than falling back to openai's paid default pricing.
      const price = isLocalEndpoint
        ? { costPer1kInput: 0, costPer1kOutput: 0 }
        : this.priceFor('openai', model);
      const endpoint = this.config.openai?.endpoint || 'https://api.openai.com/v1';
      // Custom/local endpoints (LM Studio, vLLM, llama.cpp server, etc.) can
      // be offline without any config change — e.g. LM Studio simply not
      // running. Probe reachability the same way checkOllama() does, so
      // `available` reflects reality and selectProvider()'s preferred-
      // fallback swap can act immediately instead of only after a slow
      // connection-timeout failure on a live call. Skipped for the default
      // api.openai.com endpoint — that's Anthropic-grade infra, not worth
      // an extra startup round-trip to probe.
      let reachable = true;
      if (isLocalEndpoint) {
        reachable = await this.checkOpenAICompatible(endpoint);
        if (!reachable) {
          log.warn(`openai endpoint ${endpoint} not reachable at startup — marking unavailable until next reinitialize`);
        }
      }
      this.providers.set('openai', {
        id: 'openai',
        name: isLocalEndpoint ? 'OpenAI-compatible (local)' : 'OpenAI GPT',
        model,
        tier: isLocalEndpoint ? 'local' : 'paid',
        available: reachable,
        // Configurable so this provider slot can also point at any
        // OpenAI-compatible local server (LM Studio, vLLM, llama.cpp server,
        // text-generation-webui, etc.) — same override pattern as Ollama above.
        endpoint,
        maxTokens: 16384, // GPT-4o + GPT-4o-mini support 16K output tokens
        costPer1kInput: price.costPer1kInput,
        costPer1kOutput: price.costPer1kOutput,
      });
    }

    // ── OpenRouter (FLEXIBLE — access dozens of models with one key) ──
    // Uses OpenAI-compatible API. Model selection lets users swap between
    // Claude / GPT / Gemini / Llama / Mistral / Qwen / etc. without juggling
    // separate API keys. Requested by users who want one billing surface.
    const openrouterKey = await this.vault.get('openrouter_api_key');
    if (openrouterKey) {
      const model = this.resolveModel('openrouter', PROVIDER_DEFAULTS.openrouter.defaultModel);
      const price = this.priceFor('openrouter', model);
      this.providers.set('openrouter', {
        id: 'openrouter',
        name: 'OpenRouter',
        model,
        // Tier depends on the chosen model — default to 'cheap' since users
        // typically pick OpenRouter for cost flexibility. Power users can
        // override per-project.
        tier: 'cheap',
        available: true,
        endpoint: 'https://openrouter.ai/api/v1',
        maxTokens: 16384,
        // Cost varies wildly by model. OpenRouter slugs (e.g.
        // "anthropic/claude-sonnet-4-5") aren't in LLM_PRICING, so this falls
        // back to the historical Claude-Sonnet-pricing estimate. Actual cost
        // is reported by the OpenRouter usage endpoint — don't budget on this.
        costPer1kInput: price.costPer1kInput,
        costPer1kOutput: price.costPer1kOutput,
      });
    }

    // ── Claude Code CLI (FREE — rides your claude.ai subscription login) ──
    // Opt-in: off by default since it depends on a local CLI + interactive
    // login rather than a portable API key. Enable with
    // config.ai['claude-cli'].enabled = true once `claude login` has been run.
    if (this.config['claude-cli']?.enabled === true) {
      // Re-read maxConcurrent in case config changed since construction
      // (reinitialize() runs this again without recreating the router).
      this.claudeCliSemaphore.setMax(this.config['claude-cli']?.maxConcurrent ?? 2);
      this.claudeCliPacer.configure(
        this.config['claude-cli']?.minSpawnGapMs ?? 1_500,
        this.config['claude-cli']?.maxBackoffMs ?? 120_000
      );
      await this.ensureClaudeCliScratchDirs();

      const probe = await this.checkClaudeCLI();
      if (probe.available) {
        const model = this.resolveModel('claude-cli', PROVIDER_DEFAULTS['claude-cli'].defaultModel);
        this.providers.set('claude-cli', {
          id: 'claude-cli',
          name: 'Claude Code (subscription)',
          model,
          tier: 'free',
          available: true,
          endpoint: 'local-cli',
          maxTokens: 16384,
          costPer1kInput: 0,
          costPer1kOutput: 0,
        });

        // Opus variant — same CLI session, model pinned to 'opus'. Registered
        // whenever the base claude-cli probe succeeds; selectProvider() is
        // what decides whether a given task actually gets routed here.
        const opusModel = this.resolveModel('claude-cli-opus', PROVIDER_DEFAULTS['claude-cli-opus'].defaultModel);
        this.providers.set('claude-cli-opus', {
          id: 'claude-cli-opus',
          name: 'Claude Code (subscription, opus)',
          model: opusModel,
          tier: 'free',
          available: true,
          endpoint: 'local-cli',
          maxTokens: 16384,
          costPer1kInput: 0,
          costPer1kOutput: 0,
        });

        // Fire-and-forget: don't delay startup on this, but do log its
        // outcome. See verifyClaudeCliHardening's doc comment for why this
        // exists — the CLI silently ignores unknown flags, so this is the
        // only way to catch a future release quietly breaking the hardening.
        this.verifyClaudeCliHardening().catch(() => {});
      } else {
        log.warn(`claude-cli unavailable: ${probe.reason}`);
      }
    }
  }

  /**
   * Probe the local Claude Code CLI: installed, new enough, and logged in.
   * Mirrors checkOllama()'s "reachable or not" pattern but with richer
   * diagnostics since failures here are usually one-time setup issues
   * (install / update / login) rather than transient network blips.
   */
  private async checkClaudeCLI(): Promise<{ available: boolean; version?: string; reason?: string }> {
    const { bin } = await this.resolveClaudeCliBin();
    let version: string;
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10_000 });
      version = stdout.trim();
      this.claudeCliVersion = version;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { available: false, reason: `Claude Code CLI not found at "${bin}". Install it first, or set config.ai['claude-cli'].binPath.` };
      }
      return { available: false, reason: `Claude Code CLI check failed: ${err?.message || err}` };
    }

    if (!versionAtLeast(version, MIN_CLAUDE_CLI_VERSION)) {
      return {
        available: false,
        version,
        reason: `Claude Code CLI ${version} is older than the minimum tested version ` +
                 `${MIN_CLAUDE_CLI_VERSION}. Run "claude update" before enabling this provider.`,
      };
    }

    try {
      const { stdout } = await execFileAsync(bin, ['auth', 'status'], { timeout: 10_000 });
      const status = JSON.parse(stdout);
      if (!status?.loggedIn) {
        return { available: false, version, reason: 'Claude Code CLI is installed but not logged in. Run "claude login".' };
      }
    } catch (err: any) {
      return {
        available: false,
        version,
        reason: `Could not confirm Claude Code CLI login status: ${err?.message || err}. Run "claude login".`,
      };
    }

    return { available: true, version };
  }

  /**
   * Create the claude-cli scratch directories if missing, and sweep any
   * leftover temp system-prompt files older than an hour (crash residue
   * from a prior run — normal cleanup is try/finally per call, this is only
   * the backstop for when that couldn't run).
   */
  private async ensureClaudeCliScratchDirs(): Promise<void> {
    try {
      await mkdir(CLAUDE_CLI_SCRATCH_DIR, { recursive: true });
      await mkdir(CLAUDE_CLI_CWD_DIR, { recursive: true });
      const entries = await readdir(CLAUDE_CLI_SCRATCH_DIR).catch(() => [] as string[]);
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const name of entries) {
        if (name === 'cwd') continue;
        const p = join(CLAUDE_CLI_SCRATCH_DIR, name);
        try {
          const s = await stat(p);
          if (s.isFile() && s.mtimeMs < cutoff) await unlink(p).catch(() => {});
        } catch {
          // Gone already, or not a file we can stat — ignore either way.
        }
      }
    } catch (err: any) {
      log.warn(`[claude-cli] could not prepare scratch dir ${CLAUDE_CLI_SCRATCH_DIR}: ${err?.message || err}`);
    }
  }

  /**
   * Resolve the real claude CLI binary, preferring a native install over any
   * shim. On this platform, `spawn('claude')` resolves via PATH to whichever
   * comes first — often a package-manager SHIM (e.g. a chocolatey wrapper)
   * that launches the real, much larger binary as its OWN child process.
   * Killing the shim (our normal cleanup — see the #25629 workaround in
   * runClaudeCliOnce) does not kill that grandchild: it keeps running,
   * holds the temp system-prompt file open, and keeps consuming
   * subscription quota. This was firing on every successful call. Cached
   * after the first resolution since it can't change during a process's
   * lifetime.
   */
  private async resolveClaudeCliBin(): Promise<{ bin: string }> {
    if (this.claudeCliBinCache) return this.claudeCliBinCache;

    const configured = this.config?.['claude-cli']?.binPath;
    if (configured && existsSync(configured)) {
      this.claudeCliBinCache = { bin: configured };
      return this.claudeCliBinCache;
    }
    if (process.platform === 'win32') {
      const nativeCandidate = join(homedir(), '.local', 'bin', 'claude.exe');
      if (existsSync(nativeCandidate)) {
        this.claudeCliBinCache = { bin: nativeCandidate };
        return this.claudeCliBinCache;
      }
    }
    // Fall back to ordinary PATH resolution (unchanged behavior). If this
    // resolves to a wrapper/shim, config.ai['claude-cli'].binPath is the
    // escape hatch to point at the real binary explicitly.
    this.claudeCliBinCache = { bin: 'claude' };
    return this.claudeCliBinCache;
  }

  /**
   * Kill a claude-cli child, and on Windows kill its whole process tree —
   * plain SIGTERM only terminates the immediate process, not a grandchild
   * launched by a shim (see resolveClaudeCliBin). Fire-and-forget: this
   * runs during cleanup, after the call has already resolved or rejected,
   * so a failure here must never surface as a call failure.
   */
  private killClaudeCliProcess(child: import('node:child_process').ChildProcess): void {
    if (child.killed || child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => { /* best-effort */ });
    } else {
      child.kill('SIGTERM');
    }
  }

  /** Writes the system prompt to a unique scratch file for --system-prompt-file.
   *  Mode 0o600, never logged (only its length is — see runClaudeCliOnce). */
  private async writeSystemPromptFile(content: string): Promise<string> {
    const path = join(CLAUDE_CLI_SCRATCH_DIR, `${process.pid}-${Date.now()}-${randomUUID()}.txt`);
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
    return path;
  }

  /**
   * Removes a temp system-prompt file, retrying briefly since on Windows an
   * unlink of a file the (just-killed) child still has open can fail with
   * EBUSY/EPERM rather than deferring like POSIX would. Never throws —
   * cleanup failure must not fail the call; ensureClaudeCliScratchDirs's
   * hourly sweep is the backstop for anything that never gets removed.
   */
  private async removeSystemPromptFile(path: string): Promise<void> {
    const delays = [50, 150, 400];
    for (let i = 0; i <= delays.length; i++) {
      try {
        await unlink(path);
        return;
      } catch (err: any) {
        if (err?.code === 'ENOENT') return;
        if (i === delays.length) {
          log.warn(`[claude-cli] could not remove temp system-prompt file (will be swept later): ${path}`);
          return;
        }
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }
  }

  /**
   * Returns a rejection message if the shared claude-cli/claude-cli-opus
   * circuit is open, or null if the call may proceed. Checked BEFORE
   * spawning — a known-broken transport should fail in milliseconds with an
   * actionable message, not after a multi-minute timeout.
   */
  private checkClaudeCliCircuit(): string | null {
    const h = this.cliHealth;
    if (h.state === 'closed') return null;

    const now = this.now();
    if (h.reason === 'quota') {
      if (now >= h.reopenAt) {
        this.closeClaudeCliCircuit();
        return null;
      }
      const mins = Math.ceil((h.reopenAt - now) / 60_000);
      return `${h.message} (retry in ~${mins} min)`;
    }

    // auth: only a successful re-probe can clear this. Rate-limited to once
    // a minute so a retry storm can't turn into a probe storm — and note a
    // usage-cap exhaustion still reports loggedIn:true, so this path is
    // only ever entered for genuine auth failures, never quota ones.
    if (now - h.lastProbeAt > 60_000) {
      h.lastProbeAt = now;
      this.checkClaudeCLI()
        .then(probe => {
          if (probe.available) {
            this.closeClaudeCliCircuit();
            const cli = this.providers.get('claude-cli');
            const opus = this.providers.get('claude-cli-opus');
            if (cli) cli.available = true;
            if (opus) opus.available = true;
            log.info('[claude-cli] auth circuit cleared by lazy re-probe.');
          }
        })
        .catch(() => { /* stays open; next call retries the probe after the cooldown */ });
    }
    return h.message;
  }

  private openClaudeCliCircuit(reason: 'auth' | 'quota', message: string, retryAfterMs?: number): void {
    const alreadyOpenSameReason = this.cliHealth.state === 'open' && this.cliHealth.reason === reason;
    this.cliHealth = {
      state: 'open',
      reason,
      message,
      reopenAt: reason === 'quota' ? this.now() + (retryAfterMs ?? 15 * 60_000) : 0,
      lastProbeAt: this.cliHealth.lastProbeAt,
    };
    if (reason === 'auth') {
      const cli = this.providers.get('claude-cli');
      const opus = this.providers.get('claude-cli-opus');
      if (cli) cli.available = false;
      if (opus) opus.available = false;
    }
    if (!alreadyOpenSameReason) {
      log.warn(`[claude-cli] circuit OPEN (${reason}): ${message}`);
    }
  }

  private closeClaudeCliCircuit(): void {
    if (this.cliHealth.state === 'closed') return;
    log.info(`[claude-cli] circuit CLOSED (was: ${this.cliHealth.reason})`);
    this.cliHealth = { state: 'closed', reason: '', message: '', reopenAt: 0, lastProbeAt: this.cliHealth.lastProbeAt };
  }

  /**
   * Startup canary — the mitigation for the CLI's silent-unknown-flag
   * behavior. Runs one hardened call with a nonce embedded in the
   * system-prompt file and asserts the reply contains it, which is the only
   * way to actually prove --system-prompt-file is honored rather than
   * silently ignored. Also warns (does not fail) if input_tokens comes back
   * suspiciously high, which would mean the scaffolding-stripping flags
   * (--tools "", --strict-mcp-config, etc.) stopped taking effect. Never
   * takes the provider offline on a miss — a false-negative canary
   * shouldn't remove the user's only configured transport.
   */
  private async verifyClaudeCliHardening(): Promise<void> {
    if (this.config?.['claude-cli']?.canary === false) return;
    const nonce = randomUUID().slice(0, 8);
    try {
      const result = await this.runClaudeCliOnce(
        { id: 'claude-cli', name: 'canary', model: 'sonnet', tier: 'free', available: true, endpoint: 'local-cli', maxTokens: 100, costPer1kInput: 0, costPer1kOutput: 0 },
        {
          provider: 'claude-cli',
          system: `You are a test harness. Reply with exactly: OK-${nonce}`,
          messages: [{ role: 'user', content: 'ping' }],
        },
        this.now()
      );
      if (!result.text.includes(nonce)) {
        log.warn(
          `[claude-cli] startup canary: reply did not contain the expected nonce — ` +
          `--system-prompt-file may not be honored by this CLI version. Reply: "${result.text.slice(0, 200)}"`
        );
      } else if (result.tokensUsed > 3_000) {
        log.warn(
          `[claude-cli] startup canary: input+output tokens=${result.tokensUsed}, expected well under 1,000. ` +
          `The hardening flags (--tools "", --strict-mcp-config, etc.) may no longer be taking effect — ` +
          `a CLI update may have changed flag names or behavior.`
        );
      } else {
        log.info(`[claude-cli] startup canary passed (${result.tokensUsed} tokens).`);
      }
    } catch (err: any) {
      log.warn(`[claude-cli] startup canary failed to run: ${err?.message || err}`);
    }
  }

  /**
   * Re-scan the vault for API keys and rebuild the provider list.
   * Called after storing a new API key so the router picks it up
   * without requiring a server restart.
   */
  async reinitialize(): Promise<string[]> {
    await this.initialize();
    return this.getActiveProviders().map(p => p.id);
  }

  /**
   * Set (or clear) a provider's model override, persist it, and reinitialize
   * so the change takes effect without a restart. Passing an empty model
   * clears the override (reverts to config/default).
   *
   * Throws if the provider id is not a known provider.
   */
  async setProviderModel(provider: string, model: string): Promise<void> {
    if (!PROVIDER_DEFAULTS[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    if (!this.modelConfig) {
      throw new Error('Model config store not initialized (no workspace dir configured).');
    }
    await this.modelConfig.set(provider, model);
    await this.reinitialize();
  }

  /** Known providers, whether or not they're currently available (have a key). */
  getKnownProviders(): string[] {
    return Object.keys(PROVIDER_DEFAULTS);
  }

  /**
   * Describe every known provider's model config for the settings UI:
   * current active model, hardcoded default, tier, known-model list, and the
   * model-aware price for the current model. `available` reflects whether the
   * provider currently has a key / is reachable.
   */
  getProviderModelInfo(): Array<{
    id: string;
    available: boolean;
    currentModel: string;
    defaultModel: string;
    override: string | null;
    tier: 'free' | 'cheap' | 'paid' | 'local';
    knownModels: string[];
    price: { costPer1kInput: number; costPer1kOutput: number; confidence: string; lastVerified: string };
  }> {
    return Object.entries(PROVIDER_DEFAULTS).map(([id, def]) => {
      const active = this.providers.get(id);
      // Resolve the current model even when the provider isn't active (no key),
      // so the UI can still show what it WOULD use.
      const currentModel = active?.model ?? this.resolveModel(id, def.defaultModel);
      // Reflect the actually-registered tier when the provider is active
      // (e.g. 'local' for an openai-slot server pointed at a custom
      // endpoint) — def.tier is only the generic per-id default.
      const tier = active?.tier ?? def.tier;
      // A 'local' provider's unknown-model fallback must be $0, not openai's
      // paid default — otherwise this settings list would show phantom
      // pricing for a free self-hosted server even though the actual routing
      // path (priceFor() in initialize()) already bills it at $0.
      const priceFallback = tier === 'local'
        ? { costPer1kInput: 0, costPer1kOutput: 0 }
        : { costPer1kInput: def.costPer1kInput, costPer1kOutput: def.costPer1kOutput };
      const priceRow = getLLMPrice(currentModel, priceFallback);
      return {
        id,
        available: !!active?.available,
        currentModel,
        defaultModel: def.defaultModel,
        override: this.modelConfig?.get(id) ?? null,
        tier,
        knownModels: KNOWN_MODELS[id] ?? [],
        price: {
          costPer1kInput: priceRow.costPer1kInput,
          costPer1kOutput: priceRow.costPer1kOutput,
          confidence: priceRow.confidence,
          lastVerified: priceRow.lastVerified,
        },
      };
    });
  }

  private async checkOllama(endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Reachability probe for a custom OpenAI-compatible endpoint (LM Studio,
   * vLLM, etc.) — GET /models is the de facto standard health-check route
   * across these servers. Same 3s-timeout pattern as checkOllama().
   */
  private async checkOpenAICompatible(endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ad-hoc connectivity test for a single provider, used by the Connections
   * UI's [Test] button. Reuses the same reachability probes run at startup
   * (checkOllama / checkOpenAICompatible / checkClaudeCLI) — never spends a
   * real completion call just to answer "is this configured correctly".
   */
  async testProvider(id: string): Promise<{ ok: boolean; message: string }> {
    switch (id) {
      case 'ollama': {
        const endpoint = this.config.ollama?.endpoint || 'http://localhost:11434';
        const ok = await this.checkOllama(endpoint);
        return ok
          ? { ok: true, message: `Reachable at ${endpoint}.` }
          : { ok: false, message: `Not reachable at ${endpoint}. Is "ollama serve" running?` };
      }
      case 'openai': {
        const customEndpoint = this.config.openai?.endpoint;
        if (!customEndpoint) {
          const hasKey = Boolean(await this.vault.get('openai_api_key'));
          return hasKey
            ? { ok: true, message: 'API key configured for api.openai.com.' }
            : { ok: false, message: 'No OpenAI API key configured.' };
        }
        const ok = await this.checkOpenAICompatible(customEndpoint);
        return ok
          ? { ok: true, message: `Reachable at ${customEndpoint}.` }
          : { ok: false, message: `Not reachable at ${customEndpoint}. Check the URL and that the server is running.` };
      }
      case 'claude-cli':
      case 'claude-cli-opus': {
        const probe = await this.checkClaudeCLI();
        return probe.available
          ? { ok: true, message: `Claude Code CLI ${probe.version || ''} logged in.`.trim() }
          : { ok: false, message: probe.reason || 'Claude Code CLI is not available.' };
      }
      default: {
        if (!PROVIDER_DEFAULTS[id]) {
          return { ok: false, message: `Unknown provider "${id}".` };
        }
        const provider = this.providers.get(id);
        return provider?.available
          ? { ok: true, message: `Configured (${provider.endpoint}).` }
          : { ok: false, message: 'No API key configured for this provider.' };
      }
    }
  }

  /**
   * Set or clear the global preferred provider.
   * When set, this provider is tried first for ALL tasks before tier routing.
   */
  setGlobalPreferredProvider(providerId: string | null): void {
    this.globalPreferredProvider = providerId;
  }

  getGlobalPreferredProvider(): string | null {
    return this.globalPreferredProvider;
  }

  /**
   * Set (or clear) the fallback provider used when the primary preference
   * (global or per-call) is configured but not currently available.
   */
  setGlobalPreferredProviderFallback(providerId: string | null): void {
    this.globalPreferredProviderFallback = providerId;
  }

  getGlobalPreferredProviderFallback(): string | null {
    return this.globalPreferredProviderFallback;
  }

  /**
   * Select the best provider for a given task type using tiered routing.
   * Priority: per-project override → global preference → preferred fallback
   * → tier routing. When a preferred provider is set, it is ALWAYS used if
   * available, regardless of task tier.
   */
  selectProvider(taskType: string, preferredId?: string): AIProvider {
    // Resolve effective preference: per-project > global
    let effectivePref = preferredId || this.globalPreferredProvider;

    // Preferred-provider fallback: the primary preference is configured but
    // not currently reachable (server down, no key, CLI not logged in) —
    // e.g. "try openai, and if it's not available, use claude-cli" instead
    // of silently dropping straight to tier routing.
    if (effectivePref && !this.providers.get(effectivePref)?.available &&
        this.globalPreferredProviderFallback && this.globalPreferredProviderFallback !== effectivePref) {
      log.warn(`Preferred provider '${effectivePref}' not available, using configured fallback '${this.globalPreferredProviderFallback}'`);
      effectivePref = this.globalPreferredProviderFallback;
    }

    // claude-cli premium-task bump: when claude-cli is the effective
    // preference and this task is prose-quality-sensitive (drafting, final
    // polish), swap to the opus-pinned variant if it's available. Falls
    // through to plain claude-cli (sonnet) otherwise — this only ever
    // affects users who've explicitly set claude-cli as their provider.
    if (effectivePref === 'claude-cli' && CLAUDE_CLI_PREMIUM_TASKS.has(taskType)) {
      const opus = this.providers.get('claude-cli-opus');
      if (opus?.available) {
        effectivePref = 'claude-cli-opus';
      }
    }

    if (effectivePref) {
      const pref = this.providers.get(effectivePref);
      if (pref?.available) {
        return pref;
      }
      // For Ollama, re-check availability in case it came online after startup
      if (effectivePref === 'ollama' && !pref) {
        log.warn(`Ollama preferred but not in provider list — will be checked on next reinitialize`);
      } else {
        log.warn(`Preferred provider '${effectivePref}' not available, falling back to tier routing`);
      }
    }

    const tier = TASK_TIERS[taskType] || TASK_TIERS.general;
    const preference = TIER_ROUTING[tier];

    for (const providerId of preference) {
      const provider = this.providers.get(providerId);
      if (provider?.available) {
        // Check budget — skip metered providers if over budget. 'local' is
        // exempt alongside 'free': it's a zero-cost self-hosted server, not
        // something that can trip the spend cap.
        if (provider.tier !== 'free' && provider.tier !== 'local' && this.costs.isOverBudget()) {
          continue;
        }
        return provider;
      }
    }

    // Absolute fallback
    const any = Array.from(this.providers.values()).find(p => p.available);
    if (!any) {
      throw new Error('No AI providers available. Please configure at least Ollama (free) or an API key.');
    }
    return any;
  }

  /**
   * Get fallback provider if primary fails (live call error, not just
   * unavailable-at-selection-time — see selectProvider() for that case).
   * Respects the budget cap — skips paid providers when the user is over budget,
   * preferring free providers (Ollama, Gemini free tier) instead.
   */
  getFallbackProvider(currentId: string): AIProvider | null {
    // claude-cli and claude-cli-opus are the SAME transport (one binary, one
    // OAuth token, one rate limiter). A failed claude-cli call falling back
    // to claude-cli-opus isn't a fallback, it's a retry of the same broken
    // thing — confirmed in production: an auth failure on claude-cli was
    // immediately followed by the identical auth failure on claude-cli-opus,
    // doubling load on an already-unhealthy transport. Treat both ids as
    // "current" so neither can be selected as the other's fallback.
    const sameTransport = CLAUDE_CLI_TRANSPORT_IDS.has(currentId)
      ? CLAUDE_CLI_TRANSPORT_IDS
      : new Set([currentId]);

    // Explicit preferred fallback takes priority over the generic free/paid
    // heuristic below — e.g. "openai's live call just failed, go straight to
    // claude-cli" instead of whatever happens to be first by insertion order.
    if (this.globalPreferredProviderFallback && !sameTransport.has(this.globalPreferredProviderFallback)) {
      const configured = this.providers.get(this.globalPreferredProviderFallback);
      if (configured?.available) {
        return configured;
      }
    }

    const overBudget = this.costs?.isOverBudget?.() ?? false;
    // Prefer free (and local, equally zero-cost) providers first so we don't
    // silently burn budget on fallback.
    const freeProviders: AIProvider[] = [];
    const paidProviders: AIProvider[] = [];
    for (const [id, provider] of this.providers) {
      if (sameTransport.has(id) || !provider.available) continue;
      if (provider.tier === 'free' || provider.tier === 'local') freeProviders.push(provider);
      else paidProviders.push(provider);
    }
    if (freeProviders.length > 0) return freeProviders[0];
    if (overBudget) return null; // Over budget and no free provider — fail closed.
    return paidProviders[0] ?? null;
  }

  /**
   * Send completion request to the selected provider.
   * Tracks system prompt cache hits to estimate token savings.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      throw new Error(`Provider ${request.provider} not found`);
    }

    // ── Prompt cache tracking ──
    const promptHash = this.hashPrompt(request.system);
    const cacheKey = `${provider.id}:system`;
    const cached = this.promptCache.get(cacheKey);

    if (cached && cached.hash === promptHash) {
      this.cacheHits++;
      // Estimate saved tokens: rough system prompt token count (chars / 4)
      this.savedTokens += Math.ceil(request.system.length / 4);
    } else {
      this.cacheMisses++;
      this.promptCache.set(cacheKey, { hash: promptHash, timestamp: Date.now() });
    }

    switch (provider.id) {
      case 'ollama':
        return this.completeOllama(provider, request);
      case 'gemini':
        return this.completeGemini(provider, request);
      case 'deepseek':
        return this.completeOpenAICompatible(provider, request, 'deepseek_api_key');
      case 'claude':
        return this.completeClaude(provider, request);
      case 'claude-cli':
      case 'claude-cli-opus':
        return this.completeClaudeCode(provider, request);
      case 'openai':
        return this.completeOpenAICompatible(provider, request, 'openai_api_key');
      case 'openrouter':
        return this.completeOpenAICompatible(provider, request, 'openrouter_api_key');
      default:
        throw new Error(`Unknown provider: ${provider.id}`);
    }
  }

  /**
   * Returns prompt cache statistics for the dashboard
   */
  getCacheStats(): { hits: number; misses: number; savedTokens: number } {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      savedTokens: this.savedTokens,
    };
  }

  /**
   * Compute a fast hash of a system prompt for cache comparison
   */
  private hashPrompt(prompt: string): string {
    return createHash('sha256').update(prompt).digest('hex');
  }

  // ── Ollama (OpenAI-compatible local) ──
  private async completeOllama(
    provider: AIProvider,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    let response: Response;
    try {
      response = await fetch(`${provider.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: request.system },
            ...request.messages,
          ],
          stream: false,
          options: {
            temperature: request.temperature ?? 0.7,
            num_predict: request.maxTokens ?? provider.maxTokens,
          },
        }),
      });
    } catch (err: any) {
      // Connection refused / timeout / DNS — surface clearly so callers can fall back.
      throw new Error(`Ollama unreachable at ${provider.endpoint}: ${err?.message || err}. Is "ollama serve" running?`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Common case: model not pulled. Detect and explain.
      const lower = body.toLowerCase();
      if (response.status === 404 || lower.includes('not found') || lower.includes('try pulling')) {
        throw new Error(`Ollama model "${provider.model}" is not installed. Run: ollama pull ${provider.model}`);
      }
      throw new Error(`Ollama error ${response.status}: ${body.substring(0, 300) || response.statusText}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      throw new Error(`Ollama returned invalid JSON: ${err?.message || err}`);
    }

    if (data?.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const text = data?.message?.content || '';
    if (!text || text.trim().length === 0) {
      // Empty response from Ollama is almost always a model misload, context overflow,
      // or num_predict exhaustion. Throw so the router falls back to another provider
      // instead of silently passing an empty string up to the user.
      throw new Error(
        `Ollama returned an empty response. ` +
        `Common causes: context window exceeded for model "${provider.model}", ` +
        `model still loading, or num_predict too small. ` +
        `Try a model with a larger context window (e.g., llama3.1:8b-instruct-q4_K_M) or split the task.`
      );
    }

    return {
      text,
      tokensUsed: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      estimatedCost: 0,
      provider: 'ollama',
    };
  }

  // ── Google Gemini ──
  private async completeGemini(
    provider: AIProvider,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    const apiKey = await this.vault.get('gemini_api_key');
    // Reasoning effort → Gemini thinkingBudget (works on Gemini 2.5 Pro/Flash;
    // ignored / no-op on older models). thinkingBudget is in tokens.
    // -1 = "model decides" (Google's recommendation for adaptive thinking).
    const thinkingBudget = request.thinking
      ? { low: 1024, medium: 4096, high: 16384 }[request.thinking]
      : null;
    const generationConfig: any = {
      temperature: request.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens ?? provider.maxTokens,
    };
    if (thinkingBudget) {
      generationConfig.thinkingConfig = {
        thinkingBudget,
        includeThoughts: false, // We don't need the raw CoT in our response
      };
    }

    const response = await fetch(
      `${provider.endpoint}/models/${provider.model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: request.messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig,
        }),
      }
    );

    const data = await response.json() as any;
    if (data.error) {
      log.error(`  ✗ Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
      throw new Error(`Gemini API error: ${data.error.message || 'Unknown error'}`);
    }
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '';
    // Detect Gemini blocking the response (safety filter, recitation, language, etc.)
    // Without this, blocked responses silently came through as empty strings and the
    // outline / writing step failed with a confusing "too-short response" error.
    if (!text || text.trim().length === 0) {
      const finishReason = candidate?.finishReason || data.promptFeedback?.blockReason;
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(
          `Gemini blocked the response (finishReason: ${finishReason}). ` +
          `This usually happens when prompts mention violence, sexual content, or copyrighted material. ` +
          `Try rephrasing the project description, or switch to Claude / DeepSeek for creative-writing steps.`
        );
      }
      throw new Error('Gemini returned an empty response. Try again or fall back to another provider.');
    }
    const usage = data.usageMetadata;
    return {
      text,
      tokensUsed: (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0),
      estimatedCost: 0, // Free tier
      provider: 'gemini',
    };
  }

  // ── Anthropic Claude ──
  private async completeClaude(
    provider: AIProvider,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    const apiKey = await this.vault.get('anthropic_api_key');
    // Reasoning effort → Claude thinking budget (tokens spent on hidden CoT).
    // Anthropic requires temperature=1 and max_tokens > thinking budget.
    const thinkingBudget = request.thinking
      ? { low: 1024, medium: 4096, high: 16384 }[request.thinking]
      : null;
    const maxTokens = request.maxTokens ?? provider.maxTokens;
    const effectiveMaxTokens = thinkingBudget
      ? Math.max(maxTokens, thinkingBudget + 2048)
      : maxTokens;

    const body: any = {
      model: provider.model,
      max_tokens: effectiveMaxTokens,
      system: request.system,
      messages: request.messages,
    };
    if (thinkingBudget) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
      // Anthropic requires temperature=1 when thinking is enabled.
      body.temperature = 1;
    } else if (typeof request.temperature === 'number') {
      body.temperature = request.temperature;
    }

    const response = await fetch(`${provider.endpoint}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as any;
    if (data.error) {
      log.error(`  ✗ Claude API error: ${data.error.message || JSON.stringify(data.error)}`);
      throw new Error(`Claude API error: ${data.error.message || 'Unknown error'}`);
    }
    // When thinking is enabled, content array contains a 'thinking' block
    // followed by one or more 'text' blocks. Extract only the text — the
    // hidden reasoning is internal to the model.
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('') || '';
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return {
      text,
      tokensUsed: inputTokens + outputTokens,
      estimatedCost: (inputTokens / 1000) * provider.costPer1kInput +
                     (outputTokens / 1000) * provider.costPer1kOutput,
      provider: 'claude',
    };
  }

  // ── Claude Code CLI (subscription-backed, no metered API key) ──
  //
  // CAVEATS:
  //  - Claude Code's rate limits/usage caps are tuned for interactive coding
  //    sessions, not a pipeline firing hundreds of calls per book. Keep
  //    maxConcurrent low (config.ai['claude-cli'].maxConcurrent) — the
  //    CliPacer below adds spacing/backoff on top of that, and the shared
  //    circuit breaker fails fast instead of retrying into a known-broken
  //    transport.
  //  - Single-shot only: `claude -p` isn't a multi-turn chat API, so the
  //    message history below is flattened into one prompt.
  //  - This is a NON-agentic invocation: --tools "" disables all tool
  //    access, so AuthorAgent's own context injection is the only context
  //    the model gets. That's deliberate — see buildClaudeCliArgs's doc
  //    comment for why (75x-207x fewer tokens per call than an agentic
  //    invocation, measured).
  private async completeClaudeCode(
    provider: AIProvider,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    const circuitMessage = this.checkClaudeCliCircuit();
    if (circuitMessage) {
      throw new ClaudeCliError(`Claude Code CLI unavailable: ${circuitMessage}`, this.cliHealth.reason || 'transient');
    }

    const enqueuedAt = this.now();
    await this.claudeCliPacer.waitTurn();

    try {
      const queueTimeoutMs = this.config?.['claude-cli']?.queueWaitTimeoutMs ?? 600_000;
      const result = await this.claudeCliSemaphore.run(
        () => this.runClaudeCliOnce(provider, request, enqueuedAt),
        { queueTimeoutMs }
      );
      this.claudeCliPacer.recordSuccess();
      return result;
    } catch (err: any) {
      const kind: CliFailureKind = err instanceof ClaudeCliError ? err.kind : 'transient';
      if (kind === 'auth') {
        this.openClaudeCliCircuit('auth', err.message);
      } else if (kind === 'quota') {
        this.openClaudeCliCircuit('quota', err.message, err.retryAfterMs);
        this.claudeCliPacer.recordFailure();
      } else {
        this.claudeCliPacer.recordFailure();
      }
      throw err;
    }
  }

  /**
   * Runs one hardened `claude -p` invocation in STREAMING mode, timing out
   * on INACTIVITY rather than total duration.
   *
   * Why streaming: output-heavy tasks (full chapter drafts, 20-30 chapter
   * outlines) can legitimately take 5-10+ minutes of steady token
   * production. A flat overall-duration timeout can't distinguish "still
   * working, just slow" from "genuinely stuck" — it just kills whichever
   * one happens to still be running when the clock runs out. This is a real
   * regression that shipped once already: `--output-format stream-json`
   * WITHOUT `--include-partial-messages` does not stream tokens at all — it
   * emits one JSON object per COMPLETE message (init, then total silence
   * for the entire generation, then the assistant message, then result). An
   * inactivity timer built on that alone is a total-duration timeout in
   * disguise. `--include-partial-messages` is what makes stdout activity a
   * real proxy for "is it still working."
   *
   * We do NOT wait for the child process to exit naturally: resolve as soon
   * as the `{"type":"result",...}` event is seen, then kill the process
   * ourselves. This works around a confirmed upstream bug
   * (anthropics/claude-code#25629) where stream-json mode can hang
   * indefinitely *after* emitting the result event instead of exiting.
   *
   * `enqueuedAt` (timestamp from before the semaphore was acquired) lets us
   * log actual queue-wait time — previously invisible, now the first thing
   * in the spawn log line.
   */
  private async runClaudeCliOnce(
    provider: AIProvider,
    request: CompletionRequest,
    enqueuedAt: number
  ): Promise<CompletionResponse> {
    if (!isSafeClaudeCliModel(provider.model)) {
      throw new ClaudeCliError(
        `Refusing to spawn claude-cli with a suspicious model value: "${provider.model}".`,
        'fatal'
      );
    }

    const transcript = request.messages
      .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n\n');

    const lengthDirective = deriveLengthDirective(request.maxTokens);
    const systemPromptContent = lengthDirective ? `${request.system}${lengthDirective}` : request.system;
    const maxThinkingTokens = mapThinkingToMaxThinkingTokens(request.thinking);

    const cfg = this.config?.['claude-cli'] ?? {};
    const firstTokenBaseMs: number = cfg.firstTokenTimeoutMs ?? 120_000;
    const firstTokenCeilingMs: number = cfg.firstTokenCeilingMs ?? 420_000;
    const inactivityTimeoutMs: number = cfg.inactivityTimeoutMs ?? 60_000;
    const maxTimeoutMs: number = cfg.maxTimeoutMs ?? 900_000;
    const totalChars = systemPromptContent.length + transcript.length;
    const firstTokenBudgetMs = computeFirstTokenBudgetMs(totalChars, firstTokenBaseMs, firstTokenCeilingMs);

    const queueWaitMs = this.now() - enqueuedAt;
    const startedAt = this.now();

    const { bin } = await this.resolveClaudeCliBin();
    const args = buildClaudeCliArgs({
      model: provider.model,
      systemPromptFile: '', // placeholder — filled in below once the file exists
      maxTurns: 1,
      maxThinkingTokens,
    });

    const systemPromptFile = await this.writeSystemPromptFile(systemPromptContent);
    // Patch the real path into argv now that the file exists (buildClaudeCliArgs
    // is a pure function and can't await the write itself).
    const systemPromptFileIdx = args.indexOf('--system-prompt-file') + 1;
    args[systemPromptFileIdx] = systemPromptFile;

    log.info(
      `[claude-cli] spawning: model=${provider.model} promptChars=${transcript.length} ` +
      `systemChars=${systemPromptContent.length} queueWaitMs=${queueWaitMs} ` +
      `firstTokenBudgetMs=${Math.round(firstTokenBudgetMs)} inactivityTimeoutMs=${inactivityTimeoutMs} ` +
      `maxTimeoutMs=${maxTimeoutMs} activeSemaphoreSlots=${this.claudeCliSemaphore.debugState()}`
    );

    try {
      return await new Promise<CompletionResponse>((resolve, reject) => {
        const child = this.spawnFn(bin, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: CLAUDE_CLI_CWD_DIR,
          env: buildClaudeCliEnv(process.env),
        });

        let stderrBuf = '';
        let settled = false;
        let sawFirstByte = false;
        let lastStdoutActivity = this.now();

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearInterval(watchdog);
          clearTimeout(hardCeiling);
          fn();
          this.killClaudeCliProcess(child);
        };

        const reader = createNdjsonLineReader((line) => {
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            return; // not every line is JSON we care about; skip silently
          }
          if (evt?.type !== 'result') return;

          const text = evt?.result ?? '';
          log.info(
            `[claude-cli] result event after ${this.now() - startedAt}ms: ` +
            `is_error=${evt?.is_error} subtype=${evt?.subtype} numTurns=${evt?.num_turns} chars=${text.length}` +
            (evt?.is_error && !text ? ` (empty result on error — subtype is the only detail available)` : '')
          );
          const parsed = parseClaudeCliResultEvent(evt);
          finish(() => {
            if (!parsed.ok) {
              const classified = classifyClaudeCliFailure({ resultText: parsed.error, stderr: stderrBuf });
              reject(new ClaudeCliError(`Claude Code CLI error: ${parsed.error}`, classified.kind, classified.retryAfterMs));
              return;
            }
            resolve({
              text: parsed.text,
              tokensUsed: parsed.tokensUsed,
              // Rides the subscription — no separate metered cost to the
              // user, even though the CLI's own JSON includes an internal
              // total_cost_usd estimate.
              estimatedCost: 0,
              provider: provider.id, // 'claude-cli' or 'claude-cli-opus'
            });
          });
        });

        const watchdog = setInterval(() => {
          const now = this.now();
          if (!sawFirstByte) {
            if (now - startedAt > firstTokenBudgetMs) {
              finish(() => reject(new ClaudeCliError(
                `Claude Code CLI: no output for ${Math.round((now - startedAt) / 1000)}s waiting for the ` +
                `first response byte (budget ${Math.round(firstTokenBudgetMs / 1000)}s for a ${totalChars}-char prompt).`
              )));
            }
            return;
          }
          if (now - lastStdoutActivity > inactivityTimeoutMs) {
            log.warn(`[claude-cli] no stdout for ${Math.round((now - lastStdoutActivity) / 1000)}s mid-generation — treating as stuck, killing.`);
            finish(() => reject(new ClaudeCliError(
              `Claude Code CLI: no output for ${Math.round(inactivityTimeoutMs / 1000)}s mid-generation ` +
              `(likely stuck) after ${now - startedAt}ms total.`
            )));
          }
        }, 5_000);

        const hardCeiling = setTimeout(() => {
          finish(() => reject(new ClaudeCliError(
            `Claude Code CLI call exceeded the ${Math.round(maxTimeoutMs / 1000)}s hard ceiling — ` +
            `still producing output, but this is taking unreasonably long.`
          )));
        }, maxTimeoutMs);

        child.on('error', (err: any) => {
          finish(() => {
            if (err?.code === 'ENOENT') {
              reject(new ClaudeCliError(`Claude Code CLI not found. Install it and run "claude login".`, 'fatal'));
            } else {
              reject(new ClaudeCliError(`Claude Code CLI spawn error: ${err?.message || err}`));
            }
          });
        });

        // Guards against an unhandled EPIPE: a large prompt plus an early
        // child exit (bad flag, crash before reading stdin) can fail the
        // write after the OS pipe buffer fills. Without this listener, an
        // 'error' event on the stdin stream throws and can crash the whole
        // gateway process — the 'close'/result-event paths above already
        // cover reporting the actual failure; this only stops the write
        // itself from becoming an uncaught exception.
        child.stdin!.on('error', (err: any) => {
          log.warn(`[claude-cli] stdin write error (likely early child exit): ${err?.message || err}`);
        });

        child.stdout.on('data', (chunk: Buffer) => {
          sawFirstByte = true;
          lastStdoutActivity = this.now();
          reader.push(chunk.toString('utf-8'));
        });

        child.stderr.on('data', (chunk: Buffer) => {
          // Deliberately does NOT feed the watchdog. Chatty stderr was
          // previously the ONLY thing keeping the (non-streaming) inactivity
          // timer alive during long generations — accidental life support
          // for a timer that was otherwise a total-duration timeout in
          // disguise. Real progress is now measured on stdout only, which
          // genuinely streams thanks to --include-partial-messages.
          stderrBuf += chunk.toString('utf-8');
        });

        // Only reached if the process exits WITHOUT us ever seeing a result
        // event (crash, auth failure before any output, killed by something
        // other than our own finish()) — the normal success/error paths
        // above already resolved/rejected and killed the child themselves.
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearInterval(watchdog);
          clearTimeout(hardCeiling);
          log.warn(
            `[claude-cli] exited (code=${code}, signal=${signal}) after ${this.now() - startedAt}ms ` +
            `without a result event. stderr="${stderrBuf.slice(0, 1500)}"`
          );
          const classified = classifyClaudeCliFailure({ stderr: stderrBuf });
          reject(new ClaudeCliError(
            `Claude Code CLI exited (code=${code}, signal=${signal}) without producing a result. ${classified.message}`,
            classified.kind,
            classified.retryAfterMs
          ));
        });

        child.stdin!.end(transcript);
      });
    } finally {
      await this.removeSystemPromptFile(systemPromptFile);
    }
  }

  // ── OpenAI-compatible (OpenAI, DeepSeek) ──
  private async completeOpenAICompatible(
    provider: AIProvider,
    request: CompletionRequest,
    vaultKey: string
  ): Promise<CompletionResponse> {
    const apiKey = await this.vault.get(vaultKey);
    const endpoint = `${provider.endpoint}/chat/completions`;

    // ── Reasoning effort handling — provider-specific ──
    let effectiveModel = provider.model;
    let reasoningEffort: 'low' | 'medium' | 'high' | null = null;

    if (request.thinking) {
      if (provider.id === 'deepseek') {
        // DeepSeek: swap to the dedicated reasoner endpoint model.
        // It accepts the same Chat Completions API but produces a reasoning_content block.
        effectiveModel = 'deepseek-reasoner';
      } else if (provider.id === 'openai') {
        // OpenAI: only the o-series (o1, o3, o4, gpt-5*) supports reasoning_effort.
        // gpt-4o silently ignores it. Send the param only when the model name suggests support.
        const isReasoningModel = /^(o[1-9]|o\d+|gpt-5|gpt-5\.\d+)/i.test(provider.model);
        if (isReasoningModel) reasoningEffort = request.thinking;
      } else if (provider.id === 'openrouter') {
        // OpenRouter: thinking support depends on the underlying model. The
        // safest approach is to pass `reasoning_effort` — OpenRouter forwards
        // it to providers that support it and silently ignores it elsewhere.
        // See https://openrouter.ai/docs/use-cases/reasoning-tokens
        reasoningEffort = request.thinking;
      }
    }

    const body: any = {
      model: effectiveModel,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages,
      ],
      max_tokens: request.maxTokens ?? provider.maxTokens,
      temperature: request.temperature ?? 0.7,
    };
    if (reasoningEffort) {
      // OpenAI reasoning models reject max_tokens (use max_completion_tokens) and ignore temperature.
      delete body.max_tokens;
      delete body.temperature;
      body.max_completion_tokens = request.maxTokens ?? provider.maxTokens;
      body.reasoning_effort = reasoningEffort;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    // OpenRouter recommends (but doesn't require) HTTP-Referer + X-Title
    // headers for ranking on their leaderboard. Since AuthorAgent is local-only,
    // we send a stable referrer string. Harmless for other providers.
    if (provider.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/Ckokoski/authoragent';
      headers['X-Title'] = 'AuthorAgent';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(
        `${provider.name} HTTP ${response.status}: ${errBody.substring(0, 400) || response.statusText}`
      );
    }

    const data = await response.json() as any;
    if (data.error) {
      log.error(`  ✗ ${provider.name} API error: ${data.error.message || JSON.stringify(data.error)}`);
      throw new Error(`${provider.name} API error: ${data.error.message || 'Unknown error'}`);
    }
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;
    const inputTokens = usage?.prompt_tokens || 0;
    const outputTokens = usage?.completion_tokens || 0;
    // OpenRouter may not always return usage; fall back to provider's pricing
    // map (which is approximate for OpenRouter — actual cost varies by model).
    return {
      text,
      tokensUsed: inputTokens + outputTokens,
      estimatedCost: (inputTokens / 1000) * provider.costPer1kInput +
                     (outputTokens / 1000) * provider.costPer1kOutput,
      provider: provider.id,
    };
  }

  getActiveProviders(): AIProvider[] {
    return Array.from(this.providers.values()).filter(p => p.available);
  }
}

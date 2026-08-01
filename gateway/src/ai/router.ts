/**
 * AuthorAgent AI Router
 * Smart routing across free and paid LLM providers
 * Optimized for writing tasks
 */

import { createHash } from 'crypto';
import { execFile } from 'node:child_process';
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
  tier: 'free' | 'cheap' | 'paid';
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
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private max: number) {}

  setMax(max: number): void {
    this.max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

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

  constructor(config: any, vault: Vault, costs: CostTracker, workspaceDir?: string) {
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

    // ── OpenAI GPT (PAID) ──
    const openaiKey = await this.vault.get('openai_api_key');
    if (openaiKey) {
      const model = this.resolveModel('openai', PROVIDER_DEFAULTS.openai.defaultModel);
      const price = this.priceFor('openai', model);
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
      if (this.config.openai?.endpoint) {
        reachable = await this.checkOpenAICompatible(endpoint);
        if (!reachable) {
          log.warn(`openai endpoint ${endpoint} not reachable at startup — marking unavailable until next reinitialize`);
        }
      }
      this.providers.set('openai', {
        id: 'openai',
        name: 'OpenAI GPT',
        model,
        tier: 'paid',
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
    let version: string;
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10_000 });
      version = stdout.trim();
      this.claudeCliVersion = version;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { available: false, reason: 'Claude Code CLI not found on PATH. Install it first.' };
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
      const { stdout } = await execFileAsync('claude', ['auth', 'status'], { timeout: 10_000 });
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
    tier: 'free' | 'cheap' | 'paid';
    knownModels: string[];
    price: { costPer1kInput: number; costPer1kOutput: number; confidence: string; lastVerified: string };
  }> {
    return Object.entries(PROVIDER_DEFAULTS).map(([id, def]) => {
      const active = this.providers.get(id);
      // Resolve the current model even when the provider isn't active (no key),
      // so the UI can still show what it WOULD use.
      const currentModel = active?.model ?? this.resolveModel(id, def.defaultModel);
      const priceRow = getLLMPrice(currentModel, {
        costPer1kInput: def.costPer1kInput,
        costPer1kOutput: def.costPer1kOutput,
      });
      return {
        id,
        available: !!active?.available,
        currentModel,
        defaultModel: def.defaultModel,
        override: this.modelConfig?.get(id) ?? null,
        tier: def.tier,
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
        // Check budget — skip non-free providers if over budget
        if (provider.tier !== 'free' && this.costs.isOverBudget()) {
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
    // Explicit preferred fallback takes priority over the generic free/paid
    // heuristic below — e.g. "openai's live call just failed, go straight to
    // claude-cli" instead of whatever happens to be first by insertion order.
    if (this.globalPreferredProviderFallback && this.globalPreferredProviderFallback !== currentId) {
      const configured = this.providers.get(this.globalPreferredProviderFallback);
      if (configured?.available) {
        return configured;
      }
    }

    const overBudget = this.costs?.isOverBudget?.() ?? false;
    // Prefer free providers first so we don't silently burn budget on fallback.
    const freeProviders: AIProvider[] = [];
    const paidProviders: AIProvider[] = [];
    for (const [id, provider] of this.providers) {
      if (id === currentId || !provider.available) continue;
      if (provider.tier === 'free') freeProviders.push(provider);
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
  //    sessions, not a pipeline firing 20-30 chapter-length calls per book.
  //    Keep maxConcurrent low (config.ai['claude-cli'].maxConcurrent) and
  //    expect throttling on long "Full Book" runs.
  //  - Single-shot only: `claude -p` isn't a multi-turn chat API, so the
  //    message history below is flattened into one prompt.
  //  - No thinking-budget passthrough — Claude Code manages its own
  //    reasoning internally; request.thinking is accepted but ignored here.
  private async completeClaudeCode(
    provider: AIProvider,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    return this.claudeCliSemaphore.run(() => this.runClaudeCliOnce(provider, request));
  }

  private async runClaudeCliOnce(
    provider: AIProvider,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    const transcript = request.messages
      .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n\n');
    const prompt = `${request.system}\n\n${transcript}`;

    // Output-heavy tasks (full chapter drafts, 20-30 chapter outlines — up to
    // TASK_OUTPUT_BUDGET's 16384 tokens) can genuinely take longer than a
    // flat 120s to stream through the CLI wrapper, especially on opus. This
    // was the actual root cause of "Claude Code CLI call timed out after
    // 120s" on otherwise-healthy accounts: not a hang, just not enough time.
    // Configurable via config.ai['claude-cli'].timeoutMs (default 300s).
    const timeoutMs = this.config?.['claude-cli']?.timeoutMs ?? 300_000;

    let stdout: string;
    try {
      // execFile (not exec/shell) — no shell interpolation. The prompt is
      // NOT passed as an argv element: AuthorAgent's system prompt (soul +
      // memory + context) routinely runs many KB, and on Windows the CLI is
      // invoked through a shim whose effective command-line length caps out
      // around 8K chars — a long prompt-as-argument blows past that and
      // fails with "spawn ENAMETOOLONG" before the process even starts.
      // Piping the prompt over stdin instead sidesteps the OS command-line
      // limit entirely (verified against a 20K-char prompt).
      const child = execFileAsync(
        'claude',
        ['-p', '--output-format', 'json', '--model', provider.model],
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }
      );
      child.child.stdin!.end(prompt);
      const result = await child;
      stdout = result.stdout;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error(`Claude Code CLI not found. Install it and run "claude login".`);
      }
      if (err?.code === 'ENAMETOOLONG') {
        throw new Error(`Claude Code CLI error: prompt too long even for stdin. This shouldn't happen — please report it.`);
      }
      if (err?.killed || err?.signal === 'SIGTERM') {
        throw new Error(`Claude Code CLI call timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      const stderr = String(err?.stderr || '').toLowerCase();
      if (stderr.includes('not logged in') || stderr.includes('authentication')) {
        throw new Error(`Claude Code CLI is not authenticated. Run "claude login" first.`);
      }
      throw new Error(`Claude Code CLI error: ${err?.stderr || err?.message || err}`);
    }

    // ── Parse, with a fallback for schema drift ──
    // Preferred path: --output-format json gives { result, usage }. Fallback:
    // if JSON.parse fails (CLI version mismatch, a stray status line before
    // the JSON blob, or a future format change), scan for the last
    // JSON-looking blob; if that also fails, fall back to raw stdout as
    // plain text rather than failing the whole call outright.
    let text: string;
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    try {
      const data = JSON.parse(stdout);
      text = data?.result ?? data?.text ?? '';
      usage = data?.usage;
      if (!text) throw new Error('parsed JSON had no result/text field');
    } catch {
      const lastBrace = stdout.lastIndexOf('{');
      if (lastBrace >= 0) {
        try {
          const data = JSON.parse(stdout.slice(lastBrace));
          text = data?.result ?? data?.text ?? '';
          usage = data?.usage;
        } catch {
          text = stdout.trim();
        }
      } else {
        text = stdout.trim();
      }

      if (!text) {
        throw new Error(
          `Claude Code CLI output didn't match the expected JSON shape and had no ` +
          `usable fallback text. CLI version: ${this.claudeCliVersion ?? 'unknown'}. ` +
          `Raw output (truncated): ${stdout.slice(0, 300)}`
        );
      }
    }

    return {
      text,
      tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      // Rides the subscription — no separate metered cost to the user, even
      // though the CLI's own JSON includes an internal total_cost_usd estimate.
      estimatedCost: 0,
      provider: provider.id, // 'claude-cli' or 'claude-cli-opus'
    };
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

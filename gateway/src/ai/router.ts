/**
 * AuthorClaw AI Router
 * Smart routing across free and paid LLM providers
 * Optimized for writing tasks
 */

import { createHash } from 'crypto';
import { Vault } from '../security/vault.js';
import { CostTracker } from '../services/costs.js';

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
// AI Router
// ═══════════════════════════════════════════════════════════

export class AIRouter {
  private providers: Map<string, AIProvider> = new Map();
  private config: any;
  private vault: Vault;
  private costs: CostTracker;
  private globalPreferredProvider: string | null = null;

  // ── Prompt Cache ──
  // Caches system prompt hashes so repeated calls with the same soul/style
  // context can signal cache hits to providers that support it (e.g. Gemini cachedContent).
  private promptCache: Map<string, { hash: string; timestamp: number }> = new Map();
  private cacheHits = 0;
  private cacheMisses = 0;
  private savedTokens = 0;

  constructor(config: any, vault: Vault, costs: CostTracker) {
    this.config = config;
    this.vault = vault;
    this.costs = costs;
  }

  async initialize(): Promise<void> {
    // Clear any stale providers (important for reinitialize)
    this.providers.clear();

    // ── Ollama (FREE - Local) ──
    if (this.config.ollama?.enabled !== false) {
      const ollamaAvailable = await this.checkOllama(
        this.config.ollama?.endpoint || 'http://localhost:11434'
      );
      if (ollamaAvailable) {
        this.providers.set('ollama', {
          id: 'ollama',
          name: 'Ollama',
          model: this.config.ollama?.model || 'llama3.2',
          tier: 'free',
          available: true,
          endpoint: this.config.ollama?.endpoint || 'http://localhost:11434',
          // Ollama caps depend on the model's context window. 8192 is safe
          // for most modern instruct models without forcing the user to
          // tune num_ctx in their Modelfile.
          maxTokens: 8192,
          costPer1kInput: 0,
          costPer1kOutput: 0,
        });
      }
    }

    // ── Google Gemini (FREE tier) ──
    const geminiKey = await this.vault.get('gemini_api_key');
    if (geminiKey) {
      this.providers.set('gemini', {
        id: 'gemini',
        name: 'Google Gemini',
        model: this.config.gemini?.model || 'gemini-2.5-flash',
        tier: 'free',
        available: true,
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        maxTokens: 65536,
        costPer1kInput: 0, // Free tier
        costPer1kOutput: 0,
      });
    }

    // ── DeepSeek (CHEAP) ──
    const deepseekKey = await this.vault.get('deepseek_api_key');
    if (deepseekKey) {
      this.providers.set('deepseek', {
        id: 'deepseek',
        name: 'DeepSeek',
        model: this.config.deepseek?.model || 'deepseek-chat',
        tier: 'cheap',
        available: true,
        endpoint: 'https://api.deepseek.com/v1',
        maxTokens: 8192, // DeepSeek-chat supports 8K output tokens
        costPer1kInput: 0.00014,
        costPer1kOutput: 0.00028,
      });
    }

    // ── Anthropic Claude (PAID) ──
    const claudeKey = await this.vault.get('anthropic_api_key');
    if (claudeKey) {
      this.providers.set('claude', {
        id: 'claude',
        name: 'Anthropic Claude',
        model: this.config.claude?.model || 'claude-sonnet-4-5-20250929',
        tier: 'paid',
        available: true,
        endpoint: 'https://api.anthropic.com/v1',
        // Claude Sonnet 4.5 supports up to 64K output tokens. 16K is enough
        // for chapter prose + reasoning budget without becoming wasteful.
        maxTokens: 16384,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      });
    }

    // ── OpenAI GPT (PAID) ──
    const openaiKey = await this.vault.get('openai_api_key');
    if (openaiKey) {
      this.providers.set('openai', {
        id: 'openai',
        name: 'OpenAI GPT',
        model: this.config.openai?.model || 'gpt-4o',
        tier: 'paid',
        available: true,
        endpoint: 'https://api.openai.com/v1',
        maxTokens: 16384, // GPT-4o + GPT-4o-mini support 16K output tokens
        costPer1kInput: 0.0025,
        costPer1kOutput: 0.01,
      });
    }

    // ── OpenRouter (FLEXIBLE — access dozens of models with one key) ──
    // Uses OpenAI-compatible API. Model selection lets users swap between
    // Claude / GPT / Gemini / Llama / Mistral / Qwen / etc. without juggling
    // separate API keys. Requested by users who want one billing surface.
    const openrouterKey = await this.vault.get('openrouter_api_key');
    if (openrouterKey) {
      this.providers.set('openrouter', {
        id: 'openrouter',
        name: 'OpenRouter',
        model: this.config.openrouter?.model || 'anthropic/claude-sonnet-4-5',
        // Tier depends on the chosen model — default to 'cheap' since users
        // typically pick OpenRouter for cost flexibility. Power users can
        // override per-project.
        tier: 'cheap',
        available: true,
        endpoint: 'https://openrouter.ai/api/v1',
        maxTokens: 16384,
        // Cost varies wildly by model. These are placeholder estimates that
        // assume Claude Sonnet pricing — actual cost is reported by the
        // OpenRouter usage endpoint. Don't budget against this number.
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      });
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
   * Select the best provider for a given task type using tiered routing.
   * Priority: per-project override → global preference → tier routing.
   * When a preferred provider is set, it is ALWAYS used if available,
   * regardless of task tier.
   */
  selectProvider(taskType: string, preferredId?: string): AIProvider {
    // Resolve effective preference: per-project > global
    const effectivePref = preferredId || this.globalPreferredProvider;

    if (effectivePref) {
      const pref = this.providers.get(effectivePref);
      if (pref?.available) {
        return pref;
      }
      // For Ollama, re-check availability in case it came online after startup
      if (effectivePref === 'ollama' && !pref) {
        console.warn(`[router] Ollama preferred but not in provider list — will be checked on next reinitialize`);
      } else {
        console.warn(`[router] Preferred provider '${effectivePref}' not available, falling back to tier routing`);
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
   * Get fallback provider if primary fails.
   * Respects the budget cap — skips paid providers when the user is over budget,
   * preferring free providers (Ollama, Gemini free tier) instead.
   */
  getFallbackProvider(currentId: string): AIProvider | null {
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
      console.error(`  ✗ Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
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
      console.error(`  ✗ Claude API error: ${data.error.message || JSON.stringify(data.error)}`);
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
    // headers for ranking on their leaderboard. Since AuthorClaw is local-only,
    // we send a stable referrer string. Harmless for other providers.
    if (provider.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/Ckokoski/authorclaw';
      headers['X-Title'] = 'AuthorClaw';
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
      console.error(`  ✗ ${provider.name} API error: ${data.error.message || JSON.stringify(data.error)}`);
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

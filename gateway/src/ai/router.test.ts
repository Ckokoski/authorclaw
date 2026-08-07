import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'node:events';
import {
  AIRouter,
  getRecommendedThinking,
  getOutputBudget,
  buildClaudeCliArgs,
  buildClaudeCliEnv,
  classifyClaudeCliFailure,
  parseClaudeCliResultEvent,
  createNdjsonLineReader,
  computeFirstTokenBudgetMs,
  deriveLengthDirective,
  mapThinkingToMaxThinkingTokens,
  isSafeClaudeCliModel,
  ClaudeCliError,
} from './router.js';
import { Vault } from '../security/vault.js';
import { CostTracker } from '../services/costs.js';

// ── Pure helper functions ──

describe('getRecommendedThinking', () => {
  it('returns "high" for consistency and final_edit', () => {
    expect(getRecommendedThinking('consistency')).toBe('high');
    expect(getRecommendedThinking('final_edit')).toBe('high');
  });

  it('returns "medium" for revision', () => {
    expect(getRecommendedThinking('revision')).toBe('medium');
  });

  it('returns undefined for task types with no configured reasoning effort', () => {
    expect(getRecommendedThinking('creative_writing')).toBeUndefined();
    expect(getRecommendedThinking('outline')).toBeUndefined();
    expect(getRecommendedThinking('book_bible')).toBeUndefined();
    expect(getRecommendedThinking('unknown_task')).toBeUndefined();
  });
});

describe('getOutputBudget', () => {
  it('returns the configured budget for known task types', () => {
    expect(getOutputBudget('outline')).toBe(16384);
    expect(getOutputBudget('book_bible')).toBe(12288);
    expect(getOutputBudget('creative_writing')).toBe(16384);
    expect(getOutputBudget('revision')).toBe(16384);
    expect(getOutputBudget('consistency')).toBe(8192);
    expect(getOutputBudget('final_edit')).toBe(8192);
    expect(getOutputBudget('research')).toBe(8192);
    expect(getOutputBudget('general')).toBe(4096);
  });

  it('falls back to 4096 for an unrecognized task type', () => {
    expect(getOutputBudget('some_made_up_task')).toBe(4096);
  });
});

// ── AIRouter provider selection / tiering ──
//
// initialize() calls vault.get() for each provider's API key and pings
// Ollama over HTTP. We stub Vault.get and global fetch so no real network
// or filesystem I/O related to a live vault occurs, per file-ownership
// constraints (only touching a tmp vault dir here, never the real one).

describe('AIRouter provider selection and tiering (mocked vault/network)', () => {
  let vaultDir: string;
  let vault: Vault;
  let costs: CostTracker;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'authoragent-router-test-'));
    process.env.AUTHORCLAW_VAULT_KEY = 'test-router-key';
    vault = new Vault(vaultDir);
    await vault.initialize();
    costs = new CostTracker({ dailyLimit: 5, monthlyLimit: 50 });
    // Ollama check does a real fetch — force it to "unavailable" (offline) by
    // default so provider tests are deterministic regardless of the host
    // machine's local Ollama state.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.AUTHORCLAW_VAULT_KEY;
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('throws when no providers are configured/available', async () => {
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(() => router.selectProvider('general')).toThrow('No AI providers available');
  });

  it('registers a provider once its vault key is set, and selects it for a free-tier task', async () => {
    await vault.set('gemini_api_key', 'fake-gemini-key');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const provider = router.selectProvider('general'); // 'general' tier = 'free'; gemini is first in TIER_ROUTING.free
    expect(provider.id).toBe('gemini');
  });

  it('follows tier routing order: free tier prefers gemini over deepseek when both available', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('deepseek_api_key', 'k2');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('general').id).toBe('gemini');
  });

  it('falls through tier routing to the next available provider when the first is missing', async () => {
    await vault.set('deepseek_api_key', 'k2'); // no gemini key
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    // free tier order: gemini, ollama, deepseek, openrouter, openai, claude
    expect(router.selectProvider('general').id).toBe('deepseek');
  });

  it('premium tier prefers claude over other paid providers', async () => {
    await vault.set('claude_api_key', 'unused'); // wrong key name, sanity check it's ignored
    await vault.set('anthropic_api_key', 'k-claude');
    await vault.set('openai_api_key', 'k-openai');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('final_edit').id).toBe('claude'); // final_edit tier = 'premium'
  });

  it('mid tier falls through to claude when gemini/deepseek are unavailable', async () => {
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('creative_writing').id).toBe('claude'); // mid tier, only claude available
  });

  it('mid tier prefers gemini over deepseek and claude when all three are available', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('deepseek_api_key', 'k2');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.selectProvider('creative_writing').id).toBe('gemini');
  });

  it('an explicit preferred provider overrides tier routing when available', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    // 'general' would normally route to gemini, but explicit pref forces claude.
    expect(router.selectProvider('general', 'claude').id).toBe('claude');
  });

  it('falls back to tier routing with a warning when the preferred provider is unavailable', async () => {
    await vault.set('gemini_api_key', 'k1');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = router.selectProvider('general', 'claude'); // claude not configured
    expect(provider.id).toBe('gemini');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('global preferred provider is used across tiers once set', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    router.setGlobalPreferredProvider('claude');
    expect(router.getGlobalPreferredProvider()).toBe('claude');
    expect(router.selectProvider('general').id).toBe('claude');
    expect(router.selectProvider('final_edit').id).toBe('claude');
  });

  it('per-project preferred provider takes priority over the global preference', async () => {
    await vault.set('gemini_api_key', 'k1');
    await vault.set('anthropic_api_key', 'k-claude');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    router.setGlobalPreferredProvider('claude');
    expect(router.selectProvider('general', 'gemini').id).toBe('gemini');
  });

  it('setGlobalPreferredProvider(null) clears the global preference', async () => {
    await vault.set('gemini_api_key', 'k1');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    router.setGlobalPreferredProvider('gemini');
    router.setGlobalPreferredProvider(null);
    expect(router.getGlobalPreferredProvider()).toBeNull();
  });

  it('skips non-free providers when over budget, keeping free providers usable', async () => {
    await vault.set('anthropic_api_key', 'k-claude'); // paid only
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const overBudgetCosts = new CostTracker({ dailyLimit: 0, monthlyLimit: 0 });
    overBudgetCosts.record('claude', 1000, 1); // push over the $0 daily limit
    (router as any).costs = overBudgetCosts;
    // 'general' tier routing has no free provider available here (only claude, paid) -> absolute fallback path
    // still returns claude since it's the only provider registered at all, ignoring budget in the final fallback.
    expect(router.selectProvider('general').id).toBe('claude');
  });

  it('getActiveProviders only returns providers marked available', async () => {
    await vault.set('gemini_api_key', 'k1');
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    const active = router.getActiveProviders();
    expect(active.map(p => p.id)).toEqual(['gemini']);
  });

  it('reinitialize() re-scans the vault and picks up newly stored keys', async () => {
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    expect(router.getActiveProviders()).toHaveLength(0);

    await vault.set('openai_api_key', 'new-key');
    const activeIds = await router.reinitialize();
    expect(activeIds).toContain('openai');
  });

  describe('getFallbackProvider', () => {
    it('prefers a free provider over a paid one, excluding the current provider', async () => {
      await vault.set('gemini_api_key', 'k1'); // free
      await vault.set('anthropic_api_key', 'k-claude'); // paid
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      const fallback = router.getFallbackProvider('claude');
      expect(fallback?.id).toBe('gemini');
    });

    it('returns a paid provider when no free provider is available and not over budget', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      await vault.set('openai_api_key', 'k-openai');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      const fallback = router.getFallbackProvider('claude');
      expect(fallback?.id).toBe('openai');
    });

    it('returns null when over budget and no free provider exists', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      await vault.set('openai_api_key', 'k-openai');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      const overBudgetCosts = new CostTracker({ dailyLimit: 0, monthlyLimit: 0 });
      overBudgetCosts.record('claude', 1000, 1);
      (router as any).costs = overBudgetCosts;
      const fallback = router.getFallbackProvider('claude');
      expect(fallback).toBeNull();
    });

    it('returns null when there is no other provider at all', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      expect(router.getFallbackProvider('claude')).toBeNull();
    });
  });

  describe('OpenAI-compatible local endpoint (LM Studio / vLLM / llama.cpp) — FREE, NO KEY', () => {
    it('registers the openai provider at $0 cost / tier "local" when a local endpoint is configured but no API key is saved', async () => {
      (global.fetch as any).mockImplementation((url: string) =>
        url.includes('/models')
          ? Promise.resolve({ ok: true })
          : Promise.reject(new Error('no network in tests'))
      );
      const router = new AIRouter(
        { ollama: { enabled: false }, openai: { endpoint: 'http://100.122.206.123:1234/v1' } },
        vault, costs,
      );
      await router.initialize();
      const openai = router.getActiveProviders().find(p => p.id === 'openai');
      expect(openai).toBeDefined();
      expect(openai!.tier).toBe('local');
      expect(openai!.costPer1kInput).toBe(0);
      expect(openai!.costPer1kOutput).toBe(0);
      expect(openai!.available).toBe(true);
    });

    it('getProviderModelInfo also reports $0/"local" for the openai slot with no key saved', async () => {
      (global.fetch as any).mockImplementation((url: string) =>
        url.includes('/models')
          ? Promise.resolve({ ok: true })
          : Promise.reject(new Error('no network in tests'))
      );
      const router = new AIRouter(
        { ollama: { enabled: false }, openai: { endpoint: 'http://100.122.206.123:1234/v1' } },
        vault, costs,
      );
      await router.initialize();
      const info = router.getProviderModelInfo().find(p => p.id === 'openai')!;
      expect(info.tier).toBe('local');
      expect(info.price.costPer1kInput).toBe(0);
      expect(info.price.costPer1kOutput).toBe(0);
    });

    it('is selectable as a routing candidate with no OpenAI key saved (free-tier routing)', async () => {
      (global.fetch as any).mockImplementation((url: string) =>
        url.includes('/models')
          ? Promise.resolve({ ok: true })
          : Promise.reject(new Error('no network in tests'))
      );
      const router = new AIRouter(
        { ollama: { enabled: false }, openai: { endpoint: 'http://100.122.206.123:1234/v1' } },
        vault, costs,
      );
      await router.initialize();
      // 'general' tier = 'free'; local-tier openai is the only provider registered.
      expect(router.selectProvider('general').id).toBe('openai');
    });
  });

  describe('model resolution precedence (override > config > default)', () => {
    let workspaceDir: string;

    beforeEach(async () => {
      workspaceDir = await mkdtemp(join(tmpdir(), 'authoragent-modelcfg-test-'));
    });

    afterEach(async () => {
      await rm(workspaceDir, { recursive: true, force: true });
    });

    it('uses the hardcoded default when no config and no override are set', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-flash');
    });

    it('uses config.<provider>.model over the hardcoded default', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter(
        { ollama: { enabled: false }, gemini: { model: 'gemini-2.5-pro' } },
        vault, costs, workspaceDir,
      );
      await router.initialize();
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-pro');
    });

    it('override from model-config.json wins over both config and default, without restart', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter(
        { ollama: { enabled: false }, gemini: { model: 'gemini-2.5-pro' } },
        vault, costs, workspaceDir,
      );
      await router.initialize();
      // Override to a custom model; setProviderModel persists + reinitializes.
      await router.setProviderModel('gemini', 'gemini-experimental-x');
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-experimental-x');
    });

    it('persists the override to disk (survives a fresh router load)', async () => {
      await vault.set('gemini_api_key', 'k1');
      const r1 = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await r1.initialize();
      await r1.setProviderModel('gemini', 'gemini-2.5-pro');

      // New router pointed at the same workspace loads the persisted override.
      const r2 = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await r2.initialize();
      expect(r2.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-pro');
    });

    it('clearing the override (empty string) reverts to config/default', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter(
        { ollama: { enabled: false }, gemini: { model: 'gemini-2.5-pro' } },
        vault, costs, workspaceDir,
      );
      await router.initialize();
      await router.setProviderModel('gemini', 'gemini-experimental-x');
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-experimental-x');
      await router.setProviderModel('gemini', '');
      expect(router.getActiveProviders().find(p => p.id === 'gemini')!.model).toBe('gemini-2.5-pro');
    });

    it('setProviderModel throws for an unknown provider', async () => {
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      await expect(router.setProviderModel('not-a-provider', 'x')).rejects.toThrow('Unknown provider');
    });

    it('cost math is UNCHANGED for the default models (model-aware pricing preserves today\'s numbers)', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      await vault.set('openai_api_key', 'k-openai');
      await vault.set('deepseek_api_key', 'k-deepseek');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      const active = router.getActiveProviders();
      const claude = active.find(p => p.id === 'claude')!;
      const openai = active.find(p => p.id === 'openai')!;
      const deepseek = active.find(p => p.id === 'deepseek')!;
      expect(claude.costPer1kInput).toBe(0.003);
      expect(claude.costPer1kOutput).toBe(0.015);
      expect(openai.costPer1kInput).toBe(0.0025);
      expect(openai.costPer1kOutput).toBe(0.01);
      expect(deepseek.costPer1kInput).toBe(0.00014);
      expect(deepseek.costPer1kOutput).toBe(0.00028);
    });

    it('switching a provider model updates its cost math (model-aware pricing)', async () => {
      await vault.set('anthropic_api_key', 'k-claude');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      // Default claude = sonnet 4.5 = 0.003/0.015
      expect(router.getActiveProviders().find(p => p.id === 'claude')!.costPer1kInput).toBe(0.003);
      // Switch to Fable 5 = 0.010/0.050 (rough), cost math follows the model.
      await router.setProviderModel('claude', 'claude-fable-5');
      const claude = router.getActiveProviders().find(p => p.id === 'claude')!;
      expect(claude.model).toBe('claude-fable-5');
      expect(claude.costPer1kInput).toBe(0.010);
      expect(claude.costPer1kOutput).toBe(0.050);
    });

    it('getProviderModelInfo reports currentModel, defaultModel, knownModels, and price', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs, workspaceDir);
      await router.initialize();
      const info = router.getProviderModelInfo();
      const gemini = info.find(p => p.id === 'gemini')!;
      expect(gemini.available).toBe(true);
      expect(gemini.currentModel).toBe('gemini-2.5-flash');
      expect(gemini.defaultModel).toBe('gemini-2.5-flash');
      expect(gemini.knownModels).toContain('gemini-2.5-pro');
      expect(gemini.price.costPer1kInput).toBe(0);
      // Providers without a key still appear, with available=false and the resolved default model.
      const claude = info.find(p => p.id === 'claude')!;
      expect(claude.available).toBe(false);
      expect(claude.currentModel).toBe('claude-sonnet-4-5-20250929');
      expect(claude.knownModels).toContain('claude-fable-5');
    });
  });

  describe('complete() dispatch (smoke test)', () => {
    // TODO: deeper coverage — complete() has one HTTP-calling method per
    // provider (completeOllama/completeGemini/completeClaude/
    // completeOpenAICompatible) each with its own response parsing, error
    // handling, and reasoning-effort request shaping. Fully exercising those
    // would mean mocking fetch responses per-provider-shape; only the
    // top-level dispatch/error path is smoke-tested here since that's pure
    // routing logic, not network-format detail.
    it('throws for a provider id that was never registered', async () => {
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      await expect(router.complete({
        provider: 'claude',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Provider claude not found');
    });

    it('caches system-prompt hashes across calls to the same provider (cache stats increment)', async () => {
      await vault.set('gemini_api_key', 'k1');
      const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
      await router.initialize();
      // completeGemini will attempt a real fetch; global fetch is stubbed to
      // reject, so the call itself throws, but cache bookkeeping happens
      // before the provider-specific branch runs.
      await expect(router.complete({
        provider: 'gemini',
        system: 'same system prompt',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow();
      const stats1 = router.getCacheStats();
      expect(stats1.misses).toBe(1);
      expect(stats1.hits).toBe(0);

      await expect(router.complete({
        provider: 'gemini',
        system: 'same system prompt',
        messages: [{ role: 'user', content: 'hi again' }],
      })).rejects.toThrow();
      const stats2 = router.getCacheStats();
      expect(stats2.hits).toBe(1);
      expect(stats2.savedTokens).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// claude-cli hardening — pure functions
// ═══════════════════════════════════════════════════════════
//
// This provider had ZERO test coverage despite being the live default in
// production, and the specific failure that motivated this rewrite
// (stream-json not actually streaming without --include-partial-messages,
// making the "inactivity" watchdog a total-duration timeout in disguise)
// shipped without any test catching it. These cover the extracted pure
// logic directly; the streaming/timeout state machine itself is covered
// further below via dependency-injected spawn.

describe('buildClaudeCliArgs', () => {
  it('builds the exact hardened, non-agentic argv', () => {
    const args = buildClaudeCliArgs({ model: 'sonnet', systemPromptFile: '/tmp/sp.txt' });
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', 'sonnet',
      '--system-prompt-file', '/tmp/sp.txt',
      '--tools', '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--max-turns', '1',
    ]);
  });

  it('never includes --bare or --dangerously-skip-permissions (would break OAuth / silently widen tool access)', () => {
    const args = buildClaudeCliArgs({ model: 'opus', systemPromptFile: '/tmp/sp.txt', maxTurns: 12 });
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--system-prompt'); // the (different) non-file flag
  });

  it('--tools is never the last argv element (it is variadic and would swallow whatever follows)', () => {
    const args = buildClaudeCliArgs({ model: 'sonnet', systemPromptFile: '/tmp/sp.txt' });
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeLessThan(args.length - 2); // '' plus at least one more flag after it
  });

  it('includes --max-thinking-tokens only when a thinking budget is given', () => {
    const withThinking = buildClaudeCliArgs({ model: 'sonnet', systemPromptFile: '/tmp/sp.txt', maxThinkingTokens: 4096 });
    expect(withThinking).toContain('--max-thinking-tokens');
    expect(withThinking[withThinking.indexOf('--max-thinking-tokens') + 1]).toBe('4096');

    const without = buildClaudeCliArgs({ model: 'sonnet', systemPromptFile: '/tmp/sp.txt' });
    expect(without).not.toContain('--max-thinking-tokens');
  });

  it('respects a custom maxTurns', () => {
    const args = buildClaudeCliArgs({ model: 'sonnet', systemPromptFile: '/tmp/sp.txt', maxTurns: 3 });
    expect(args[args.indexOf('--max-turns') + 1]).toBe('3');
  });
});

describe('buildClaudeCliEnv', () => {
  it('strips credential-shaped vars so the child can never silently switch to metered API billing', () => {
    const env = buildClaudeCliEnv({
      ANTHROPIC_API_KEY: 'sk-should-not-leak',
      ANTHROPIC_BASE_URL: 'https://evil.example.com',
      GEMINI_API_KEY: 'g-key',
      OPENAI_API_KEY: 'o-key',
      AUTHORCLAW_VAULT_KEY: 'vault-secret',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PATH: 'C:\\Windows\\System32',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AUTHORCLAW_VAULT_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('keeps the vars OAuth/process startup depends on (regression guard: never break login)', () => {
    const env = buildClaudeCliEnv({
      USERPROFILE: 'C:\\Users\\test',
      HOME: '/home/test',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      PATH: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
    });
    expect(env.USERPROFILE).toBe('C:\\Users\\test');
    expect(env.HOME).toBe('/home/test');
    expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\test\\AppData\\Local');
    expect(env.PATH).toBe('C:\\Windows\\System32');
    expect(env.TEMP).toBe('C:\\Temp');
  });

  it('omits anything not on the explicit allowlist, even if harmless-looking', () => {
    const env = buildClaudeCliEnv({ RANDOM_UNRELATED_VAR: 'x', PATH: 'y' });
    expect(env.RANDOM_UNRELATED_VAR).toBeUndefined();
    expect(env.PATH).toBe('y');
  });
});

describe('isSafeClaudeCliModel', () => {
  it('accepts normal model slugs/aliases', () => {
    expect(isSafeClaudeCliModel('sonnet')).toBe(true);
    expect(isSafeClaudeCliModel('claude-sonnet-4-5-20250929')).toBe(true);
    expect(isSafeClaudeCliModel('opus')).toBe(true);
  });

  it('rejects a model value containing shell/argv-hostile characters', () => {
    expect(isSafeClaudeCliModel('sonnet && calc')).toBe(false);
    expect(isSafeClaudeCliModel('sonnet; rm -rf /')).toBe(false);
    expect(isSafeClaudeCliModel('sonnet\n--dangerously-skip-permissions')).toBe(false);
    expect(isSafeClaudeCliModel('')).toBe(false);
  });
});

describe('classifyClaudeCliFailure', () => {
  it('classifies auth failures and always returns the logout/login remedy', () => {
    const r = classifyClaudeCliFailure({ resultText: 'API Error: 401 OAuth access token has expired.' });
    expect(r.kind).toBe('auth');
    expect(r.message).toContain('claude logout && claude login');
  });

  it('classifies quota/rate-limit failures and parses a reset deadline when present', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = classifyClaudeCliFailure({ resultText: `Usage limit reached. Resets at ${future}.` });
    expect(r.kind).toBe('quota');
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('defaults quota retryAfterMs to 15 minutes when no deadline is parseable', () => {
    const r = classifyClaudeCliFailure({ stderr: 'rate limit exceeded' });
    expect(r.kind).toBe('quota');
    expect(r.retryAfterMs).toBe(15 * 60_000);
  });

  it('classifies error_max_turns as fatal (should be impossible with --tools "" — a red flag if it recurs)', () => {
    const r = classifyClaudeCliFailure({ resultText: 'error_max_turns' });
    expect(r.kind).toBe('fatal');
  });

  it('falls back to transient for anything unrecognized', () => {
    const r = classifyClaudeCliFailure({ resultText: 'some unexpected network blip' });
    expect(r.kind).toBe('transient');
  });

  it('checks both resultText and stderr, not just one', () => {
    const r = classifyClaudeCliFailure({ resultText: 'Command failed', stderr: 'not logged in' });
    expect(r.kind).toBe('auth');
  });
});

describe('parseClaudeCliResultEvent', () => {
  it('parses a successful result event', () => {
    const r = parseClaudeCliResultEvent({ type: 'result', is_error: false, result: 'hello', usage: { input_tokens: 10, output_tokens: 5 } });
    expect(r).toEqual({ ok: true, text: 'hello', tokensUsed: 15 });
  });

  it('falls back to subtype when is_error is true and result text is empty', () => {
    const r = parseClaudeCliResultEvent({ type: 'result', is_error: true, result: '', subtype: 'error_max_turns' });
    expect(r).toEqual({ ok: false, error: 'error_max_turns' });
  });

  it('treats an empty, non-error result as a failure (never silently resolve with nothing)', () => {
    const r = parseClaudeCliResultEvent({ type: 'result', is_error: false, result: '' });
    expect(r.ok).toBe(false);
  });

  it('defaults tokensUsed to 0 when usage is missing entirely', () => {
    const r = parseClaudeCliResultEvent({ type: 'result', is_error: false, result: 'x' });
    expect(r).toEqual({ ok: true, text: 'x', tokensUsed: 0 });
  });
});

describe('createNdjsonLineReader', () => {
  it('emits each complete line and buffers a partial trailing line until it completes', () => {
    const lines: string[] = [];
    const reader = createNdjsonLineReader(l => lines.push(l));
    reader.push('{"a":1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    reader.push(':3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('skips blank lines', () => {
    const lines: string[] = [];
    const reader = createNdjsonLineReader(l => lines.push(l));
    reader.push('{"a":1}\n\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles a single result event arriving split across two chunks at an arbitrary byte offset', () => {
    const lines: string[] = [];
    const reader = createNdjsonLineReader(l => lines.push(l));
    const full = '{"type":"result","result":"hello world"}\n';
    reader.push(full.slice(0, 20));
    reader.push(full.slice(20));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).result).toBe('hello world');
  });
});

describe('computeFirstTokenBudgetMs', () => {
  it('returns exactly the base budget floor for a zero-length prompt', () => {
    expect(computeFirstTokenBudgetMs(0, 120_000, 420_000)).toBe(120_000);
  });

  it('adds a small, proportionate amount for a small prompt (never drops below the base)', () => {
    const result = computeFirstTokenBudgetMs(100, 120_000, 420_000);
    expect(result).toBeGreaterThanOrEqual(120_000);
    expect(result).toBeLessThan(120_100); // 100 chars * 0.3ms/char is negligible
  });

  it('scales up for a large prompt, clamped to the ceiling', () => {
    // 600,000 chars * 0.3ms/char = 180,000ms added to a 120,000ms base -> 300,000ms, under the 420,000ms ceiling.
    expect(computeFirstTokenBudgetMs(600_000, 120_000, 420_000)).toBe(300_000);
  });

  it('clamps at the ceiling for an extremely large prompt', () => {
    expect(computeFirstTokenBudgetMs(5_000_000, 120_000, 420_000)).toBe(420_000);
  });
});

describe('deriveLengthDirective', () => {
  it('returns nothing for small/default output budgets (the CLI applies no cap, so padding a short task would be pure noise)', () => {
    expect(deriveLengthDirective(undefined)).toBe('');
    expect(deriveLengthDirective(4096)).toBe('');
  });

  it('appends a word-count directive for genuinely long-output tasks', () => {
    const directive = deriveLengthDirective(16384);
    expect(directive).toContain('substantial response');
    expect(directive).toContain(String(Math.round(16384 * 0.75)));
  });
});

describe('mapThinkingToMaxThinkingTokens', () => {
  it('maps each level to its token budget', () => {
    expect(mapThinkingToMaxThinkingTokens('low')).toBe(1024);
    expect(mapThinkingToMaxThinkingTokens('medium')).toBe(4096);
    expect(mapThinkingToMaxThinkingTokens('high')).toBe(16384);
  });

  it('returns undefined when no thinking level is requested', () => {
    expect(mapThinkingToMaxThinkingTokens(undefined)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// claude-cli hardening — streaming/timeout behavior via injected spawn
// ═══════════════════════════════════════════════════════════
//
// Drives the actual private runClaudeCliOnce logic with a fake child
// process (no real subprocess), so the result-event parsing, error
// classification, and the #25629 no-natural-exit workaround are covered
// without needing the real CLI installed/authenticated in CI.

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = vi.fn();
  child.killed = false;
  child.exitCode = null;
  // Deliberately no .pid — keeps killClaudeCliProcess on the safe,
  // assertable child.kill() path in tests instead of shelling out to a
  // real `taskkill` against a made-up PID (which risks a same-run-time
  // collision with an unrelated real process on the test machine).
  child.kill = vi.fn(() => { child.killed = true; });
  return child;
}

const FAKE_PROVIDER = {
  id: 'claude-cli',
  name: 'Claude Code (subscription)',
  model: 'sonnet',
  tier: 'free' as const,
  available: true,
  endpoint: 'local-cli',
  maxTokens: 16384,
  costPer1kInput: 0,
  costPer1kOutput: 0,
};

describe('runClaudeCliOnce (streaming behavior, fake spawn)', () => {
  let vaultDir: string;
  let vault: Vault;
  let costs: CostTracker;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'authoragent-claudecli-test-'));
    process.env.AUTHORCLAW_VAULT_KEY = 'test-router-key';
    vault = new Vault(vaultDir);
    await vault.initialize();
    costs = new CostTracker({ dailyLimit: 5, monthlyLimit: 50 });
  });

  afterEach(async () => {
    delete process.env.AUTHORCLAW_VAULT_KEY;
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('resolves with the parsed text/tokens on a successful result event, and kills the child', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, _args: string[], _opts?: any) => child);
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const promise = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER,
      { provider: 'claude-cli', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      Date.now()
    );
    await vi.waitFor(() => expect(fakeSpawn).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', is_error: false, result: 'hello', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n'
    ));

    const result = await promise;
    expect(result).toEqual({ text: 'hello', tokensUsed: 15, estimatedCost: 0, provider: 'claude-cli' });
    expect(child.kill).toHaveBeenCalled();
  });

  it('rejects with a classified ClaudeCliError on an is_error result event', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, _args: string[], _opts?: any) => child);
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const promise = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER,
      { provider: 'claude-cli', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      Date.now()
    );
    await vi.waitFor(() => expect(fakeSpawn).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', is_error: true, result: '', subtype: 'error_max_turns' }) + '\n'
    ));

    await expect(promise).rejects.toThrow(ClaudeCliError);
    await expect(promise).rejects.toMatchObject({ kind: 'fatal' });
  });

  it('rejects when the child exits without ever producing a result event, classified from stderr', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, _args: string[], _opts?: any) => child);
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const promise = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER,
      { provider: 'claude-cli', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      Date.now()
    );
    await vi.waitFor(() => expect(fakeSpawn).toHaveBeenCalled());

    child.stderr.emit('data', Buffer.from('Failed to authenticate. OAuth access token has expired.'));
    child.emit('close', 1, null);

    await expect(promise).rejects.toMatchObject({ kind: 'auth' });
  });

  it('rejects with a clear message when the binary is not found (ENOENT)', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, _args: string[], _opts?: any) => child);
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const promise = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER,
      { provider: 'claude-cli', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      Date.now()
    );
    await vi.waitFor(() => expect(fakeSpawn).toHaveBeenCalled());

    child.emit('error', { code: 'ENOENT' });

    await expect(promise).rejects.toThrow(/not found/i);
  });

  it('refuses to spawn with a suspicious model value instead of passing it through to argv', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, _args: string[], _opts?: any) => child);
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const badProvider = { ...FAKE_PROVIDER, model: 'sonnet && calc' };
    await expect(
      (router as any).runClaudeCliOnce(
        badProvider,
        { provider: 'claude-cli', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
        Date.now()
      )
    ).rejects.toThrow(/suspicious model/i);
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('writes the system prompt to a temp file referenced in argv, and removes it after the call settles', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, _args: string[], _opts?: any) => child);
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const promise = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER,
      { provider: 'claude-cli', system: 'you are a test', messages: [{ role: 'user', content: 'hi' }] },
      Date.now()
    );
    await vi.waitFor(() => expect(fakeSpawn).toHaveBeenCalled());

    const args: string[] = fakeSpawn.mock.calls[0][1];
    const filePath = args[args.indexOf('--system-prompt-file') + 1];
    expect(filePath).toMatch(/authoragent-claude-cli/);
    const { readFile, access } = await import('node:fs/promises');
    await expect(readFile(filePath, 'utf8')).resolves.toBe('you are a test');

    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\n'));
    await promise;

    await expect(access(filePath)).rejects.toThrow(); // cleaned up
  });

  it('two concurrent calls get distinct temp files, both cleaned up', async () => {
    // writeSystemPromptFile does a real fs write before spawning, so which of
    // the two calls reaches spawnFn first is a genuine (and irrelevant) race —
    // fake timers don't control real I/O. Route each fake child by reading
    // back which system prompt its temp file actually holds, rather than
    // assuming spawn call order matches invocation order.
    // spawnFn must return synchronously (real child_process.spawn does), and
    // the prompt file is already fully written by the time spawnFn runs
    // (writeSystemPromptFile is awaited beforehand), so a sync read is safe.
    const { readFileSync } = await import('node:fs');
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    const fakeSpawn = vi.fn((_bin: string, args: string[], _opts?: any) => {
      const filePath = args[args.indexOf('--system-prompt-file') + 1];
      const content = readFileSync(filePath, 'utf8');
      return content.includes('sys A') ? childA : childB;
    });
    const router = new AIRouter({ 'claude-cli': { enabled: false } }, vault, costs, undefined, { spawn: fakeSpawn as any });

    const p1 = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER, { provider: 'claude-cli', system: 'sys A', messages: [{ role: 'user', content: 'hi' }] }, Date.now()
    );
    const p2 = (router as any).runClaudeCliOnce(
      FAKE_PROVIDER, { provider: 'claude-cli', system: 'sys B', messages: [{ role: 'user', content: 'hi' }] }, Date.now()
    );
    await vi.waitFor(() => expect(fakeSpawn).toHaveBeenCalledTimes(2));

    const files = fakeSpawn.mock.calls.map(([, args]) => args[args.indexOf('--system-prompt-file') + 1]);
    const [file1, file2] = files;
    expect(file1).not.toBe(file2);

    childA.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'A' }) + '\n'));
    childB.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'B' }) + '\n'));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toBe('A');
    expect(r2.text).toBe('B');

    const { access } = await import('node:fs/promises');
    await expect(access(file1)).rejects.toThrow();
    await expect(access(file2)).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// getFallbackProvider — same-transport fix
// ═══════════════════════════════════════════════════════════
//
// claude-cli and claude-cli-opus share one binary/token/rate-limiter.
// Production logs showed a claude-cli auth failure immediately followed by
// the identical failure on claude-cli-opus — the "fallback" was a retry of
// the same broken transport. These insert synthetic provider entries
// directly (bypassing the real CLI probe in initialize()) for a fast,
// deterministic unit test.

describe('getFallbackProvider (claude-cli same-transport fix)', () => {
  let vaultDir: string;
  let vault: Vault;
  let costs: CostTracker;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'authoragent-fallback-test-'));
    process.env.AUTHORCLAW_VAULT_KEY = 'test-router-key';
    vault = new Vault(vaultDir);
    await vault.initialize();
    costs = new CostTracker({ dailyLimit: 5, monthlyLimit: 50 });
  });

  afterEach(async () => {
    delete process.env.AUTHORCLAW_VAULT_KEY;
    await rm(vaultDir, { recursive: true, force: true });
  });

  function registerFakeClaudeCli(router: AIRouter) {
    const providers = (router as any).providers as Map<string, any>;
    providers.set('claude-cli', { ...FAKE_PROVIDER });
    providers.set('claude-cli-opus', { ...FAKE_PROVIDER, id: 'claude-cli-opus', model: 'opus' });
  }

  it('never returns claude-cli-opus as the fallback for a failed claude-cli call', async () => {
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    registerFakeClaudeCli(router);
    expect(router.getFallbackProvider('claude-cli')).toBeNull();
  });

  it('never returns claude-cli as the fallback for a failed claude-cli-opus call', async () => {
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    registerFakeClaudeCli(router);
    expect(router.getFallbackProvider('claude-cli-opus')).toBeNull();
  });

  it('falls through to a genuinely different provider when one is available', async () => {
    await vault.set('gemini_api_key', 'k1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    registerFakeClaudeCli(router);
    expect(router.getFallbackProvider('claude-cli')?.id).toBe('gemini');
    vi.unstubAllGlobals();
  });

  it('an explicit preferredProviderFallback pointing at the same transport is ignored', async () => {
    await vault.set('gemini_api_key', 'k1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));
    const router = new AIRouter({ ollama: { enabled: false } }, vault, costs);
    await router.initialize();
    registerFakeClaudeCli(router);
    router.setGlobalPreferredProviderFallback('claude-cli-opus'); // same transport as claude-cli
    // Falls through to the free/paid heuristic instead of the (same-transport) configured fallback.
    expect(router.getFallbackProvider('claude-cli')?.id).toBe('gemini');
    vi.unstubAllGlobals();
  });
});

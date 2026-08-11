/**
 * system routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { validateKeyFormat, hasProviderKeyName, isVoiceProfileTemplate } from '../context.js';

export function registerSystemRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ── Health Check ──
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '4.0.0',
      name: 'AuthorAgent',
      brand: 'Writing Secrets',
      uptime: process.uptime(),
      links: {
        website: 'https://www.getwritingsecrets.com',
        kofi: 'https://ko-fi.com/s/4e24f1dfa5',
        youtube: 'https://www.youtube.com/@WritingSecrets',
      },
    });
  });

  // ── Liveness Probe (Kubernetes / Docker HEALTHCHECK) ──
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'alive' });
  });

  // ── Readiness Probe ──
  app.get('/readyz', (_req: Request, res: Response) => {
    try {
      const providers = services.aiRouter.getActiveProviders();
      const count = Array.isArray(providers) ? providers.length : 0;
      if (count > 0) {
        res.json({ status: 'ready', providers: count });
      } else {
        res.status(503).json({ status: 'not_ready', reason: 'no active AI providers' });
      }
    } catch (err: any) {
      res.status(503).json({ status: 'not_ready', reason: err?.message || 'provider check failed' });
    }
  });

  // ── Status Dashboard ──
  app.get('/api/status', (_req: Request, res: Response) => {
    res.json({
      soul: services.soul.getName(),
      providers: services.aiRouter.getActiveProviders().map((p: any) => ({
        id: p.id, name: p.name, model: p.model, tier: p.tier,
      })),
      costs: services.costs.getStatus(),
      skills: {
        total: services.skills.getLoadedCount(),
        author: services.skills.getAuthorSkillCount(),
        premium: services.skills.getPremiumSkillCount(),
        premiumInstalled: services.skills.getPremiumSkills(),
        catalog: services.skills.getSkillCatalog(),
        byCategory: services.skills.getSkillsByCategory(),
      },
      heartbeat: services.heartbeat.getStats(),
      autonomous: services.heartbeat.getAutonomousStatus(),
      permissions: services.permissions.preset,
      cache: services.aiRouter.getCacheStats(),
      personas: services.personas ? {
        count: services.personas.getCount(),
        list: services.personas.list().map((p: any) => ({ id: p.id, penName: p.penName, genre: p.genre })),
      } : { count: 0, list: [] },
    });
  });

  // ── Chat API (for integrations) ──
  app.post('/api/chat', async (req: Request, res: Response) => {
    const { message, skipHistory } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required' });
    }
    if (message.length > 10000) {
      return res.status(400).json({ error: 'Message too long (max 10,000 chars)' });
    }

    // Slash commands + natural language commands: route to dedicated handler
    const lower = message.toLowerCase().trim();
    const isCommand = message.startsWith('/') ||
      ['continue', 'next', 'go', 'resume'].includes(lower);
    if (isCommand) {
      try {
        const result = await gateway.handleDashboardCommand(message);
        return res.json({ response: result });
      } catch (err: any) {
        return res.json({ response: 'Command error: ' + String(err?.message || err) });
      }
    }

    // Regular chat: use AI
    const channel = skipHistory ? 'conductor' : 'api';
    let response = '';
    try {
      await gateway.handleMessage(message, channel, (text: string) => {
        response = text;
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('No AI providers')) {
        return res.status(503).json({ error: 'No AI providers configured. Add an API key in Settings → API Keys.' });
      }
      return res.status(500).json({ error: 'AI error: ' + msg });
    }

    res.json({ response });
  });

  // ── Project Management ──
  app.get('/api/projects', async (_req: Request, res: Response) => {
    const { readdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const { join } = await import('path');

    const projectsDir = join(baseDir, 'workspace', 'projects');
    if (!existsSync(projectsDir)) {
      return res.json({ projects: [] });
    }

    const entries = await readdir(projectsDir, { withFileTypes: true });
    const projects = entries.filter(e => e.isDirectory() && e.name !== '.template').map(e => e.name);
    res.json({ projects });
  });

  // ── Cost Report ──
  app.get('/api/costs', (_req: Request, res: Response) => {
    res.json(services.costs.getStatus());
  });

  // ── Audit Log (last 50 entries) ──
  app.get('/api/audit', async (_req: Request, res: Response) => {
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const { join } = await import('path');

    const today = new Date().toISOString().split('T')[0];
    const logFile = join(baseDir, 'workspace', '.audit', `${today}.jsonl`);

    if (!existsSync(logFile)) {
      return res.json({ entries: [] });
    }

    const raw = await readFile(logFile, 'utf-8');
    const entries = raw.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-50);

    res.json({ entries });
  });

  // ═══════════════════════════════════════════════════════════
  // Activity Log (universal agent action feed)
  // ═══════════════════════════════════════════════════════════

  // Get recent activity entries
  app.get('/api/activity', async (req: Request, res: Response) => {
    const activityLog = gateway.getActivityLog?.();
    if (!activityLog) {
      return res.json({ entries: [] });
    }
    const count = Number(req.query.count) || 50;
    const goalId = req.query.goalId as string | undefined;
    const entries = await activityLog.getRecent(count, goalId);
    res.json({ entries });
  });

  // SSE stream for real-time activity updates
  app.get('/api/activity/stream', (req: Request, res: Response) => {
    const activityLog = gateway.getActivityLog?.();
    if (!activityLog) {
      return res.status(503).json({ error: 'Activity log not initialized' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial heartbeat
    res.write('data: {"type":"connected"}\n\n');

    // Register this client for live updates
    const cleanup = activityLog.addSSEClient(res);

    // Periodic keepalive so proxies/browsers don't close the idle connection.
    // Comment lines (prefixed ":") are ignored by EventSource but count as traffic.
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* connection already closed */ }
    }, 15000);

    // Clean up on disconnect
    req.on('close', () => {
      clearInterval(keepalive);
      cleanup();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Memory Management
  // ═══════════════════════════════════════════════════════════

  app.post('/api/memory/reset', async (req: Request, res: Response) => {
    const fullReset = req.query.full === 'true' || req.body?.full === true;
    try {
      const result = await services.memory.reset(fullReset);
      await services.audit.log('memory', 'reset', { fullReset, cleared: result.cleared });
      res.json({ success: true, ...result, fullReset });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reset memory: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Vault Management (for dashboard API key configuration)
  // ═══════════════════════════════════════════════════════════

  // Store a key in the encrypted vault
  app.post('/api/vault', async (req: Request, res: Response) => {
    const { key, value } = req.body;
    if (!key || !value) {
      return res.status(400).json({ error: 'key and value required' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      return res.status(400).json({ error: 'Invalid key name. Use only letters, numbers, underscores, and hyphens.' });
    }

    // Non-blocking format check — catches slot/format mismatches (e.g. a
    // Gemini key pasted into the OpenAI slot) without preventing the save.
    const formatCheck = validateKeyFormat(key, value);
    if (!formatCheck.ok && formatCheck.warning) {
      console.warn(`[vault] Key format warning for "${key}": ${formatCheck.warning}`);
    }

    try {
      await services.vault.set(key, value);
      await services.audit.log('vault', 'key_stored', { key });

      // Auto-refresh AI providers when an API key is stored
      const apiKeyNames = ['gemini_api_key', 'deepseek_api_key', 'anthropic_api_key', 'openai_api_key', 'openrouter_api_key'];
      let refreshedProviders: string[] | undefined;
      if (apiKeyNames.includes(key)) {
        refreshedProviders = await services.aiRouter.reinitialize();
      }

      res.json({ success: true, key, refreshedProviders, warning: formatCheck.warning });
    } catch (error) {
      res.status(500).json({ error: 'Failed to store key' });
    }
  });

  // Manually refresh AI provider detection
  app.post('/api/providers/refresh', async (_req: Request, res: Response) => {
    try {
      const providers = await services.aiRouter.reinitialize();
      res.json({
        success: true,
        providers: services.aiRouter.getActiveProviders().map((p: any) => ({
          id: p.id, name: p.name, model: p.model, tier: p.tier,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to refresh providers: ' + String(error) });
    }
  });

  // Ad-hoc connectivity test for one provider (Connections [Test] button).
  // Reuses the same reachability probes run at startup — never spends a
  // real completion call.
  app.post('/api/providers/:id/test', async (req: Request, res: Response) => {
    const router = services.aiRouter;
    if (!router || typeof router.testProvider !== 'function') {
      return res.status(503).json({ ok: false, message: 'AI router not available' });
    }
    try {
      const result = await router.testProvider(String(req.params.id || ''));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, message: err?.message || 'Test failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Per-provider Model Selection (settings-editable)
  // ═══════════════════════════════════════════════════════════

  // List each provider's current/default model, tier, known models, and price.
  app.get('/api/models', (_req: Request, res: Response) => {
    const router = services.aiRouter;
    if (!router || typeof router.getProviderModelInfo !== 'function') {
      return res.status(503).json({ error: 'AI router not available' });
    }
    res.json({ providers: router.getProviderModelInfo() });
  });

  // Set a provider's model (settings-editable), persist, and reinitialize.
  // Accepts a free-text custom model string — unknown models are allowed
  // (price confidence is reported as 'rough').
  app.post('/api/models', async (req: Request, res: Response) => {
    const router = services.aiRouter;
    if (!router || typeof router.setProviderModel !== 'function') {
      return res.status(503).json({ error: 'AI router not available' });
    }
    const { provider, model } = req.body || {};
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ error: 'provider (string) required' });
    }
    if (typeof model !== 'string') {
      return res.status(400).json({ error: 'model (string) required (empty string clears the override)' });
    }
    const knownProviders: string[] = typeof router.getKnownProviders === 'function'
      ? router.getKnownProviders()
      : [];
    if (knownProviders.length > 0 && !knownProviders.includes(provider)) {
      return res.status(400).json({ error: `Unknown provider "${provider}". Known: ${knownProviders.join(', ')}` });
    }
    try {
      await router.setProviderModel(provider, model);
      await services.audit?.log?.('models', 'model_set', { provider, model });
      // Return the updated info for just this provider.
      const info = router.getProviderModelInfo().find((p: any) => p.id === provider);
      res.json({ success: true, provider: info });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to set provider model' });
    }
  });

  // Load API keys from text files in the VM shared folder
  app.post('/api/vault/load-from-files', async (req: Request, res: Response) => {
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { join: j } = await import('path');

    // Check common shared folder locations (VM, Docker, or user-set env var)
    const candidates = [
      process.env.AUTHORCLAW_KEYS_DIR,
      '/media/sf_authorclaw-transfer',
      '/media/sf_vm-transfer',
      j(baseDir, '..', 'vm-transfer'),
    ].filter(Boolean) as string[];
    const sharedFolder = candidates.find(p => ex(p));
    if (!sharedFolder) {
      return res.status(404).json({ error: 'No key folder found. Add API keys manually in Settings above.' });
    }

    const keyFiles: Record<string, string> = {
      'gemini_api_key': 'gemini_api_key.txt',
      'deepseek_api_key': 'deepseek_api_key.txt',
      'anthropic_api_key': 'anthropic_api_key.txt',
      'openai_api_key': 'openai_api_key.txt',
      'telegram_bot_token': 'telegram_bot_token.txt',
    };

    const loaded: string[] = [];
    const errors: string[] = [];

    for (const [vaultKey, filename] of Object.entries(keyFiles)) {
      const filePath = j(sharedFolder, filename);
      if (ex(filePath)) {
        try {
          const value = (await rf(filePath, 'utf-8')).trim();
          if (value && value.length > 5) {
            await services.vault.set(vaultKey, value);
            await services.audit.log('vault', 'key_loaded_from_file', { key: vaultKey, file: filename });
            loaded.push(vaultKey);
          }
        } catch (e) {
          errors.push(`${filename}: ${String(e)}`);
        }
      }
    }

    // Generic key.txt fallback
    const fallbackKey = req.body?.fallbackKeyName || 'gemini_api_key';
    const genericPath = j(sharedFolder, 'key.txt');
    if (ex(genericPath) && !loaded.includes(fallbackKey)) {
      try {
        const value = (await rf(genericPath, 'utf-8')).trim();
        if (value && value.length > 5) {
          await services.vault.set(fallbackKey, value);
          await services.audit.log('vault', 'key_loaded_from_file', { key: fallbackKey, file: 'key.txt' });
          loaded.push(fallbackKey + ' (from key.txt)');
        }
      } catch (e) {
        errors.push(`key.txt: ${String(e)}`);
      }
    }

    // Re-initialize AI providers if any API keys were loaded
    const apiKeyNames = ['gemini_api_key', 'deepseek_api_key', 'anthropic_api_key', 'openai_api_key'];
    if (loaded.some(k => apiKeyNames.some(ak => k.startsWith(ak)))) {
      await services.aiRouter.reinitialize();
    }

    res.json({ loaded, errors, message: loaded.length > 0 ? `Loaded ${loaded.length} key(s)` : 'No key files found in shared folder' });
  });

  // List stored key names (never values)
  app.get('/api/vault/keys', async (_req: Request, res: Response) => {
    const keys = await services.vault.list();
    res.json({ keys });
  });

  // Delete a key from the vault
  app.delete('/api/vault/:key', async (req: Request, res: Response) => {
    const key = String(req.params.key || '');
    // Same validation as POST — only allow alphanumeric + underscore/hyphen.
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || key.length < 1 || key.length > 100) {
      return res.status(400).json({ error: 'Invalid key name' });
    }
    const deleted = await services.vault.delete(key);
    if (deleted) {
      await services.audit.log('vault', 'key_deleted', { key });
    }
    res.json({ success: deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Config (sanitized, read-only for dashboard)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      ai: services.config.get('ai'),
      heartbeat: services.config.get('heartbeat'),
      costs: services.config.get('costs'),
      security: { permissionPreset: services.config.get('security.permissionPreset') },
      // Public-by-design: footer link URLs the dashboard renders. Forks can
      // override these in config/user.json without editing the HTML.
      branding: services.config.get('branding'),
    });
  });

  // Update a single config value (for dashboard settings)
  app.post('/api/config/update', async (req: Request, res: Response) => {
    const { path, value } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });
    const safePaths = [
      'costs.dailyLimit', 'costs.monthlyLimit',
      'heartbeat.intervalMinutes', 'heartbeat.dailyWordGoal',
      'heartbeat.enableReminders', 'heartbeat.quietHoursStart',
      'heartbeat.quietHoursEnd', 'heartbeat.autonomousEnabled',
      'heartbeat.autonomousIntervalMinutes', 'heartbeat.maxAutonomousStepsPerWake',
      'ai.defaultTemperature', 'ai.preferredProvider', 'ai.preferredProviderFallback', 'ai.preferredImageProvider',
      'ai.ollama.enabled', 'ai.ollama.endpoint', 'ai.ollama.model',
      'ai.openai.endpoint', 'ai.openai.model',
      'ai.openrouter.model',
      'ai.claude-cli.enabled', 'ai.claude-cli.binPath',
      'bridges.telegram.enabled', 'bridges.telegram.pairingEnabled',
      'workspaceGit.enabled', 'workspaceGit.repoRoot',
      'workspaceGit.syncIntervalMinutes', 'workspaceGit.autoMergeEnabled',
    ];
    if (!safePaths.includes(path)) {
      return res.status(403).json({ error: 'Config path not allowed' });
    }
    try {
      // Persist to disk so settings survive restart (was a bug — values were
      // updating in-memory only, then getting lost on next boot).
      await services.config.setAndPersist(path, value);
      // Sync global provider preference to router
      if (path === 'ai.preferredProvider') {
        services.aiRouter.setGlobalPreferredProvider(value || null);
      }
      if (path === 'ai.preferredProviderFallback') {
        services.aiRouter.setGlobalPreferredProviderFallback(value || null);
      }
      res.json({ success: true, path, value });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Config update failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Telegram Bridge Management (dashboard integration)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/telegram/status', async (_req: Request, res: Response) => {
    const enabled = services.config.get('bridges.telegram.enabled', false);
    const hasToken = (await services.vault.list()).includes('telegram_bot_token');
    const allowedUsers: string[] = services.config.get('bridges.telegram.allowedUsers', []);
    const connected = gateway.isTelegramConnected?.() || false;

    res.json({
      enabled,
      hasToken,
      connected,
      allowedUsers,
      pairingEnabled: services.config.get('bridges.telegram.pairingEnabled', true),
    });
  });

  app.post('/api/telegram/users', async (req: Request, res: Response) => {
    const { users } = req.body;
    if (!Array.isArray(users)) {
      return res.status(400).json({ error: 'users must be an array of user ID strings' });
    }
    const valid = users.every((u: any) => typeof u === 'string' && /^\d+$/.test(u));
    if (!valid) {
      return res.status(400).json({ error: 'Each user ID must be a numeric string' });
    }
    await services.config.setAndPersist('bridges.telegram.allowedUsers', users);
    gateway.updateTelegramUsers?.(users);
    res.json({ success: true, users });
  });

  app.post('/api/telegram/connect', async (req: Request, res: Response) => {
    try {
      const { token, userId } = req.body || {};

      // Save token and userId to vault before connecting
      if (token) {
        await services.vault.set('telegram_bot_token', token);
        await services.audit.log('vault', 'telegram_token_saved', {});
      }
      if (userId) {
        await services.config.setAndPersist('bridges.telegram.allowedUsers', [String(userId)]);
      }

      const result = await gateway.connectTelegram?.();
      if (result?.error) {
        return res.status(400).json({ error: result.error });
      }
      await services.config.setAndPersist('bridges.telegram.enabled', true);
      res.json({ success: true, message: 'Telegram bridge connected' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to connect Telegram: ' + String(error) });
    }
  });

  app.post('/api/telegram/disconnect', async (_req: Request, res: Response) => {
    gateway.disconnectTelegram?.();
    await services.config.setAndPersist('bridges.telegram.enabled', false);
    res.json({ success: true, message: 'Telegram bridge disconnected' });
  });

  app.post('/api/telegram/test', async (req: Request, res: Response) => {
    const token = req.body.token || await services.vault.get('telegram_bot_token');
    if (!token) {
      return res.status(400).json({ error: 'No token provided or stored' });
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json() as any;
      if (data.ok) {
        res.json({ success: true, bot: { username: data.result.username, name: data.result.first_name } });
      } else {
        res.status(400).json({ error: data.description || 'Invalid token' });
      }
    } catch (error) {
      res.status(500).json({ error: 'Failed to test token: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 5 — Onboarding / First-Run Readiness (Author HQ)
  // ═══════════════════════════════════════════════════════════
  //
  // Pure-read aggregate over existing services (vault, AI router, soul files,
  // projects directory, telegram config) — no new state is introduced here.
  // Every check is independently guarded so one failing signal (e.g. a
  // missing workspace/soul directory on a very first boot) can't 500 the
  // whole endpoint; it just reports that item as not-done.

  app.get('/api/onboarding/status', async (_req: Request, res: Response) => {
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const { readdir } = await import('fs/promises');
    const { join } = await import('path');

    type ChecklistItem = { id: string; label: string; done: boolean; hint: string };
    const checklist: ChecklistItem[] = [];

    // ── 1. At least one AI provider key present (vault key OR Ollama reachable) ──
    let hasProvider = false;
    try {
      const active = services.aiRouter.getActiveProviders();
      hasProvider = Array.isArray(active) && active.length > 0;
    } catch {
      // Fall back to a raw vault check below if the router isn't ready yet.
    }
    if (!hasProvider) {
      try {
        const keys: string[] = await services.vault.list();
        hasProvider = hasProviderKeyName(keys);
      } catch {
        hasProvider = false;
      }
    }
    checklist.push({
      id: 'ai_provider',
      label: 'Connect an AI provider',
      done: hasProvider,
      hint: hasProvider
        ? 'At least one AI provider is active.'
        : 'Add a free Gemini key, run Ollama locally, or add a paid key in Settings → API Keys.',
    });

    // ── 2. Voice profile analyzed (file exists AND isn't the shipped template) ──
    let voiceAnalyzed = false;
    try {
      const voicePath = join(baseDir, 'workspace', 'soul', 'VOICE-PROFILE.md');
      if (existsSync(voicePath)) {
        const content = await readFile(voicePath, 'utf-8');
        voiceAnalyzed = !isVoiceProfileTemplate(content);
      }
    } catch {
      voiceAnalyzed = false;
    }
    checklist.push({
      id: 'voice_profile',
      label: 'Analyze your writing voice',
      done: voiceAnalyzed,
      hint: voiceAnalyzed
        ? 'Voice profile is analyzed and active.'
        : 'Send a 5,000+ word writing sample and say "Learn my style from this."',
    });

    // ── 3. Soul / identity present (SOUL.md exists and has content) ──
    let soulPresent = false;
    try {
      const soulPath = join(baseDir, 'workspace', 'soul', 'SOUL.md');
      if (existsSync(soulPath)) {
        const content = await readFile(soulPath, 'utf-8');
        soulPresent = content.trim().length > 0;
      }
    } catch {
      soulPresent = false;
    }
    checklist.push({
      id: 'soul',
      label: 'Set up your agent identity',
      done: soulPresent,
      hint: soulPresent
        ? 'SOUL.md is present.'
        : 'AuthorAgent ships with a default SOUL.md — customize it in workspace/soul/SOUL.md if you want a different personality.',
    });

    // ── 4. At least one project created ──
    let hasProject = false;
    try {
      const projectsDir = join(baseDir, 'workspace', 'projects');
      if (existsSync(projectsDir)) {
        const entries = await readdir(projectsDir, { withFileTypes: true });
        hasProject = entries.some(e => e.isDirectory() && e.name !== '.template');
      }
    } catch {
      hasProject = false;
    }
    checklist.push({
      id: 'project',
      label: 'Create your first project',
      done: hasProject,
      hint: hasProject
        ? 'At least one project exists.'
        : 'Start a novel, book bible, or blog post from the Projects panel.',
    });

    // ── 5. (Optional) Telegram connected ──
    let telegramConnected = false;
    try {
      const enabled = services.config.get('bridges.telegram.enabled', false);
      const hasToken = (await services.vault.list()).includes('telegram_bot_token');
      telegramConnected = Boolean(enabled) && hasToken;
    } catch {
      telegramConnected = false;
    }
    checklist.push({
      id: 'telegram',
      label: 'Connect Telegram (optional)',
      done: telegramConnected,
      hint: telegramConnected
        ? 'Telegram bridge is connected.'
        : 'Optional — connect Telegram in Settings to write from your phone.',
    });

    // firstRun is driven by the CORE items only (provider + project). Voice
    // profile, soul, and Telegram are valuable but not required to start
    // using AuthorAgent, so they don't gate the "first run" banner.
    const coreDone = hasProvider && hasProject;

    res.json({
      firstRun: !coreDone,
      checklist,
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Phase 5 — Writing Stats (Author HQ)
  // ═══════════════════════════════════════════════════════════
  //
  // Aggregates the persisted daily-word-tally store (wired into
  // HeartbeatService — see services/writing-stats.ts and
  // HeartbeatService.addWords()) with a live project count. Pure read; never
  // throws — a missing/corrupt stats file just reports zeros.

  app.get('/api/writing/stats', async (_req: Request, res: Response) => {
    try {
      const { existsSync } = await import('fs');
      const { readdir } = await import('fs/promises');
      const { join } = await import('path');

      let activeProjects = 0;
      try {
        const projectsDir = join(baseDir, 'workspace', 'projects');
        if (existsSync(projectsDir)) {
          const entries = await readdir(projectsDir, { withFileTypes: true });
          activeProjects = entries.filter(e => e.isDirectory() && e.name !== '.template').length;
        }
      } catch {
        activeProjects = 0;
      }

      const store = services.heartbeat?.getWritingStats?.();
      if (!store) {
        // HeartbeatService was constructed without a workspace (shouldn't
        // happen in production, but keep this endpoint 200-always).
        return res.json({
          wordsToday: 0, wordsThisWeek: 0, wordsTotal: 0,
          currentStreakDays: 0, longestStreakDays: 0,
          activeProjects, lastActiveIso: null,
        });
      }

      const snapshot = await store.getSnapshot(activeProjects);
      res.json(snapshot);
    } catch (error) {
      // Never throw — degrade to a safe zeroed shape.
      res.json({
        wordsToday: 0, wordsThisWeek: 0, wordsTotal: 0,
        currentStreakDays: 0, longestStreakDays: 0,
        activeProjects: 0, lastActiveIso: null,
        error: 'Failed to load writing stats: ' + String((error as Error)?.message || error),
      });
    }
  });

  // Manual word-logging for the dashboard (e.g. "I wrote 500 words offline").
  app.post('/api/writing/log-words', async (req: Request, res: Response) => {
    const count = Number(req.body?.count);
    if (!Number.isFinite(count) || count <= 0) {
      return res.status(400).json({ error: 'count must be a positive number' });
    }
    if (count > 200000) {
      return res.status(400).json({ error: 'count is implausibly large (max 200,000 per entry)' });
    }
    try {
      // Reuse the exact same path project steps use, so manual entries show
      // up in both the persisted stats store AND heartbeat's in-memory
      // today/streak counters (Morning Briefing stays consistent).
      services.heartbeat.addWords(Math.round(count));
      res.json({ success: true, count: Math.round(count) });
    } catch (error) {
      res.status(500).json({ error: 'Failed to log words: ' + String((error as Error)?.message || error) });
    }
  });

}

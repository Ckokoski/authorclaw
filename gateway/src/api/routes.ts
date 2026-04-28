/**
 * AuthorClaw API Routes
 * REST API for the dashboard and external integrations
 */

// NOTE: All endpoints are currently unauthenticated.
// This is acceptable because the server binds to 127.0.0.1 only (localhost).
// For remote access, implement Bearer token auth using the vault.

import { Application, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { generateDocxBuffer } from '../services/docx-export.js';
import { generateEpubBuffer } from '../services/epub-export.js';

/** Verify resolved path stays within the allowed base directory */
function safePath(base: string, userInput: string): string | null {
  const resolved = path.resolve(base, userInput);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  return resolved;
}

export function createAPIRoutes(app: Application, gateway: any, rootDir?: string): void {
  const services = gateway.getServices();
  const baseDir = rootDir || process.cwd();

  // ── Health Check ──
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '4.0.0',
      name: 'AuthorClaw',
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
    try {
      await services.vault.set(key, value);
      await services.audit.log('vault', 'key_stored', { key });

      // Auto-refresh AI providers when an API key is stored
      const apiKeyNames = ['gemini_api_key', 'deepseek_api_key', 'anthropic_api_key', 'openai_api_key'];
      let refreshedProviders: string[] | undefined;
      if (apiKeyNames.includes(key)) {
        refreshedProviders = await services.aiRouter.reinitialize();
      }

      res.json({ success: true, key, refreshedProviders });
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
      'ai.defaultTemperature', 'ai.preferredProvider',
      'ai.ollama.enabled', 'ai.ollama.endpoint', 'ai.ollama.model',
      'bridges.telegram.enabled', 'bridges.telegram.pairingEnabled',
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
  // Project Engine (autonomous project-based task planning)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/projects/templates', async (_req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    // Merge built-in templates with custom templates
    const builtIn = engine.getTemplates();
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(baseDir, 'workspace', '.config', 'custom-project-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    const customMapped = custom.map((t: any) => ({
      ...t, label: t.title, stepCount: 0, custom: true,
    }));
    res.json({ templates: [...builtIn, ...customMapped] });
  });

  // Save a custom project template
  app.post('/api/projects/templates', async (req: Request, res: Response) => {
    const { title, description, type } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { randomBytes } = await import('crypto');
    const configDir = j(baseDir, 'workspace', '.config');
    await mkd(configDir, { recursive: true });
    const customPath = j(configDir, 'custom-project-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    custom.push({ id: randomBytes(6).toString('hex'), title, description, type: type || 'general', createdAt: new Date().toISOString() });
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Delete a custom project template
  app.delete('/api/projects/templates/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(baseDir, 'workspace', '.config', 'custom-project-templates.json');
    if (!ex(customPath)) {
      return res.json({ success: false, error: 'No custom templates' });
    }
    let custom: any[] = [];
    try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    custom = custom.filter((t: any) => t.id !== req.params.id);
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Create a new project — supports dynamic AI planning
  app.post('/api/projects/create', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const { type, title, description, context, planning, config, personaId, preferredProvider } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }

    // Helper to set optional fields on newly created projects
    const applyProjectOptions = (project: any) => {
      if (personaId) project.personaId = personaId;
      if (preferredProvider) project.preferredProvider = preferredProvider;
    };

    // Novel pipeline: use dedicated pipeline builder
    // Trust the explicitly-sent type; only infer from description if no type provided
    const inferredType = type || engine.inferProjectType(description);
    if (inferredType === 'novel-pipeline') {
      const project = engine.createNovelPipeline(title, description, config || context);
      applyProjectOptions(project);
      return res.json({ project, planning: 'novel-pipeline' });
    }

    // Book Production: uses dynamic chapter generation
    if (inferredType === 'book-production') {
      const project = engine.createBookProduction(title, description, config || context || {});
      applyProjectOptions(project);
      return res.json({ project, planning: 'book-production' });
    }

    // Dynamic planning: ask the AI to figure out the steps
    if (planning === 'dynamic') {
      const skillCatalog = services.skills.getSkillCatalog();
      const authorOSTools = services.authorOS?.getAvailableTools() || [];
      const project = await engine.planProject(title, description, skillCatalog, authorOSTools, context);
      applyProjectOptions(project);
      return res.json({ project, planning: 'dynamic' });
    }

    // Template-based fallback
    const projectType = inferredType;
    const project = engine.createProject(projectType, title, description, context);
    applyProjectOptions(project);
    res.json({ project, planning: 'template' });
  });

  // ── Pipeline Creation (chains all 6 phases) ──
  app.post('/api/pipeline/create', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const { title, description, personaId, config } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    try {
      const result = engine.createPipeline(title, description, personaId, config);
      res.json({
        pipelineId: result.pipelineId,
        phases: result.projects.map((p: any) => ({
          id: p.id,
          type: p.type,
          title: p.title,
          phase: p.pipelinePhase,
          steps: p.steps.length,
          status: p.status,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create pipeline: ' + String(err) });
    }
  });

  // ── Pipeline Status ──
  app.get('/api/pipeline/:pipelineId', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const projects = engine.getPipelineProjects(req.params.pipelineId);
    if (projects.length === 0) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    res.json({
      pipelineId: req.params.pipelineId,
      phases: projects.map((p: any) => ({
        id: p.id,
        type: p.type,
        title: p.title,
        phase: p.pipelinePhase,
        steps: p.steps.length,
        completedSteps: p.steps.filter((s: any) => s.status === 'completed' || s.status === 'skipped').length,
        status: p.status,
        progress: p.progress,
      })),
    });
  });

  app.get('/api/projects/list', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const status = (req.query as any).status;
    res.json({ projects: engine.listProjects(status) });
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({ project });
  });

  app.post('/api/projects/:id/start', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const step = engine.startProject(req.params.id);
    if (!step) {
      return res.status(404).json({ error: 'Project not found or no pending steps' });
    }
    res.json({ step, project: engine.getProject(req.params.id) });
  });

  /**
   * Smart excerpt builder for large manuscripts.
   * Reads the full document from disk and extracts a relevant excerpt
   * that fits within AI context limits while preserving the most useful content.
   *
   * Strategy: first 20K chars + last 5K chars (with truncation marker)
   * This gives the AI the beginning (setup, style, voice) and ending (current state)
   * which is ideal for revision, editing, and analysis tasks.
   */
  async function getSmartExcerpt(filePath: string, wordCount: number, maxChars = 25000): Promise<string> {
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    if (!ex(filePath)) {
      return `[Document not found at ${filePath} — it may have been moved or deleted]`;
    }

    const fullText = await rf(filePath, 'utf-8');

    if (fullText.length <= maxChars) {
      return fullText; // Small enough to include everything
    }

    // Smart split: 80% head + 20% tail
    const headSize = Math.floor(maxChars * 0.8);
    const tailSize = maxChars - headSize;
    const head = fullText.substring(0, headSize);
    const tail = fullText.substring(fullText.length - tailSize);

    const omittedChars = fullText.length - headSize - tailSize;
    const omittedWords = Math.round(omittedChars / 5); // rough estimate

    return `${head}\n\n` +
      `[... ⚠️ MIDDLE SECTION OMITTED: ~${omittedWords.toLocaleString()} words skipped to fit context. ` +
      `Full document (${wordCount.toLocaleString()} words) is saved in workspace/documents/. ...]\n\n` +
      `${tail}`;
  }

  // Returns true if the step requires the FULL manuscript in context (not a truncated excerpt).
  // Revision-apply steps must see the whole book to rewrite it correctly.
  function stepNeedsFullManuscript(step: any): boolean {
    const phase = String(step?.phase || '').toLowerCase();
    const label = String(step?.label || '').toLowerCase();
    return phase === 'revision_apply' ||
      label.includes('apply macro revision') ||
      label.includes('apply scene-level revision') ||
      label.includes('apply line-level revision') ||
      label.includes('full manuscript rewrite');
  }

  // Helper: build user message for project step execution
  // Injects uploaded manuscript DIRECTLY into the user message so the AI can't miss it
  // For large documents (15K+ words): reads from disk and applies smart truncation
  async function buildStepUserMessage(project: any, step: any): Promise<string> {
    let message = step.prompt;
    const uploads = project.context?.uploads || [];
    const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount?.toLocaleString() || '?'} words)`).join(', ');

    // Revision-apply steps need to see the full manuscript; analysis steps get a smart excerpt.
    const fullNeeded = stepNeedsFullManuscript(step);
    const charCap = fullNeeded ? 600000 : 30000;  // ~120K words when needed (fits Claude/Gemini context)

    // Large document path: read from disk with cap-aware truncation
    if (project.context?.documentLibraryFile) {
      const excerpt = await getSmartExcerpt(
        project.context.documentLibraryFile,
        project.context.documentWordCount || 0,
        charCap
      );
      const headerNote = fullNeeded
        ? `\n\n⚠️ This is a REVISION APPLY step. You MUST rewrite the ENTIRE manuscript below (or as much as fits in your response — the system will ask for continuations).\n\n`
        : '';
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}${headerNote}\n\n${excerpt}\n\n---\n\n## Your Task\n\n${message}`;
      return message;
    }

    // Small document path: use inline uploaded content
    if (project.context?.uploadedContent) {
      const uploaded = String(project.context.uploadedContent).substring(0, charCap);
      const headerNote = fullNeeded
        ? `\n\n⚠️ This is a REVISION APPLY step. You MUST rewrite the ENTIRE manuscript below (or as much as fits in your response — the system will ask for continuations).\n\n`
        : '';
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}${headerNote}\n\n${uploaded}\n\n---\n\n## Your Task\n\n${message}`;
    }

    return message;
  }

  app.post('/api/projects/:id/execute', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const activeStep = project.steps.find((s: any) => s.status === 'active');
    if (!activeStep) {
      return res.status(400).json({ error: 'No active step. Start the project first.' });
    }

    try {
      const projectContext = await engine.buildProjectContext(project, activeStep);
      const userMessage = await buildStepUserMessage(project, activeStep);
      let response = '';

      await gateway.handleMessage(
        userMessage,
        'projects',
        (text: string) => { response = text; },
        projectContext,
        activeStep.taskType || undefined  // Use step's own taskType for routing
      );

      // Retry once with 'general' routing if the response is too short
      if (!response || response.length < 50) {
        console.log(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
        response = '';
        await gateway.handleMessage(
          userMessage,
          'projects',
          (text: string) => { response = text; },
          projectContext,
          'general'
        );
      }

      if (!response || response.length < 50) {
        engine.failStep(project.id, activeStep.id, 'Empty or too-short response from AI');
        return res.json({
          success: false,
          error: 'AI returned an insufficient response',
          project: engine.getProject(project.id),
        });
      }

      const nextStep = engine.completeStep(project.id, activeStep.id, response);

      res.json({
        success: true,
        completedStep: activeStep.id,
        response,
        nextStep,
        project: engine.getProject(project.id),
      });
    } catch (error) {
      engine.failStep(project.id, activeStep.id, String(error));
      res.status(500).json({
        error: 'Step execution failed: ' + String(error),
        project: engine.getProject(project.id),
      });
    }
  });

  // Auto-execute ALL steps of a project (fully autonomous mode)
  app.post('/api/projects/:id/auto-execute', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.status === 'pending') {
      engine.startProject(req.params.id);
    } else if (project.status === 'paused') {
      project.status = 'active';
      const firstPending = project.steps.find((s: any) => s.status === 'pending');
      if (firstPending) firstPending.status = 'active';
    }

    const results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }> = [];
    const { join } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');
    const workspaceDir = join(baseDir, 'workspace');

    while (true) {
      const currentProject = engine.getProject(req.params.id);
      if (!currentProject) break;

      // Check if project was paused externally (via /stop or dashboard)
      if (currentProject.status === 'paused' || currentProject.status === 'completed') break;

      const activeStep = currentProject.steps.find((s: any) => s.status === 'active');
      if (!activeStep) break;

      try {
        const projectContext = await engine.buildProjectContext(currentProject, activeStep);
        const userMessage = await buildStepUserMessage(currentProject, activeStep);
        let response = '';

        await gateway.handleMessage(
          userMessage,
          'project-engine',
          (text: string) => { response = text; },
          projectContext,
          activeStep.taskType || undefined  // Use step's own taskType for routing
        );

        // Retry once with 'general' routing if the response is too short
        // This catches cases where a premium/mid provider fails but free providers work fine
        if (!response || response.length < 50) {
          console.log(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
          response = '';
          await gateway.handleMessage(
            userMessage,
            'project-engine',
            (text: string) => { response = text; },
            projectContext,
            'general'  // Force free-tier routing (Gemini first)
          );
        }

        if (!response || response.length < 50) {
          engine.failStep(currentProject.id, activeStep.id, 'Empty or too-short response from AI');
          results.push({ step: activeStep.label, success: false, error: 'Insufficient AI response' });
          break;
        }

        // ── Continuation logic for long-output steps (revision-apply + novel writing) ──
        // Revision-apply steps must produce a FULL manuscript. If the response is shorter
        // than the source (or shorter than the explicit wordCountTarget), ask the AI to
        // continue. This prevents the user from getting a half-revised book.
        {
          const isRevisionApply = stepNeedsFullManuscript(activeStep);
          const wcTarget = (activeStep as any).wordCountTarget ||
            (isRevisionApply ? Math.floor((currentProject.context?.documentWordCount || 0) * 0.9) : 0);
          if (wcTarget && wcTarget > 0) {
            let wc = response.split(/\s+/).length;
            let continuations = 0;
            while (wc < wcTarget && continuations < 6) {
              continuations++;
              const remaining = wcTarget - wc;
              console.log(`  [${isRevisionApply ? 'revision-apply' : 'writing'}] Response word count: ${wc}/${wcTarget} — requesting continuation #${continuations} (~${remaining} more words)`);
              let contResponse = '';
              try {
                const contPrompt = isRevisionApply
                  ? `Continue the revised manuscript from EXACTLY where you left off. You've produced ${wc} words so far; the target is ${wcTarget}. Output at least ${Math.min(remaining, 15000)} more words of the revised manuscript, continuing from the last chapter boundary. Do NOT repeat content. Do NOT summarize. Do NOT add commentary. Output ONLY the continued manuscript prose.`
                  : `Continue writing from where you left off. You wrote ${wc} words so far but the target is ${wcTarget}. Write at least ${remaining} more words of prose narrative, continuing the story seamlessly. Do NOT repeat what was already written. Do NOT summarize.`;
                await gateway.handleMessage(
                  contPrompt,
                  'project-engine',
                  (text: string) => { contResponse = text; },
                  projectContext,
                  activeStep.taskType || undefined,
                );
                if (contResponse.length > 100) {
                  response = response + '\n\n' + contResponse;
                  wc = response.split(/\s+/).length;
                } else {
                  break;
                }
              } catch {
                break;
              }
            }
            if (continuations > 0) {
              console.log(`  [${isRevisionApply ? 'revision-apply' : 'writing'}] Final word count after ${continuations} continuation(s): ${response.split(/\s+/).length}`);
            }
          }
        }

        const wordCount = response.split(/\s+/).length;

        // Save to file
        try {
          const projectDir = join(workspaceDir, 'projects', currentProject.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          await mkdir(projectDir, { recursive: true });
          const stepFileName = `${activeStep.id}-${activeStep.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          await writeFile(join(projectDir, stepFileName), `# ${activeStep.label}\n\n${response}`, 'utf-8');
        } catch { /* non-fatal */ }

        engine.completeStep(currentProject.id, activeStep.id, response);
        // Track words for Morning Briefing
        services.heartbeat.addWords(wordCount);
        results.push({ step: activeStep.label, success: true, wordCount });

        // ── ContextEngine: summarize + extract entities for writing/bible steps ──
        try {
          const contextEngine = services.contextEngine;
          const stepLabel = (activeStep as any).label || '';
          const isWritingStep = stepLabel.toLowerCase().includes('chapter') ||
            stepLabel.toLowerCase().includes('write') ||
            (activeStep as any).phase === 'writing';
          const isBibleStep = currentProject.type === 'book-bible' ||
            stepLabel.toLowerCase().includes('bible') ||
            stepLabel.toLowerCase().includes('character') ||
            stepLabel.toLowerCase().includes('world');

          if (contextEngine && response.length > 200 && (isWritingStep || isBibleStep)) {
            const chapterNum = currentProject.steps.filter((s: any) =>
              s.status === 'completed' && s.id !== activeStep.id
            ).length + 1;

            const aiCompleteFn = (req: any) => services.aiRouter.complete(req);
            const aiSelectFn = (taskType: string) => services.aiRouter.selectProvider(taskType);

            // Await context engine calls so they complete before moving to next step
            await Promise.allSettled([
              contextEngine.generateSummary(
                currentProject.id, activeStep.id, stepLabel, chapterNum, response,
                aiCompleteFn, aiSelectFn
              ).catch((err: any) => console.error('[context-engine] Summary error:', err.message)),
              contextEngine.extractEntities(
                currentProject.id, activeStep.id, response,
                aiCompleteFn, aiSelectFn
              ).catch((err: any) => console.error('[context-engine] Entity extraction error:', err.message)),
            ]);
          }
        } catch (contextErr) {
          console.error('[context-engine] Hook error:', contextErr);
        }

        // ── Manuscript Assembly: combine chapter files after assembly step ──
        if ((activeStep as any).phase === 'assembly' && currentProject.type === 'novel-pipeline') {
          try {
            const { existsSync: exLocal } = await import('fs');
            const { readFile: readF } = await import('fs/promises');
            const projectSlug = currentProject.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const projectDir = join(workspaceDir, 'projects', projectSlug);

            const writingSteps = currentProject.steps
              .filter((s: any) => s.phase === 'writing' && s.status === 'completed')
              .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

            const chapterContents: string[] = [];
            for (const ws of writingSteps) {
              const expectedFile = `${(ws as any).id}-${(ws as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
              const fullPath = join(projectDir, expectedFile);
              if (exLocal(fullPath)) {
                const raw = await readF(fullPath, 'utf-8');
                const content = raw.replace(/^# .+\n\n/, '');
                chapterContents.push(`## Chapter ${(ws as any).chapterNumber || chapterContents.length + 1}\n\n${content}`);
              }
            }

            if (chapterContents.length > 0) {
              const manuscriptMd = `# ${currentProject.title}\n\n` + chapterContents.join('\n\n---\n\n');
              await writeFile(join(projectDir, 'manuscript.md'), manuscriptMd, 'utf-8');

              const docxBuffer = await generateDocxBuffer({
                title: currentProject.title,
                author: 'AuthorClaw',
                content: manuscriptMd,
              });
              await writeFile(join(projectDir, 'manuscript.docx'), docxBuffer);
              console.log(`  [assembly] Manuscript assembled: ${chapterContents.length} chapters`);
            }
          } catch { /* non-fatal */ }
        }

        // Re-check pause AFTER step completes (catches /stop sent during long AI call)
        const freshProject = engine.getProject(req.params.id);
        if (freshProject?.status === 'paused' || freshProject?.status === 'completed') break;
      } catch (error) {
        engine.failStep(currentProject.id, activeStep.id, String(error));
        results.push({ step: activeStep.label, success: false, error: String(error) });
        break;
      }
    }

    res.json({
      success: true,
      results,
      project: engine.getProject(req.params.id),
    });
  });

  app.post('/api/projects/:id/skip/:stepId', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const nextStep = engine.skipStep(req.params.id, req.params.stepId);
    res.json({ nextStep, project: engine.getProject(req.params.id) });
  });

  app.post('/api/projects/:id/pause', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    engine.pauseProject(req.params.id);
    res.json({ project: engine.getProject(req.params.id) });
  });

  // ── Resume a stuck/completed project that still has pending or active steps ──
  app.post('/api/projects/:id/resume', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Fix orphaned active steps — reset all but the first to pending
    const activeSteps = project.steps.filter((s: any) => s.status === 'active');
    if (activeSteps.length > 1) {
      // Keep only the first active step, reset the rest to pending
      for (let i = 1; i < activeSteps.length; i++) {
        activeSteps[i].status = 'pending';
      }
    }

    // If all remaining steps are 'pending' but none are 'active', activate the first one
    const hasActive = project.steps.some((s: any) => s.status === 'active');
    if (!hasActive) {
      const nextPending = project.steps.find((s: any) => s.status === 'pending');
      if (nextPending) nextPending.status = 'active';
    }

    // Set project status back to active
    const remaining = project.steps.filter((s: any) => s.status === 'pending' || s.status === 'active');
    if (remaining.length > 0) {
      project.status = 'active';
      delete (project as any).completedAt;
      project.updatedAt = new Date().toISOString();
    }

    // Recalculate progress
    const done = project.steps.filter((s: any) => s.status === 'completed' || s.status === 'skipped').length;
    project.progress = Math.round((done / project.steps.length) * 100);

    res.json({
      resumed: true,
      status: project.status,
      progress: project.progress,
      activeStep: project.steps.find((s: any) => s.status === 'active')?.label || null,
      remainingSteps: remaining.length,
    });
  });

  // ── Update a project's preferred provider ──
  app.post('/api/projects/:id/provider', (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { provider } = req.body;
    const valid = ['gemini', 'deepseek', 'claude', 'openai', 'ollama', '', null];
    if (!valid.includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    (project as any).preferredProvider = provider || undefined;
    project.updatedAt = new Date().toISOString();
    res.json({ success: true, preferredProvider: (project as any).preferredProvider || null });
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }

    // Get project info before deleting (to find files on disk)
    const project = engine.getProject(req.params.id);
    const deleteFiles = req.query.files === 'true';

    const deleted = engine.deleteProject(req.params.id);

    // Optionally delete workspace files too
    let filesDeleted = 0;
    if (deleted && deleteFiles && project) {
      try {
        const { join: j } = await import('path');
        const { rm } = await import('fs/promises');
        const { existsSync: ex } = await import('fs');
        const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);
        if (ex(projectDir)) {
          const { readdir } = await import('fs/promises');
          const entries = await readdir(projectDir);
          filesDeleted = entries.length;
          await rm(projectDir, { recursive: true });
        }
      } catch { /* non-fatal */ }
    }

    res.json({ success: deleted, filesDeleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Document Library (centralized document storage for large manuscripts)
  // ═══════════════════════════════════════════════════════════

  // List all documents in the library
  app.get('/api/documents', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readdir: rd, stat: st, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const docsDir = j(baseDir, 'workspace', 'documents');
    if (!ex(docsDir)) {
      return res.json({ documents: [] });
    }

    try {
      const entries = await rd(docsDir);
      const docs: Array<{ filename: string; size: number; wordCount?: number; uploadedAt?: string }> = [];

      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'metadata.json') continue;
        const fullPath = j(docsDir, entry);
        const info = await st(fullPath);
        if (!info.isFile()) continue;

        let wordCount: number | undefined;
        const ext = entry.split('.').pop()?.toLowerCase();
        if (ext === 'txt' || ext === 'md') {
          try {
            const text = await rf(fullPath, 'utf-8');
            wordCount = text.split(/\s+/).filter(Boolean).length;
          } catch { /* skip */ }
        }

        docs.push({
          filename: entry,
          size: info.size,
          wordCount,
          uploadedAt: info.mtime.toISOString(),
        });
      }

      // Load metadata for word counts of docx files
      const metaPath = j(docsDir, 'metadata.json');
      let metadata: Record<string, any> = {};
      if (ex(metaPath)) {
        try { metadata = JSON.parse(await rf(metaPath, 'utf-8')); } catch { /* ok */ }
      }
      for (const doc of docs) {
        if (!doc.wordCount && metadata[doc.filename]?.wordCount) {
          doc.wordCount = metadata[doc.filename].wordCount;
        }
      }

      res.json({ documents: docs });
    } catch {
      res.json({ documents: [] });
    }
  });

  // Upload a document directly to the library (not tied to a project)
  app.post('/api/documents/upload', multer({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max for library
    fileFilter: (_req, file, cb) => {
      const allowed = ['.txt', '.md', '.docx'];
      const ext = '.' + (file.originalname.split('.').pop() || '').toLowerCase();
      if (allowed.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`File type "${ext}" not supported. Use .txt, .md, or .docx`));
      }
    },
    storage: multer.memoryStorage(),
  }).single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { join: j } = await import('path');
    const { mkdir: mkd, writeFile: wf, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const docsDir = j(baseDir, 'workspace', 'documents');
    await mkd(docsDir, { recursive: true });

    const filename = req.file.originalname;
    const ext = filename.split('.').pop()?.toLowerCase();

    // Save the raw file
    await wf(j(docsDir, filename), req.file.buffer);

    // Extract text and word count
    let textContent = '';
    if (ext === 'txt' || ext === 'md') {
      textContent = req.file.buffer.toString('utf-8');
    } else if (ext === 'docx') {
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(req.file.buffer);
        const docEntry = zip.getEntry('word/document.xml');
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8');
          const paragraphs: string[] = [];
          const paraMatches = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
          for (const para of paraMatches) {
            const textParts = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
            if (textParts) {
              const line = textParts.map(t => t.replace(/<[^>]+>/g, '')).join('');
              if (line.trim()) paragraphs.push(line);
            }
          }
          textContent = paragraphs.join('\n\n');
        }
      } catch { /* ok */ }

      // Save extracted text alongside for fast access
      if (textContent) {
        const textFilename = filename.replace(/\.docx$/i, '.extracted.txt');
        await wf(j(docsDir, textFilename), textContent);
      }
    }

    const wordCount = textContent.split(/\s+/).filter(Boolean).length;

    // Save metadata
    const metaPath = j(docsDir, 'metadata.json');
    let metadata: Record<string, any> = {};
    if (ex(metaPath)) {
      try { metadata = JSON.parse(await rf(metaPath, 'utf-8')); } catch { /* ok */ }
    }
    metadata[filename] = {
      wordCount,
      uploadedAt: new Date().toISOString(),
      size: req.file.size,
    };
    await wf(metaPath, JSON.stringify(metadata, null, 2));

    res.json({
      success: true,
      filename,
      wordCount,
      size: req.file.size,
      library: true,
      preview: textContent.substring(0, 200),
    });
  });

  // Delete a document from the library
  app.delete('/api/documents/:filename', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { unlink, readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const filename = String(req.params.filename);
    const docsDir = j(baseDir, 'workspace', 'documents');
    const filePath = safePath(docsDir, filename);

    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'Document not found' });
    }

    await unlink(filePath);

    // Also delete extracted text if it exists
    const extractedName = filename.replace(/\.docx$/i, '.extracted.txt');
    const extractedPath = safePath(docsDir, extractedName);
    if (extractedPath && ex(extractedPath) && extractedPath !== filePath) {
      try { await unlink(extractedPath); } catch { /* ok */ }
    }

    // Update metadata
    const metaPath = j(docsDir, 'metadata.json');
    if (ex(metaPath)) {
      try {
        const metadata = JSON.parse(await rf(metaPath, 'utf-8'));
        delete metadata[filename];
        await wf(metaPath, JSON.stringify(metadata, null, 2));
      } catch { /* ok */ }
    }

    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Document Upload (project-level + auto-library for large files)
  // ═══════════════════════════════════════════════════════════

  const upload = multer({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max (up from 10MB for novel uploads)
    fileFilter: (_req, file, cb) => {
      const allowed = ['.txt', '.md', '.docx'];
      const ext = '.' + (file.originalname.split('.').pop() || '').toLowerCase();
      if (allowed.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`File type "${ext}" not supported. Use .txt, .md, or .docx`));
      }
    },
    storage: multer.memoryStorage(),
  });

  app.post('/api/projects/:id/upload', upload.single('file'), async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) {
      return res.status(503).json({ error: 'Project engine not initialized' });
    }
    const project = engine.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { join: j } = await import('path');
    const { mkdir: mkd, writeFile: wf, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    let textContent = '';
    // Sanitize filename to prevent path traversal (strip path separators, .., null bytes)
    const rawName = req.file.originalname || 'upload';
    const filename = rawName
      .replace(/[\x00-\x1f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.\.+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 200) || 'upload';
    const ext = filename.split('.').pop()?.toLowerCase();

    if (ext === 'txt' || ext === 'md') {
      textContent = req.file.buffer.toString('utf-8');
    } else if (ext === 'docx') {
      // Extract text from docx — unzip the archive and parse word/document.xml
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(req.file.buffer);
        const docEntry = zip.getEntry('word/document.xml');
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8');
          // Extract text from <w:t> tags, preserving paragraph breaks
          const paragraphs: string[] = [];
          const paraMatches = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
          for (const para of paraMatches) {
            const textParts = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
            if (textParts) {
              const line = textParts.map(t => t.replace(/<[^>]+>/g, '')).join('');
              if (line.trim()) paragraphs.push(line);
            }
          }
          textContent = paragraphs.join('\n\n');
          if (!textContent.trim()) {
            textContent = '[Empty document — no text found in .docx]';
          }
        } else {
          textContent = '[Could not find document content in .docx — file may be corrupted]';
        }
      } catch (e) {
        textContent = '[Failed to parse .docx file: ' + String(e) + ']';
      }
    }

    // Save the file to project upload directory
    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const uploadDir = j(baseDir, 'workspace', 'projects', projectSlug, 'uploads');
    await mkd(uploadDir, { recursive: true });
    await wf(j(uploadDir, filename), req.file.buffer);

    const wordCount = textContent.split(/\s+/).filter(Boolean).length;
    const LARGE_THRESHOLD = 15000; // 15K words = "large" manuscript
    const isLarge = wordCount > LARGE_THRESHOLD;

    // For large manuscripts (15K+ words): save to centralized document library
    // The full text stays on disk — only smart excerpts go into AI context
    if (isLarge) {
      const docsDir = j(baseDir, 'workspace', 'documents');
      await mkd(docsDir, { recursive: true });

      // Save the extracted text to the library for fast access at execution time
      const textFilename = filename.replace(/\.\w+$/, '.txt');
      await wf(j(docsDir, textFilename), textContent);
      // Save original file too
      await wf(j(docsDir, filename), req.file.buffer);

      // Save metadata
      const metaPath = j(docsDir, 'metadata.json');
      let metadata: Record<string, any> = {};
      if (ex(metaPath)) {
        try { metadata = JSON.parse(await rf(metaPath, 'utf-8')); } catch { /* ok */ }
      }
      metadata[textFilename] = {
        wordCount,
        uploadedAt: new Date().toISOString(),
        size: textContent.length,
        originalFilename: filename,
        projectId: project.id,
      };
      await wf(metaPath, JSON.stringify(metadata, null, 2));

      console.log(`  📚 Large manuscript saved to document library: ${textFilename} (${wordCount.toLocaleString()} words)`);
    }

    // Store upload info in project context
    if (!project.context.uploads) project.context.uploads = [];
    project.context.uploads.push({
      filename,
      wordCount,
      preview: textContent.substring(0, 500),
      uploadedAt: new Date().toISOString(),
      isLarge,
      libraryFile: isLarge ? filename.replace(/\.\w+$/, '.txt') : undefined,
    });

    // Store document content for AI steps
    // For large documents: store reference path (read from disk at execution time)
    // For small documents: store inline (same as before)
    if (isLarge) {
      // Store the path for on-demand reading at execution time
      const textFilename = filename.replace(/\.\w+$/, '.txt');
      project.context.documentLibraryFile = j(baseDir, 'workspace', 'documents', textFilename);
      project.context.documentWordCount = wordCount;
      // Store a brief excerpt for the system context (so AI knows what it's working with)
      if (!project.context.uploadedContent) project.context.uploadedContent = '';
      project.context.uploadedContent += `\n\n--- Uploaded: ${filename} (${wordCount.toLocaleString()} words — full text loaded from document library) ---\n`;
      project.context.uploadedContent += textContent.substring(0, 2000);
      project.context.uploadedContent += `\n\n[...${wordCount.toLocaleString()} words total — smart excerpt will be injected at execution time...]\n`;
    } else {
      // Small file: store inline as before
      if (!project.context.uploadedContent) project.context.uploadedContent = '';
      project.context.uploadedContent += `\n\n--- Uploaded: ${filename} ---\n${textContent}`;
    }

    res.json({
      success: true,
      filename,
      wordCount,
      preview: textContent.substring(0, 200),
      isLarge,
      savedToLibrary: isLarge,
    });
  });

  // ── Workspace File Management ──

  app.get('/api/workspace/stats', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readdir: rd, stat: st } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const workspaceDir = j(baseDir, 'workspace');

    const stats: Record<string, { files: number; size: number; items?: string[] }> = {};

    async function scanDir(name: string, dirPath: string, listItems = true) {
      if (!ex(dirPath)) { stats[name] = { files: 0, size: 0 }; return; }
      try {
        const entries = await rd(dirPath, { recursive: true });
        let totalSize = 0;
        let fileCount = 0;
        const items: string[] = [];
        for (const entry of entries) {
          try {
            const fp = j(dirPath, String(entry));
            const s = await st(fp);
            if (s.isFile()) { fileCount++; totalSize += s.size; if (listItems) items.push(String(entry)); }
          } catch { /* skip */ }
        }
        stats[name] = { files: fileCount, size: totalSize, items: listItems ? items.slice(0, 50) : undefined };
      } catch { stats[name] = { files: 0, size: 0 }; }
    }

    await Promise.all([
      scanDir('projects', j(workspaceDir, 'projects')),
      scanDir('research', j(workspaceDir, 'research')),
      scanDir('exports', j(workspaceDir, 'exports')),
      scanDir('agent', j(workspaceDir, '.agent'), false),
      scanDir('memory', j(workspaceDir, '.memory'), false),
      scanDir('audio', j(workspaceDir, '.audio')),
    ]);

    const totalFiles = Object.values(stats).reduce((sum, s) => sum + s.files, 0);
    const totalSize = Object.values(stats).reduce((sum, s) => sum + s.size, 0);
    res.json({ totalFiles, totalSize, totalSizeFormatted: (totalSize / 1048576).toFixed(1) + ' MB', breakdown: stats });
  });

  app.delete('/api/workspace/clean', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { rm } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const workspaceDir = j(baseDir, 'workspace');

    const target = String(req.query.target || '');
    const allowed = ['projects', 'research', 'exports', 'audio'];
    if (!allowed.includes(target)) {
      return res.status(400).json({ error: `Target must be one of: ${allowed.join(', ')}` });
    }

    const dirName = target === 'audio' ? '.audio' : target;
    const targetDir = j(workspaceDir, dirName);
    let deleted = 0;

    if (ex(targetDir)) {
      try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(targetDir);
        deleted = entries.length;
        await rm(targetDir, { recursive: true });
      } catch (e) {
        return res.status(500).json({ error: String(e) });
      }
    }

    res.json({ success: true, target, deleted });
  });

  // ── Project File Listing ──

  app.get('/api/projects/:id/files', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { join: j } = await import('path');
    const { readdir: rd, stat: st } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);

    if (!ex(projectDir)) return res.json({ files: [] });

    try {
      const entries = await rd(projectDir);
      const files: Array<{ name: string; size: number; type: string }> = [];
      for (const entry of entries) {
        if (entry === 'uploads') continue; // skip uploads subfolder
        const fullPath = j(projectDir, entry);
        const info = await st(fullPath);
        if (!info.isFile()) continue;
        const ext = entry.split('.').pop()?.toLowerCase() || '';
        files.push({ name: entry, size: info.size, type: ext });
      }
      // Sort: manuscript files first, then by name
      files.sort((a, b) => {
        const aManuscript = a.name.startsWith('manuscript') ? 0 : 1;
        const bManuscript = b.name.startsWith('manuscript') ? 0 : 1;
        if (aManuscript !== bManuscript) return aManuscript - bManuscript;
        return a.name.localeCompare(b.name);
      });
      res.json({ files, projectDir: projectSlug });
    } catch {
      res.json({ files: [] });
    }
  });

  // ── Project File Download ──

  app.get('/api/projects/:id/download/:filename', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { join: j, resolve: rv } = await import('path');
    const { existsSync: ex } = await import('fs');

    const filename = String(req.params.filename);
    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);
    const filePath = safePath(projectDir, filename);

    // Security: ensure the resolved path is inside the project directory
    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Set content disposition for download
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      md: 'text/markdown',
      txt: 'text/plain',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      html: 'text/html',
      json: 'application/json',
      mp3: 'audio/mpeg',
      epub: 'application/epub+zip',
    };
    res.setHeader('Content-Type', mimeTypes[ext || ''] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  });

  // ── Export single file as DOCX ──
  app.post('/api/projects/:id/export-docx', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    const { join: j, resolve: rv } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);
    const sourcePath = safePath(projectDir, String(filename));

    if (!sourcePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    if (!ex(sourcePath)) {
      return res.status(404).json({ error: 'Source file not found' });
    }

    try {
      const content = await rf(sourcePath, 'utf-8');
      const docxName = String(filename).replace(/\.md$/i, '.docx');
      const docxBuffer = await generateDocxBuffer({
        title: project.title,
        author: 'Author',
        content,
      });
      await wf(j(projectDir, docxName), docxBuffer);
      res.json({
        success: true,
        downloadUrl: `/api/projects/${req.params.id}/download/${encodeURIComponent(docxName)}`,
      });
    } catch (err) {
      res.status(500).json({ error: 'DOCX export failed: ' + String(err) });
    }
  });

  // ── Compile Project Files (combine all output files into one document) ──

  app.post('/api/projects/:id/compile', async (req: Request, res: Response) => {
    const engine = gateway.getProjectEngine?.();
    if (!engine) return res.status(503).json({ error: 'Project engine not initialized' });
    const project = engine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { join: j } = await import('path');
    const { readdir: rd, readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);

    if (!ex(projectDir)) return res.status(404).json({ error: 'No project files found' });

    try {
      const entries = await rd(projectDir);
      const sectionContents: string[] = [];
      const isChapterProject = project.type === 'book-production' || project.type === 'novel-pipeline';
      const isDeepRevision = project.type === 'deep-revision';
      let revisionReportContent: string | null = null;  // Analysis reports saved separately

      // ── Deep Revision compile: use the FINAL revision-apply step output as the book ──
      // Without this branch, users got 21 concatenated analysis reports instead of the revised manuscript.
      if (isDeepRevision) {
        // Find the last completed revision_apply step (the final polish pass).
        const applySteps = project.steps
          .filter((s: any) => s.phase === 'revision_apply' && s.status === 'completed');
        const finalApplyStep = applySteps[applySteps.length - 1];

        if (finalApplyStep) {
          const expectedFile = `${(finalApplyStep as any).id}-${(finalApplyStep as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          const fullPath = j(projectDir, expectedFile);
          if (ex(fullPath)) {
            const raw = await rf(fullPath, 'utf-8');
            // Strip the leading "# <label>" heading we saved with so downstream doesn't double-wrap it.
            const content = raw.replace(/^# .+\n\n/, '');
            sectionContents.push(content);
            console.log(`  [deep-revision] Using "${finalApplyStep.label}" output as the compiled revised manuscript (${content.length} chars).`);
          }
        }

        // Gather all the analysis reports (non-apply completed steps) into a separate report file.
        const analysisSteps = project.steps.filter((s: any) =>
          s.status === 'completed' && s.phase !== 'revision_apply'
        );
        if (analysisSteps.length > 0) {
          const reportSections: string[] = [];
          for (const as of analysisSteps) {
            const filename = `${(as as any).id}-${(as as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
            const fullPath = j(projectDir, filename);
            if (ex(fullPath)) {
              const raw = await rf(fullPath, 'utf-8');
              reportSections.push(raw.startsWith('# ') ? raw : `## ${as.label}\n\n${raw}`);
            }
          }
          if (reportSections.length > 0) {
            revisionReportContent = `# ${project.title} — Revision Report\n\n` +
              `This report contains the full diagnostic analysis from ${reportSections.length} revision passes. ` +
              `Your revised manuscript is saved separately as \`manuscript.md\` / \`manuscript.docx\` / \`manuscript.epub\`.\n\n---\n\n` +
              reportSections.join('\n\n---\n\n');
          }
        }

        // If no revision_apply step has run yet, fall through to the universal path below,
        // but warn the caller so the dashboard can surface it.
        if (sectionContents.length === 0) {
          return res.status(400).json({
            error: 'Revised manuscript not ready',
            detail: 'The revision-apply steps have not completed yet. Finish running the project (or trigger the "Apply line-level revisions" step) before compiling. The analysis-only reports alone are not a revised book.',
          });
        }
      }

      if (isChapterProject) {
        // ── Chapter-based compile (book-production / novel-pipeline) ──
        const writingSteps = project.steps
          .filter((s: any) => s.phase === 'writing' && s.status === 'completed')
          .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

        for (const ws of writingSteps) {
          const expectedFile = `${(ws as any).id}-${(ws as any).label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          const fullPath = j(projectDir, expectedFile);
          if (ex(fullPath)) {
            const raw = await rf(fullPath, 'utf-8');
            const content = raw.replace(/^# .+\n\n/, '');
            sectionContents.push(`## Chapter ${(ws as any).chapterNumber || sectionContents.length + 1}\n\n${content}`);
          }
        }

        // Fallback: find chapter files by filename pattern
        if (sectionContents.length === 0) {
          const chapterFiles = entries
            .filter(f => f.match(/write-chapter-\d+\.md$/))
            .sort((a, b) => {
              const numA = parseInt(a.match(/chapter-(\d+)/)?.[1] || '0');
              const numB = parseInt(b.match(/chapter-(\d+)/)?.[1] || '0');
              return numA - numB;
            });
          for (const cf of chapterFiles) {
            const raw = await rf(j(projectDir, cf), 'utf-8');
            const content = raw.replace(/^# .+\n\n/, '');
            const chNum = parseInt(cf.match(/chapter-(\d+)/)?.[1] || '0');
            sectionContents.push(`## Chapter ${chNum}\n\n${content}`);
          }
        }
      }

      // ── Universal compile: collect ALL step output .md files ──
      if (sectionContents.length === 0) {
        // Get completed steps in order to determine file sequence
        const completedSteps = project.steps
          .filter((s: any) => s.status === 'completed')
          .map((s: any) => ({
            id: s.id,
            label: s.label,
            filename: `${s.id}-${s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
          }));

        // First: collect files that match completed steps (preserves step order)
        const usedFiles = new Set<string>();
        for (const cs of completedSteps) {
          const fullPath = j(projectDir, cs.filename);
          if (ex(fullPath)) {
            const raw = await rf(fullPath, 'utf-8');
            sectionContents.push(raw.startsWith('# ') ? raw : `## ${cs.label}\n\n${raw}`);
            usedFiles.add(cs.filename);
          }
        }

        // Second: pick up any other .md files not already included (research files, extras)
        const remainingMd = entries
          .filter(f => f.endsWith('.md') && !usedFiles.has(f) && f !== 'manuscript.md' && f !== 'compiled-output.md')
          .sort();
        for (const mf of remainingMd) {
          const raw = await rf(j(projectDir, mf), 'utf-8');
          sectionContents.push(raw);
          usedFiles.add(mf);
        }
      }

      if (sectionContents.length === 0) {
        return res.status(400).json({ error: 'No output files found to compile' });
      }

      // Build compiled document
      const compiledMd = `# ${project.title}\n\n` + sectionContents.join('\n\n---\n\n');
      // Deep-revision produces a real revised manuscript, so name it 'manuscript' (not 'compiled-output').
      const outputBaseName = (isChapterProject || isDeepRevision) ? 'manuscript' : 'compiled-output';
      await wf(j(projectDir, `${outputBaseName}.md`), compiledMd, 'utf-8');

      // For revision projects, save the diagnostic report as a companion file so users can download both.
      if (isDeepRevision && revisionReportContent) {
        await wf(j(projectDir, 'revision-report.md'), revisionReportContent, 'utf-8');
      }

      // Get persona info for metadata
      const personaId = (project as any).personaId;
      const persona = personaId ? services.personas?.get(personaId) : null;
      const authorName = persona?.penName || 'AuthorClaw';

      const exportFiles = [`${outputBaseName}.md`];

      // Generate DOCX
      try {
        const docxBuffer = await generateDocxBuffer({
          title: project.title,
          author: authorName,
          content: compiledMd,
          authorBio: persona?.bio,
          alsoBy: persona?.alsoBy,
        });
        await wf(j(projectDir, `${outputBaseName}.docx`), docxBuffer);
        exportFiles.push(`${outputBaseName}.docx`);
      } catch { /* DOCX generation is non-fatal */ }

      // Generate EPUB
      try {
        const epubBuffer = await generateEpubBuffer({
          title: project.title,
          author: authorName,
          content: compiledMd,
          description: project.description,
          authorBio: persona?.bio,
        });
        await wf(j(projectDir, `${outputBaseName}.epub`), epubBuffer);
        exportFiles.push(`${outputBaseName}.epub`);
      } catch { /* EPUB generation is non-fatal */ }

      const totalWords = compiledMd.split(/\s+/).length;
      // Report the revision-report companion file too, so the dashboard can offer a download link.
      if (isDeepRevision && revisionReportContent) exportFiles.push('revision-report.md');
      res.json({
        success: true,
        sections: sectionContents.length,
        totalWords,
        files: exportFiles,
        outputName: outputBaseName,
        kind: isDeepRevision ? 'revised-manuscript' : (isChapterProject ? 'manuscript' : 'compiled-output'),
        hasRevisionReport: isDeepRevision && !!revisionReportContent,
      });
    } catch (err) {
      res.status(500).json({ error: 'Compile failed: ' + String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Context Engine & Continuity Checker
  // ═══════════════════════════════════════════════════════════

  // Get project context (summaries + entities)
  app.get('/api/projects/:id/context', async (req: Request, res: Response) => {
    try {
      const engine = gateway.getProjectEngine?.();
      if (!engine) return res.status(503).json({ error: 'Not initialized' });
      const project = engine.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const contextEngine = services.contextEngine;
      if (!contextEngine) return res.json({ summaries: [], entities: [] });

      const ctx = await contextEngine.loadContext(req.params.id);
      res.json({ summaries: ctx.summaries, entities: ctx.entities });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Run continuity check (async — responds immediately, emits progress via socket)
  app.post('/api/projects/:id/continuity-check', async (req: Request, res: Response) => {
    try {
      const engine = gateway.getProjectEngine?.();
      if (!engine) return res.status(503).json({ error: 'Not initialized' });
      const project = engine.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const contextEngine = services.contextEngine;
      if (!contextEngine) return res.status(503).json({ error: 'Context engine not available' });

      const aiCompleteFn = (request: any) => services.aiRouter.complete(request);
      const aiSelectFn = (taskType: string) => services.aiRouter.selectProvider(taskType);

      // Run asynchronously, respond immediately
      res.json({ status: 'started', projectId: req.params.id });

      contextEngine.runContinuityCheck(
        req.params.id,
        aiCompleteFn,
        aiSelectFn,
        (msg: string) => {
          // Emit progress via socket if available
          try { (gateway as any).io?.emit?.('continuity-progress', { projectId: req.params.id, message: msg }); } catch {}
        }
      ).then((report: any) => {
        try { (gateway as any).io?.emit?.('continuity-complete', { projectId: req.params.id, report }); } catch {}
      }).catch((err: any) => {
        try { (gateway as any).io?.emit?.('continuity-error', { projectId: req.params.id, error: err.message }); } catch {}
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get stored continuity report
  app.get('/api/projects/:id/continuity-report', async (req: Request, res: Response) => {
    try {
      const contextEngine = services.contextEngine;
      if (!contextEngine) return res.json({ report: null });

      const report = contextEngine.getReport(req.params.id);
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Autonomous Heartbeat Mode
  // ═══════════════════════════════════════════════════════════

  // Get autonomous mode status
  app.get('/api/autonomous/status', (_req: Request, res: Response) => {
    res.json(services.heartbeat.getAutonomousStatus());
  });

  // Enable autonomous mode
  app.post('/api/autonomous/enable', (_req: Request, res: Response) => {
    services.heartbeat.enableAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Disable autonomous mode
  app.post('/api/autonomous/disable', (_req: Request, res: Response) => {
    services.heartbeat.disableAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Pause autonomous mode
  app.post('/api/autonomous/pause', (_req: Request, res: Response) => {
    services.heartbeat.pauseAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Resume autonomous mode
  app.post('/api/autonomous/resume', (_req: Request, res: Response) => {
    services.heartbeat.resumeAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Update autonomous config (interval, max steps, quiet hours)
  app.post('/api/autonomous/config', (req: Request, res: Response) => {
    const { intervalMinutes, maxStepsPerWake, quietHoursStart, quietHoursEnd } = req.body;
    services.heartbeat.updateAutonomousConfig({
      intervalMinutes, maxStepsPerWake, quietHoursStart, quietHoursEnd,
    });
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // ── Idle Task Queue (CRUD) + History ──

  // Get task queue (user-configurable) + completed task history
  app.get('/api/autonomous/idle-tasks', async (_req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { readdir, readFile, stat, writeFile, mkdir } = await import('fs/promises');
      const { existsSync } = await import('fs');

      // Load task queue from config
      const configPath = j(baseDir, 'workspace', '.config', 'idle-tasks.json');
      let queue: any[] = [];
      if (existsSync(configPath)) {
        const raw = await readFile(configPath, 'utf-8');
        queue = JSON.parse(raw).tasks || [];
      } else {
        // Initialize with defaults
        const { DEFAULT_IDLE_TASKS } = await import('../services/idle-tasks-defaults.js');
        queue = DEFAULT_IDLE_TASKS;
        const configDir = j(baseDir, 'workspace', '.config');
        await mkdir(configDir, { recursive: true });
        await writeFile(configPath, JSON.stringify({ tasks: queue }, null, 2), 'utf-8');
      }

      // Load completed task history from .agent directory
      const agentDir = j(baseDir, 'workspace', '.agent');
      const history: any[] = [];
      if (existsSync(agentDir)) {
        const files = await readdir(agentDir);
        const idleFiles = files.filter(f => f.startsWith('idle-') && f.endsWith('.md')).sort().reverse();
        for (const file of idleFiles.slice(0, 20)) {
          const content = await readFile(j(agentDir, file), 'utf-8');
          const fileStat = await stat(j(agentDir, file));
          const titleMatch = content.match(/^# (.+)$/m);
          history.push({
            file,
            title: titleMatch ? titleMatch[1] : file,
            preview: content.substring(0, 300),
            date: fileStat.mtime.toISOString(),
            size: fileStat.size,
          });
        }
      }

      res.json({ queue, history });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load idle tasks: ' + String(err) });
    }
  });

  // Save entire task queue (replace all)
  app.put('/api/autonomous/idle-tasks', async (req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { writeFile, mkdir } = await import('fs/promises');
      const { tasks } = req.body;
      if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
      const configDir = j(baseDir, 'workspace', '.config');
      await mkdir(configDir, { recursive: true });
      await writeFile(j(configDir, 'idle-tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf-8');
      res.json({ success: true, count: tasks.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save idle tasks: ' + String(err) });
    }
  });

  // Add a single task
  app.post('/api/autonomous/idle-tasks', async (req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { readFile, writeFile, mkdir } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const { label, prompt, enabled } = req.body;
      if (!label || !prompt) return res.status(400).json({ error: 'label and prompt are required' });

      const configPath = j(baseDir, 'workspace', '.config', 'idle-tasks.json');
      let tasks: any[] = [];
      if (existsSync(configPath)) {
        tasks = JSON.parse(await readFile(configPath, 'utf-8')).tasks || [];
      }
      tasks.push({ label, prompt, enabled: enabled !== false });
      const configDir = j(baseDir, 'workspace', '.config');
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ tasks }, null, 2), 'utf-8');
      res.status(201).json({ success: true, task: tasks[tasks.length - 1], index: tasks.length - 1 });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add idle task: ' + String(err) });
    }
  });

  // Delete a task by index
  app.delete('/api/autonomous/idle-tasks/:index', async (req: Request, res: Response) => {
    try {
      const { join: j } = await import('path');
      const { readFile, writeFile } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const idx = parseInt(String(req.params.index));
      const configPath = j(baseDir, 'workspace', '.config', 'idle-tasks.json');
      if (!existsSync(configPath)) return res.status(404).json({ error: 'No idle tasks configured' });

      const tasks: any[] = JSON.parse(await readFile(configPath, 'utf-8')).tasks || [];
      if (idx < 0 || idx >= tasks.length) return res.status(404).json({ error: 'Task index out of range' });
      const removed = tasks.splice(idx, 1);
      await writeFile(configPath, JSON.stringify({ tasks }, null, 2), 'utf-8');
      res.json({ success: true, removed: removed[0], remaining: tasks.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete idle task: ' + String(err) });
    }
  });

  // Download completed idle task file
  app.get('/api/autonomous/idle-tasks/history/:filename', async (req: Request, res: Response) => {
    try {
      const { join: j, resolve: r } = await import('path');
      const { readFile } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const agentDir = j(baseDir, 'workspace', '.agent');
      const filePath = safePath(agentDir, String(req.params.filename));
      if (!filePath) {
        return res.status(403).json({ error: 'Path traversal blocked' });
      }
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: 'Idle task file not found' });
      }
      const content = await readFile(filePath, 'utf-8');
      res.json({ content, filename: req.params.filename });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read idle task: ' + String(err) });
    }
  });

  // ── Agent Journal ──
  app.get('/api/agent/journal', (_req: Request, res: Response) => {
    res.json({ journal: services.heartbeat.getJournal() });
  });

  app.get('/api/agent/status', (_req: Request, res: Response) => {
    const autonomousStatus = services.heartbeat.getAutonomousStatus();
    const stats = services.heartbeat.getStats();
    res.json({
      ...autonomousStatus,
      todayWords: stats.todayWords,
      dailyWordGoal: stats.dailyWordGoal,
      streak: stats.streak,
      goalPercent: stats.goalPercent,
    });
  });

  // ── Author OS tools status ──
  app.get('/api/author-os/status', (_req: Request, res: Response) => {
    if (!services.authorOS) {
      return res.json({ tools: [] });
    }
    res.json({ tools: services.authorOS.getStatus() });
  });

  // ── Native Export: Markdown → Word/HTML (no external tools needed) ──
  app.post('/api/author-os/format', async (req: Request, res: Response) => {
    const { inputFile, title, author, formats, outputDir } = req.body;
    if (!inputFile) {
      return res.status(400).json({ error: 'inputFile required' });
    }

    const { join: j, resolve: r, basename: bn } = await import('path');
    const { existsSync: ex } = await import('fs');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');

    const workspaceDir = j(baseDir, 'workspace');

    // Search for the file in workspace → projects → baseDir
    const searchPaths = [
      r(workspaceDir, inputFile),
      r(workspaceDir, 'projects', inputFile),
      r(baseDir, inputFile),
    ];
    // Also search recursively in workspace/projects/*/
    try {
      const { readdirSync } = await import('fs');
      const projectsDir = j(workspaceDir, 'projects');
      if (ex(projectsDir)) {
        for (const sub of readdirSync(projectsDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            searchPaths.push(r(projectsDir, sub.name, inputFile));
          }
        }
      }
    } catch { /* ok */ }

    let resolvedInput = '';
    for (const candidate of searchPaths) {
      if (ex(candidate)) { resolvedInput = candidate; break; }
    }

    if (!resolvedInput) {
      return res.status(404).json({ error: 'Input file not found: ' + inputFile + '. Use /files to see available files.' });
    }

    // Security: must be within project
    const resolvedBase = r(baseDir);
    if (!resolvedInput.startsWith(resolvedBase + path.sep) && resolvedInput !== resolvedBase) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    // Security: outputDir must stay within workspace
    const exportDir = safePath(workspaceDir, outputDir || 'exports');
    if (!exportDir) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    await mkd(exportDir, { recursive: true });

    const content = await rf(resolvedInput, 'utf-8');
    const docTitle = title || bn(resolvedInput, '.md');
    const docAuthor = author || 'AuthorClaw';
    const requestedFormats = formats || ['docx'];
    const results: string[] = [];

    try {
      // ── Word Export (native, using shared docx utility) ──
      if (requestedFormats.includes('docx') || requestedFormats.includes('all')) {
        const buffer = await generateDocxBuffer({ title: docTitle, author: docAuthor, content });
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.docx');
        await wf(outPath, buffer);
        results.push(outPath);
      }

      // ── HTML Export (native) ──
      if (requestedFormats.includes('html') || requestedFormats.includes('all')) {
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${docTitle}</title>`;
        html += `<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.8;color:#333;}h1{text-align:center;border-bottom:2px solid #333;padding-bottom:10px;}h2{margin-top:2em;border-bottom:1px solid #ccc;}</style></head><body>`;
        html += `<h1>${docTitle}</h1><p style="text-align:center;"><em>by ${docAuthor}</em></p><hr>`;
        // Basic markdown → HTML
        const htmlContent = content
          .replace(/^### (.*$)/gm, '<h3>$1</h3>')
          .replace(/^## (.*$)/gm, '<h2>$1</h2>')
          .replace(/^# (.*$)/gm, '<h1>$1</h1>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/\n\n/g, '</p><p>')
          .replace(/\n/g, '<br>');
        html += `<p>${htmlContent}</p></body></html>`;
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.html');
        await wf(outPath, html);
        results.push(outPath);
      }

      // ── Plain Text Export ──
      if (requestedFormats.includes('txt') || requestedFormats.includes('all')) {
        const plain = content.replace(/^#{1,3}\s/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.txt');
        await wf(outPath, `${docTitle}\nby ${docAuthor}\n\n${plain}`);
        results.push(outPath);
      }

      res.json({ success: true, files: results, message: `Exported ${results.length} file(s) to ${exportDir}` });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Export failed: ' + String(error) });
    }
  });

  // ── Tool Ingestion: AI reads code, generates SKILL.md ──
  app.post('/api/tools/ingest', async (req: Request, res: Response) => {
    const { code, toolName, filePath, category } = req.body;

    if (!code && !filePath) {
      return res.status(400).json({ error: 'Provide "code" (source string) or "filePath" (relative to Author OS)' });
    }

    let sourceCode = code;

    if (filePath && !code) {
      const { readFile: rf } = await import('fs/promises');
      const { existsSync: ex } = await import('fs');
      const { resolve: r } = await import('path');

      const authorOSPath = services.authorOS?.getBasePath?.();
      if (!authorOSPath) {
        return res.status(400).json({ error: 'Author OS not mounted. Provide code directly.' });
      }

      const resolvedPath = safePath(authorOSPath, filePath);
      if (!resolvedPath) {
        return res.status(403).json({ error: 'Path traversal blocked' });
      }
      if (!ex(resolvedPath)) {
        return res.status(404).json({ error: `File not found: ${filePath}` });
      }

      sourceCode = await rf(resolvedPath, 'utf-8');
    }

    const targetCategory = category || 'author';
    const ingestPrompt = `You are analyzing source code to create an AuthorClaw SKILL.md file.

Tool name hint: ${toolName || '(infer from code)'}
Target category: ${targetCategory}

Analyze the following source code and generate a complete SKILL.md file with:
1. YAML frontmatter (name, description, triggers, permissions)
2. Detailed usage instructions
3. Input/output documentation
4. Example commands or workflows
5. How AuthorClaw should invoke or reference the tool

Return ONLY the complete SKILL.md content (starting with ---).

Source code:
\`\`\`
${sourceCode.substring(0, 15000)}
\`\`\``;

    try {
      const provider = services.aiRouter.selectProvider('general');
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a technical documentation expert. Generate AuthorClaw SKILL.md files from source code analysis.',
        messages: [{ role: 'user', content: ingestPrompt }],
        maxTokens: 4096,
        temperature: 0.3,
      });

      res.json({
        skillMd: result.text,
        suggestedPath: `skills/${targetCategory}/${(toolName || 'unknown-tool').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/SKILL.md`,
        provider: result.provider,
        tokens: result.tokensUsed,
      });
    } catch (error) {
      res.status(500).json({ error: 'AI analysis failed: ' + String(error) });
    }
  });

  // ── Tool Ingestion: Save generated SKILL.md ──
  app.post('/api/tools/ingest/save', async (req: Request, res: Response) => {
    const { skillMd, skillPath } = req.body;
    if (!skillMd || !skillPath) {
      return res.status(400).json({ error: 'skillMd and skillPath required' });
    }

    const { join: j, resolve: r } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');

    const skillsBase = j(baseDir, 'skills');
    const fullPath = safePath(skillsBase, skillPath.replace(/^skills[/\\]?/, ''));
    if (!fullPath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    try {
      await mkdir(j(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, skillMd, 'utf-8');

      await services.skills.loadAll();

      res.json({
        success: true,
        path: skillPath,
        totalSkills: services.skills.getLoadedCount(),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save skill: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Author Personas
  // ═══════════════════════════════════════════════════════════
  // IMPORTANT: Static routes (/generate) must be defined BEFORE parameterized routes (/:id)
  // to prevent Express from matching "generate" as an :id parameter.

  app.get('/api/personas', (_req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    res.json({ personas: personas.list() });
  });

  // AI-assisted full persona generation (static route — must precede /:id)
  app.post('/api/personas/generate', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const { genre, description } = req.body;
    if (!genre) return res.status(400).json({ error: 'genre is required' });

    try {
      const provider = services.aiRouter?.selectProvider('general');
      if (!provider) return res.status(503).json({ error: 'No AI provider available. Configure an API key in Settings first.' });
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a publishing industry expert. Return ONLY valid JSON, no markdown.',
        messages: [{
          role: 'user' as const,
          content: `Create an author persona for someone who writes ${genre}. ${description || ''}\n\nReturn JSON with these fields:\n- penName: a believable pen name for this genre\n- genre: the main genre\n- subGenre: a specific subgenre\n- voiceDescription: 1-2 sentences describing their writing voice/style\n- styleMarkers: array of 3-5 style descriptors (e.g. "witty dialogue", "slow burn")\n- bio: a 2-3 sentence author bio in third person\n\nReturn ONLY the JSON object.`,
        }],
        maxTokens: 500,
      });
      if (result.text) {
        const cleaned = result.text.replace(/```json\n?|```\n?/g, '').trim();
        const generated = JSON.parse(cleaned);
        const persona = await personas.create({
          penName: generated.penName || 'New Author',
          genre: generated.genre || genre,
          subGenre: generated.subGenre || '',
          voiceDescription: generated.voiceDescription || '',
          styleMarkers: generated.styleMarkers || [],
          bio: generated.bio || '',
        });
        res.status(201).json(persona);
      } else {
        res.status(500).json({ error: 'AI returned empty response' });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate persona: ' + String(err) });
    }
  });

  // Create persona (static route — must precede /:id)
  app.post('/api/personas', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const { penName } = req.body;
    if (!penName || typeof penName !== 'string') {
      return res.status(400).json({ error: 'penName is required' });
    }
    try {
      const persona = await personas.create(req.body);
      res.status(201).json(persona);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create persona: ' + String(err) });
    }
  });

  // Parameterized persona routes (/:id)
  app.get('/api/personas/:id', (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const persona = personas.get(req.params.id);
    if (!persona) return res.status(404).json({ error: 'Persona not found' });
    res.json(persona);
  });

  app.put('/api/personas/:id', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    try {
      const updated = await personas.update(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Persona not found' });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update persona: ' + String(err) });
    }
  });

  app.delete('/api/personas/:id', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const deleted = await personas.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Persona not found' });
    res.json({ success: true });
  });

  // AI-assisted bio generation for existing persona
  app.post('/api/personas/:id/generate-bio', async (req: Request, res: Response) => {
    const personas = services.personas;
    if (!personas) return res.status(503).json({ error: 'Persona service not initialized' });
    const persona = personas.get(req.params.id);
    if (!persona) return res.status(404).json({ error: 'Persona not found' });

    try {
      const provider = services.aiRouter?.selectProvider('general');
      if (!provider) return res.status(503).json({ error: 'No AI provider available. Configure an API key in Settings first.' });
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a publishing industry expert who creates compelling author bios.',
        messages: [{
          role: 'user' as const,
          content: `Write a professional author bio for a pen name "${persona.penName}" who writes ${persona.genre}${persona.subGenre ? ' (' + persona.subGenre + ')' : ''}. Style: ${persona.voiceDescription || 'engaging and professional'}. Style markers: ${persona.styleMarkers.join(', ') || 'none specified'}. Write in third person, 2-3 sentences, suitable for the back of a book. Return ONLY the bio text.`,
        }],
        maxTokens: 300,
      });
      if (result.text) {
        await personas.update(persona.id, { bio: result.text.trim() });
        res.json({ bio: result.text.trim() });
      } else {
        res.status(500).json({ error: 'AI returned empty response' });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate bio: ' + String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Internet Research (web search + content extraction)
  // ═══════════════════════════════════════════════════════════

  // ── Research Domain Management ──
  app.get('/api/research/domains', (_req: Request, res: Response) => {
    const research = services.research;
    if (!research) {
      return res.status(503).json({ error: 'Research gate not initialized' });
    }
    res.json({ domains: research.getAllowedDomains() });
  });

  app.post('/api/research/domains', async (req: Request, res: Response) => {
    const research = services.research;
    if (!research) {
      return res.status(503).json({ error: 'Research gate not initialized' });
    }
    const { domains } = req.body;
    if (!Array.isArray(domains)) {
      return res.status(400).json({ error: 'domains must be an array of strings' });
    }
    try {
      await research.setDomains(domains);
      res.json({ success: true, count: research.getAllowedDomainCount() });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save domains: ' + String(err) });
    }
  });

  app.post('/api/research', async (req: Request, res: Response) => {
    const research = services.research;
    if (!research) {
      return res.status(503).json({ error: 'Research service not initialized' });
    }
    const { query, maxResults } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query required' });
    }

    try {
      // Search
      const searchResults = await research.search(query, maxResults || 5);

      // If search returned an error, pass it through
      if (searchResults.error && searchResults.results.length === 0) {
        return res.json({
          results: [],
          blocked: searchResults.blocked,
          totalFound: 0,
          error: searchResults.error,
        });
      }

      // Fetch and extract top 3 allowed results
      const enriched = await Promise.all(
        searchResults.results.slice(0, 3).map(async (r: any) => {
          const extracted = await research.fetchAndExtract(r.url);
          return {
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            fullText: extracted.ok ? extracted.text?.substring(0, 5000) : undefined,
          };
        })
      );

      res.json({
        results: enriched,
        blocked: searchResults.blocked,
        totalFound: searchResults.results.length,
        error: searchResults.error,
      });
    } catch (error) {
      res.status(500).json({ error: 'Research failed: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Image Generation (Together AI + OpenAI)
  // ═══════════════════════════════════════════════════════════

  // Generate an image from a text prompt
  app.post('/api/images/generate', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });

    const { prompt, provider, width, height, style } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    try {
      const result = await imageGen.generate(prompt, { provider, width, height, style });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Image generation failed: ' + String(err) });
    }
  });

  // Generate a book cover
  app.post('/api/images/book-cover', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });

    const { title, author, genre, description, style } = req.body;
    if (!description) {
      return res.status(400).json({ error: 'description is required' });
    }

    try {
      const result = await imageGen.generateBookCover({
        title: title || 'Untitled',
        author: author || 'AuthorClaw',
        genre: genre || 'fiction',
        description,
        style,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Book cover generation failed: ' + String(err) });
    }
  });

  // Check available image providers
  app.get('/api/images/providers', async (_req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });
    const providers = await imageGen.getAvailableProviders();
    res.json({ providers });
  });

  // Serve generated images
  app.get('/api/images/:filename', async (req: Request, res: Response) => {
    const imageGen = gateway.getImageGen?.();
    if (!imageGen) return res.status(503).json({ error: 'Image generation service not initialized' });

    const { existsSync: ex } = await import('fs');
    const fname = String(req.params.filename);
    const imageDir = imageGen.getImageDir();
    const filePath = safePath(imageDir, fname);

    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath) || !fname.match(/^cover-[a-f0-9]+\.png$/)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.sendFile(filePath);
  });

  // ═══════════════════════════════════════════════════════════
  // TTS / Audio (Microsoft Edge TTS — free neural voices)
  // ═══════════════════════════════════════════════════════════

  // Generate audio from text
  app.post('/api/audio/generate', async (req: Request, res: Response) => {
    const { text, voice, rate, pitch, volume } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text required' });
    }
    if (text.length > 50000) {
      return res.status(400).json({ error: 'Text too long (max 50,000 chars)' });
    }

    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }

    const result = await services.tts.generate(text, { voice, rate, pitch, volume });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  // Serve generated audio files
  app.get('/api/audio/file/:filename', async (req: Request, res: Response) => {
    const { existsSync: ex } = await import('fs');
    const fname = String(req.params.filename);
    const audioDir = path.join(baseDir, 'workspace', 'audio');
    const filePath = safePath(audioDir, fname);

    // Security: prevent path traversal
    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const ext = fname.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
    };
    res.setHeader('Content-Type', mimeTypes[ext || ''] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  });

  // List available voice presets
  app.get('/api/audio/voices', async (_req: Request, res: Response) => {
    const { TTSService } = await import('../services/tts.js');
    const activeVoice = services.tts?.getActiveVoice() || 'en-US-AriaNeural';
    res.json({
      available: true,
      activeVoice,
      presets: TTSService.VOICE_PRESETS,
    });
  });

  // Get/set the active voice
  app.get('/api/audio/voice', async (_req: Request, res: Response) => {
    res.json({ voice: services.tts?.getActiveVoice() || 'en-US-AriaNeural' });
  });

  app.post('/api/audio/voice', async (req: Request, res: Response) => {
    const { voice } = req.body;
    if (!voice || typeof voice !== 'string') {
      return res.status(400).json({ error: 'voice is required (e.g., "narrator_female" or "en-US-AriaNeural")' });
    }
    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }
    // Resolve preset name to voice ID before saving
    const resolvedVoice = services.tts.resolveVoice(voice);
    await services.tts.setVoice(resolvedVoice);
    res.json({ success: true, voice: resolvedVoice, message: `Voice set to ${resolvedVoice}. This persists across restarts.` });
  });

  // ── Backup & Restore ──

  app.post('/api/backup/create', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { mkdir: mkd, stat: st, readdir: rd, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex, cpSync } = await import('fs');

    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const backupId = `backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const backupsDir = j(baseDir, 'workspace', 'backups');
      const backupDir = j(backupsDir, backupId);
      await mkd(backupDir, { recursive: true });

      // Sources to back up: [sourceRelative, destSubfolder]
      const sources: Array<[string, string]> = [
        [j('workspace', 'projects'), 'projects'],
        [j('workspace', 'personas'), 'personas'],
        [j('workspace', 'memory'), 'memory'],
        [j('config', 'user.json'), 'config/user.json'],
        [j('workspace', 'vault.enc'), 'vault.enc'],
      ];

      for (const [srcRel, destRel] of sources) {
        const src = j(baseDir, srcRel);
        const dest = j(backupDir, destRel);
        if (!ex(src)) continue;
        const srcStat = await st(src).catch(() => null);
        if (!srcStat) continue;
        if (srcStat.isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          // Ensure parent directory exists for file copies
          const destParent = j(dest, '..');
          await mkd(destParent, { recursive: true });
          cpSync(src, dest);
        }
      }

      // Write backup metadata
      await wf(j(backupDir, 'backup-meta.json'), JSON.stringify({
        id: backupId,
        createdAt: now.toISOString(),
      }, null, 2));

      // Calculate total size
      let totalSize = 0;
      async function calcSize(dir: string): Promise<void> {
        if (!ex(dir)) return;
        const entries = await rd(dir, { recursive: true });
        for (const entry of entries) {
          try {
            const fp = j(dir, String(entry));
            const s = await st(fp);
            if (s.isFile()) totalSize += s.size;
          } catch { /* skip */ }
        }
      }
      await calcSize(backupDir);

      res.json({
        success: true,
        backupId,
        path: backupDir,
        sizeKB: Math.round(totalSize / 1024),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Backup creation failed' });
    }
  });

  app.get('/api/backup/list', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readdir: rd, stat: st, readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    try {
      const backupsDir = j(baseDir, 'workspace', 'backups');
      if (!ex(backupsDir)) return res.json({ backups: [] });

      const entries = await rd(backupsDir);
      const backups: Array<{ id: string; createdAt: string; sizeKB: number }> = [];

      for (const entry of entries) {
        const entryPath = j(backupsDir, entry);
        const entryStat = await st(entryPath).catch(() => null);
        if (!entryStat || !entryStat.isDirectory()) continue;

        // Read metadata if available
        let createdAt = entryStat.birthtime.toISOString();
        const metaPath = j(entryPath, 'backup-meta.json');
        if (ex(metaPath)) {
          try {
            const meta = JSON.parse(await rf(metaPath, 'utf-8'));
            if (meta.createdAt) createdAt = meta.createdAt;
          } catch { /* ok */ }
        }

        // Calculate size
        let totalSize = 0;
        try {
          const files = await rd(entryPath, { recursive: true });
          for (const f of files) {
            try {
              const fp = j(entryPath, String(f));
              const s = await st(fp);
              if (s.isFile()) totalSize += s.size;
            } catch { /* skip */ }
          }
        } catch { /* ok */ }

        backups.push({ id: entry, createdAt, sizeKB: Math.round(totalSize / 1024) });
      }

      // Sort newest first
      backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json({ backups });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list backups' });
    }
  });

  app.post('/api/backup/restore/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { mkdir: mkd, stat: st, readdir: rd, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex, cpSync } = await import('fs');

    try {
      const backupId = String(req.params.id);
      const backupsDir = j(baseDir, 'workspace', 'backups');
      const backupDir = j(backupsDir, backupId);

      if (!ex(backupDir)) {
        return res.status(404).json({ error: `Backup '${backupId}' not found` });
      }

      // Create a safety backup first
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const safetyId = `pre-restore-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const safetyDir = j(backupsDir, safetyId);
      await mkd(safetyDir, { recursive: true });

      // Back up current state before restoring
      const currentSources: Array<[string, string]> = [
        [j('workspace', 'projects'), 'projects'],
        [j('workspace', 'personas'), 'personas'],
        [j('workspace', 'memory'), 'memory'],
        [j('config', 'user.json'), 'config/user.json'],
        [j('workspace', 'vault.enc'), 'vault.enc'],
      ];

      for (const [srcRel, destRel] of currentSources) {
        const src = j(baseDir, srcRel);
        const dest = j(safetyDir, destRel);
        if (!ex(src)) continue;
        const srcStat = await st(src).catch(() => null);
        if (!srcStat) continue;
        if (srcStat.isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          const destParent = j(dest, '..');
          await mkd(destParent, { recursive: true });
          cpSync(src, dest);
        }
      }

      await wf(j(safetyDir, 'backup-meta.json'), JSON.stringify({
        id: safetyId,
        createdAt: now.toISOString(),
        reason: `Pre-restore safety backup before restoring ${backupId}`,
      }, null, 2));

      // Restore from the selected backup
      const restoreMap: Array<[string, string]> = [
        ['projects', j('workspace', 'projects')],
        ['personas', j('workspace', 'personas')],
        ['memory', j('workspace', 'memory')],
        ['config/user.json', j('config', 'user.json')],
        ['vault.enc', j('workspace', 'vault.enc')],
      ];

      for (const [srcRel, destRel] of restoreMap) {
        const src = j(backupDir, srcRel);
        const dest = j(baseDir, destRel);
        if (!ex(src)) continue;
        const srcStat = await st(src).catch(() => null);
        if (!srcStat) continue;
        if (srcStat.isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          const destParent = j(dest, '..');
          await mkd(destParent, { recursive: true });
          cpSync(src, dest);
        }
      }

      res.json({
        success: true,
        restoredFrom: backupId,
        safetyBackup: safetyId,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Restore failed' });
    }
  });

  app.delete('/api/backup/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { rm } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    try {
      const backupId = String(req.params.id);
      const backupDir = j(baseDir, 'workspace', 'backups', backupId);

      if (!ex(backupDir)) {
        return res.status(404).json({ error: `Backup '${backupId}' not found` });
      }

      await rm(backupDir, { recursive: true });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Delete failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Lessons API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/lessons', (_req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.json({ lessons: [] });
    res.json({ lessons: lessons.getAll() });
  });

  app.post('/api/lessons', async (req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });

    const { category, lesson: text, source, confidence, goalId } = req.body;
    if (!text) return res.status(400).json({ error: 'lesson text required' });

    const result = await lessons.addLesson({
      timestamp: new Date().toISOString(),
      category: category || 'general',
      lesson: text,
      source: source || 'user-feedback',
      confidence: confidence ?? 0.7,
      goalId,
    });
    res.json({ lesson: result });
  });

  app.post('/api/lessons/:id/adjust', async (req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });

    const delta = req.body.delta ?? 0;
    const result = await lessons.adjustConfidence(req.params.id, delta);
    if (!result) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ lesson: result });
  });

  app.delete('/api/lessons', async (_req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });
    await lessons.reset();
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Preferences API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/preferences', (_req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.json({ preferences: {}, metadata: {} });
    res.json(prefs.getAllWithMetadata());
  });

  app.post('/api/preferences', async (req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });

    const { key, value, source } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });

    await prefs.set(key, value, source || 'explicit');
    res.json({ success: true, preferences: prefs.getAll() });
  });

  app.delete('/api/preferences/:key', async (req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });

    const removed = await prefs.remove(req.params.key);
    if (!removed) return res.status(404).json({ error: 'Preference not found' });
    res.json({ success: true });
  });

  app.delete('/api/preferences', async (_req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });
    await prefs.reset();
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Orchestrator API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/orchestrator/status', (_req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.json({ scripts: [] });
    res.json({ scripts: orch.getStatus() });
  });

  app.get('/api/orchestrator/scripts', (_req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.json({ configs: [] });
    res.json({ configs: orch.getConfigs() });
  });

  app.post('/api/orchestrator/scripts', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const { id, name, command, args, cwd, autoStart, autoRestart, tags } = req.body;
    if (!id || !name || !command) {
      return res.status(400).json({ error: 'id, name, and command required' });
    }

    try {
      const config = await orch.addScript({ id, name, command, args, cwd, autoStart, autoRestart, tags });
      res.json({ config });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/orchestrator/scripts/:id/start', (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const status = orch.startScript(req.params.id);
    if (!status) return res.status(404).json({ error: 'Script not found' });
    res.json({ status });
  });

  app.post('/api/orchestrator/scripts/:id/stop', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const status = await orch.stopScript(req.params.id);
    if (!status) return res.status(404).json({ error: 'Script not found' });
    res.json({ status });
  });

  app.post('/api/orchestrator/scripts/:id/restart', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const status = await orch.restartScript(req.params.id);
    if (!status) return res.status(404).json({ error: 'Script not found' });
    res.json({ status });
  });

  app.get('/api/orchestrator/scripts/:id/logs', (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.json({ logs: [] });

    const count = parseInt(String(req.query.count)) || 50;
    const logs = orch.getLogs(req.params.id, count);
    res.json({ logs });
  });

  app.delete('/api/orchestrator/scripts/:id', async (req: Request, res: Response) => {
    const orch = services.orchestrator;
    if (!orch) return res.status(503).json({ error: 'Orchestrator not available' });

    const removed = await orch.removeScript(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Script not found' });
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // KDP Blurb Export
  // ═══════════════════════════════════════════════════════════

  // Export an arbitrary blurb (doesn't require a project)
  app.post('/api/kdp/export-blurb', (req: Request, res: Response) => {
    const exporter = services.kdpExporter;
    if (!exporter) return res.status(503).json({ error: 'KDP exporter not initialized' });
    const { blurb } = req.body || {};
    if (!blurb || typeof blurb !== 'string') {
      return res.status(400).json({ error: 'blurb (string) required' });
    }
    try {
      const result = exporter.exportBlurb(blurb);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Export failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Track Changes — DOCX editor roundtrip
  // ═══════════════════════════════════════════════════════════

  // Upload an edited .docx; return the structured diff report.
  app.post('/api/track-changes/parse', upload.single('file'), async (req: Request, res: Response) => {
    const tc = services.trackChanges;
    if (!tc) return res.status(503).json({ error: 'Track-changes service not initialized' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = '.' + (req.file.originalname.split('.').pop() || '').toLowerCase();
    if (ext !== '.docx') {
      return res.status(400).json({ error: 'Only .docx files are supported for track-changes parsing' });
    }

    try {
      const report = tc.parseDocx(req.file.buffer);
      // Cache the file on disk so the apply-decisions endpoint can reuse it.
      const { mkdir: mkd, writeFile: wf } = await import('fs/promises');
      const cacheDir = path.join(baseDir, 'workspace', 'tmp', 'track-changes');
      await mkd(cacheDir, { recursive: true });
      // Sanitize filename to prevent traversal.
      const safeName = req.file.originalname
        .replace(/[\x00-\x1f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.\.+/g, '_')
        .slice(0, 200);
      const cacheKey = `${Date.now()}-${safeName}`;
      await wf(path.join(cacheDir, cacheKey), req.file.buffer);
      res.json({ cacheKey, report });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Parse failed' });
    }
  });

  // Apply accept/reject decisions to produce clean Markdown.
  app.post('/api/track-changes/apply', async (req: Request, res: Response) => {
    const tc = services.trackChanges;
    if (!tc) return res.status(503).json({ error: 'Track-changes service not initialized' });

    const { cacheKey, decisions } = req.body || {};
    if (!cacheKey || !decisions || typeof decisions !== 'object') {
      return res.status(400).json({ error: 'cacheKey (from /parse) and decisions ({ [changeId]: "accepted"|"rejected" }) required' });
    }

    // Validate cacheKey — must match the expected format and stay inside the tmp dir.
    if (!/^[\d]+-[^\\/]+$/.test(cacheKey)) {
      return res.status(400).json({ error: 'Invalid cacheKey' });
    }

    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const cachePath = path.join(baseDir, 'workspace', 'tmp', 'track-changes', cacheKey);
    if (!ex(cachePath)) return res.status(404).json({ error: 'Cached upload not found. Re-upload and try again.' });

    try {
      const buffer = await rf(cachePath);
      const decisionMap = new Map<string, 'accepted' | 'rejected' | 'pending'>();
      for (const [id, status] of Object.entries(decisions)) {
        if (status === 'accepted' || status === 'rejected' || status === 'pending') {
          decisionMap.set(id, status);
        }
      }
      const markdown = tc.applyDecisions(buffer, decisionMap);
      res.json({ markdown, charCount: markdown.length, wordCount: markdown.split(/\s+/).filter(Boolean).length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Apply failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // External Tool Wrappers — sibling Python apps in ../Automations/
  // ═══════════════════════════════════════════════════════════

  app.post('/api/projects/:id/pacing-heatmap', async (req: Request, res: Response) => {
    const tools = services.externalTools;
    if (!tools) return res.status(503).json({ error: 'External tools not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No completed chapters found.' });
    }
    const manuscript = chapters.map(c => `# Chapter ${c.number}: ${c.title}\n\n${c.text}`).join('\n\n');
    const result = await tools.runManuscriptAutopsy(manuscript);
    res.json(result);
  });

  app.post('/api/projects/:id/format-pro', async (req: Request, res: Response) => {
    const tools = services.externalTools;
    if (!tools) return res.status(503).json({ error: 'External tools not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { outputFormat, trimSize, author } = req.body || {};
    const fmt = outputFormat || 'docx';
    if (!['docx', 'epub', 'pdf', 'md'].includes(fmt)) {
      return res.status(400).json({ error: 'outputFormat must be docx|epub|pdf|md' });
    }

    // Compile the manuscript first so Format Pro has an input file.
    const chapters = await gatherChapters(project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters to format.' });

    const { join: j, resolve: r } = await import('path');
    const { mkdir: mkd, writeFile: wf } = await import('fs/promises');
    const tmpDir = j(baseDir, 'workspace', 'tmp', 'format-input');
    await mkd(tmpDir, { recursive: true });
    const inputPath = j(tmpDir, `${project.id}.md`);
    const manuscript = chapters.map(c => `# Chapter ${c.number}: ${c.title}\n\n${c.text}`).join('\n\n');
    await wf(inputPath, manuscript, 'utf-8');

    const result = await tools.runFormatPro({
      manuscriptPath: r(inputPath),
      outputFormat: fmt,
      title: project.title,
      author: author || 'Anonymous',
      trimSize,
    });
    res.json(result);
  });

  // ═══════════════════════════════════════════════════════════
  // Cover Typography — overlay title/author on an AI-generated PNG
  // ═══════════════════════════════════════════════════════════

  app.post('/api/covers/apply-typography', async (req: Request, res: Response) => {
    const typo = services.coverTypography;
    if (!typo) return res.status(503).json({ error: 'Cover typography service not initialized' });

    const { imagePath, title, author, subtitle, seriesBadge, genre, titleColor, authorColor, width, height } = req.body || {};
    if (!imagePath || !title || !author) {
      return res.status(400).json({ error: 'imagePath, title, and author are required' });
    }

    // Harden against path traversal — imagePath must be inside workspace.
    const { resolve } = await import('path');
    const workspaceDir = path.join(baseDir, 'workspace');
    const resolved = resolve(String(imagePath));
    if (!resolved.startsWith(resolve(workspaceDir))) {
      return res.status(400).json({ error: 'imagePath must be inside workspace/' });
    }

    try {
      const result = await typo.apply({
        imagePath: resolved, title, author, subtitle, seriesBadge, genre,
        titleColor, authorColor, width, height,
      });
      if (!result.success) return res.status(500).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Typography failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Manuscript Hub — aggregated dashboard stats
  // ═══════════════════════════════════════════════════════════

  app.get('/api/hub', async (_req: Request, res: Response) => {
    const hub = services.manuscriptHub;
    const engine = gateway.getProjectEngine?.();
    const activityLog = gateway.getActivityLog?.();
    if (!hub || !engine || !activityLog) {
      return res.status(503).json({ error: 'Manuscript hub services not initialized' });
    }
    try {
      const projects = engine.listProjects();
      const dailyWordGoal = services.config.get('autonomous.dailyWordGoal', 1000) || 1000;
      const report = await hub.build(projects, activityLog, dailyWordGoal);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Hub build failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Beta Reader + Dialogue Auditor
  // ═══════════════════════════════════════════════════════════

  // Helper: gather completed writing-phase chapters for a project.
  async function gatherChapters(project: any): Promise<Array<{ id: string; number: number; title: string; text: string }>> {
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    const projectSlug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const projectDir = j(baseDir, 'workspace', 'projects', projectSlug);

    const writingSteps = project.steps
      .filter((s: any) => (s.phase === 'writing' || s.label?.toLowerCase().includes('chapter')) && s.status === 'completed')
      .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

    const chapters: Array<{ id: string; number: number; title: string; text: string }> = [];
    for (const ws of writingSteps) {
      let text = ws.result || '';
      // If no inline result, try reading from disk.
      if (!text && ex(projectDir)) {
        const expectedFile = `${ws.id}-${ws.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
        const fullPath = j(projectDir, expectedFile);
        if (ex(fullPath)) {
          const raw = await rf(fullPath, 'utf-8');
          text = raw.replace(/^# .+\n\n/, '');
        }
      }
      if (text && text.length > 200) {
        chapters.push({
          id: ws.id,
          number: ws.chapterNumber || chapters.length + 1,
          title: ws.label,
          text,
        });
      }
    }
    return chapters;
  }

  // Get available beta reader archetypes
  app.get('/api/beta-reader/archetypes', (_req: Request, res: Response) => {
    const beta = services.betaReader;
    if (!beta) return res.json({ archetypes: [] });
    res.json({ archetypes: beta.getArchetypes() });
  });

  // Run beta reader panel on a project (async — uses SSE/socket for progress)
  app.post('/api/projects/:id/beta-reader', async (req: Request, res: Response) => {
    const beta = services.betaReader;
    if (!beta) return res.status(503).json({ error: 'Beta reader not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No completed chapters found. Write some chapters first.' });
    }

    const archetypes = Array.isArray(req.body?.archetypes) && req.body.archetypes.length > 0
      ? req.body.archetypes
      : undefined;

    // Respond immediately — client subscribes to progress via socket.
    res.json({ status: 'started', chapters: chapters.length, archetypes: (archetypes || beta.getArchetypes()).length });

    const aiCompleteFn = (r: any) => services.aiRouter.complete(r);
    const aiSelectFn = (t: string) => services.aiRouter.selectProvider(t);

    (async () => {
      try {
        const report = await beta.scanManuscript(
          project.id, chapters, aiCompleteFn, aiSelectFn, archetypes,
          (msg: string) => {
            try { (gateway as any).io?.emit?.('beta-reader-progress', { projectId: project.id, message: msg }); } catch {}
          }
        );
        // Store the report alongside context data.
        try {
          const { join: j } = await import('path');
          const { writeFile: wf, mkdir: mkd } = await import('fs/promises');
          const dir = j(baseDir, 'workspace', 'beta-reports');
          await mkd(dir, { recursive: true });
          await wf(j(dir, `${project.id}.json`), JSON.stringify(report, null, 2));
        } catch { /* non-fatal */ }
        try { (gateway as any).io?.emit?.('beta-reader-complete', { projectId: project.id, report }); } catch {}
      } catch (err: any) {
        try { (gateway as any).io?.emit?.('beta-reader-error', { projectId: project.id, error: err?.message || String(err) }); } catch {}
      }
    })();
  });

  // Get the stored beta-reader report
  app.get('/api/projects/:id/beta-reader/report', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const file = j(baseDir, 'workspace', 'beta-reports', `${req.params.id}.json`);
    if (!ex(file)) return res.json({ report: null });
    try {
      const raw = await rf(file, 'utf-8');
      res.json({ report: JSON.parse(raw) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not read report' });
    }
  });

  // Run dialogue audit on a project
  app.post('/api/projects/:id/dialogue-audit', async (req: Request, res: Response) => {
    const auditor = services.dialogueAuditor;
    if (!auditor) return res.status(503).json({ error: 'Dialogue auditor not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    if (chapters.length === 0) {
      return res.status(400).json({ error: 'No completed chapters found.' });
    }

    // Combine all chapters then audit across the whole manuscript.
    const combined = chapters.map(c => `# ${c.title}\n\n${c.text}`).join('\n\n');
    try {
      const report = auditor.audit(combined, project.id);
      res.json({ report });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Audit failed' });
    }
  });

  // Export the active blurb from a project's compiled output, if present
  app.post('/api/projects/:id/export-blurb', async (req: Request, res: Response) => {
    const exporter = services.kdpExporter;
    if (!exporter) return res.status(503).json({ error: 'KDP exporter not initialized' });

    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Priority: req.body.blurb > the most recent step whose label contains "blurb"
    let blurb: string | undefined = req.body?.blurb;
    if (!blurb) {
      const blurbStep = [...project.steps].reverse().find((s: any) =>
        /blurb|description/i.test(s.label) && s.status === 'completed' && s.result
      );
      blurb = blurbStep?.result;
    }
    if (!blurb) {
      return res.status(400).json({ error: 'No blurb found. Pass { blurb: "..." } or run the blurb-writer skill first.' });
    }
    try {
      const result = exporter.exportBlurb(blurb);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Export failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Wave 2: Goals, Series Bible, Craft Critic, Audiobook, Style Clone
  // ═══════════════════════════════════════════════════════════

  // ── Author Goals ──

  app.get('/api/goals', (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.json({ goals: [] });
    const status = req.query.status as any;
    const type = req.query.type as any;
    const list = goals.listGoals({ status, type });
    const withProgress = list.map((g: any) => goals.computeProgress(g.id)).filter(Boolean);
    res.json({ goals: withProgress });
  });

  app.post('/api/goals', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const { type, title, description, target, unit, deadline, projectIds } = req.body || {};
    if (!type || !title || !target || !unit || !deadline) {
      return res.status(400).json({ error: 'type, title, target, unit, deadline required' });
    }
    try {
      const goal = await goals.createGoal({ type, title, description, target, unit, deadline, projectIds });
      res.json({ goal });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Create failed' });
    }
  });

  app.post('/api/goals/:id/progress', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const { current } = req.body || {};
    if (typeof current !== 'number') return res.status(400).json({ error: 'current (number) required' });
    const result = await goals.updateProgress(req.params.id, current, 'manual');
    if (!result) return res.status(404).json({ error: 'Goal not found' });
    res.json({ goal: result, progress: goals.computeProgress(req.params.id) });
  });

  app.post('/api/goals/:id/status', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const { status } = req.body || {};
    if (!['active', 'paused', 'completed', 'missed'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|paused|completed|missed' });
    }
    const result = await goals.setStatus(req.params.id, status);
    if (!result) return res.status(404).json({ error: 'Goal not found' });
    res.json({ goal: result });
  });

  app.delete('/api/goals/:id', async (req: Request, res: Response) => {
    const goals = services.goals;
    if (!goals) return res.status(503).json({ error: 'Goals service not initialized' });
    const removed = await goals.removeGoal(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true });
  });

  // ── Series Bible ──

  app.get('/api/series', (_req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.json({ series: [] });
    res.json({ series: sb.listSeries() });
  });

  app.post('/api/series', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { title, description, projectIds, readingOrder } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
      const series = await sb.createSeries({ title, description, projectIds, readingOrder });
      res.json({ series });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Create failed' });
    }
  });

  app.post('/api/series/:id/add-project', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const result = await sb.addProject(req.params.id, projectId);
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  });

  app.post('/api/series/:id/remove-project', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const result = await sb.removeProject(req.params.id, projectId);
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  });

  app.post('/api/series/:id/reading-order', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order (array of projectIds) required' });
    const result = await sb.setReadingOrder(req.params.id, order);
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  });

  app.get('/api/series/:id/report', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    const ctxEngine = services.contextEngine;
    const engine = gateway.getProjectEngine?.();
    if (!sb || !ctxEngine || !engine) {
      return res.status(503).json({ error: 'Series bible services not initialized' });
    }
    try {
      const resolver = (pid: string) => engine.getProject(pid)?.title;
      const report = await sb.buildReport(req.params.id, ctxEngine, resolver);
      if (!report) return res.status(404).json({ error: 'Series not found' });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Report failed' });
    }
  });

  app.delete('/api/series/:id', async (req: Request, res: Response) => {
    const sb = services.seriesBible;
    if (!sb) return res.status(503).json({ error: 'Series bible not initialized' });
    const removed = await sb.deleteSeries(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Series not found' });
    res.json({ success: true });
  });

  // ── Craft Critic ──

  app.post('/api/projects/:id/craft-critique', async (req: Request, res: Response) => {
    const critic = services.craftCritic;
    if (!critic) return res.status(503).json({ error: 'Craft critic not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });
    try {
      const report = critic.analyze(project.id, chapters);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Critique failed' });
    }
  });

  // ── Audiobook Prep ──

  app.post('/api/projects/:id/audiobook/cleanup', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    if (!prep) return res.status(503).json({ error: 'Audiobook prep not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });

    const combined = chapters.map(c => `# Chapter ${c.number}: ${c.title}\n\n${c.text}`).join('\n\n');
    const result = prep.cleanupScript(combined);
    res.json(result);
  });

  app.post('/api/projects/:id/audiobook/pronunciation', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    const ctxEngine = services.contextEngine;
    if (!prep || !ctxEngine) return res.status(503).json({ error: 'Services not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    const combined = chapters.map(c => c.text).join('\n\n');
    try {
      const ctx = await ctxEngine.loadContext(req.params.id);
      const dict = prep.buildPronunciationDictionary(req.params.id, ctx.entities, combined);
      res.json({ dictionary: dict });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Pronunciation extraction failed' });
    }
  });

  app.post('/api/projects/:id/audiobook/ssml', async (req: Request, res: Response) => {
    const prep = services.audiobookPrep;
    const ctxEngine = services.contextEngine;
    if (!prep || !ctxEngine) return res.status(503).json({ error: 'Services not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const aiDisclosed = !!(project as any).aiNarrationDisclosed || !!req.body?.aiNarrationDisclosed;
    const chapters = await gatherChapters(project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });
    try {
      const ctx = await ctxEngine.loadContext(req.params.id);
      const combined = chapters.map(c => c.text).join('\n\n');
      const dict = prep.buildPronunciationDictionary(req.params.id, ctx.entities, combined);

      // Apply cleanup then build SSML.
      const cleanedChapters = chapters.map(c => {
        const { cleanedText } = prep.cleanupScript(c.text);
        return { number: c.number, title: c.title, text: cleanedText };
      });

      const result = prep.buildSSML(cleanedChapters, dict, aiDisclosed);
      res.json({ ...result, disclosureRequired: !aiDisclosed, disclosureIncluded: aiDisclosed });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'SSML build failed' });
    }
  });

  // ── Style Clone ──

  app.post('/api/style-clone/analyze', (req: Request, res: Response) => {
    const sc = services.styleClone;
    if (!sc) return res.status(503).json({ error: 'Style clone not initialized' });
    const { text, source } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text (string) required' });
    try {
      const profile = sc.analyze(text, source || 'manual-paste');
      res.json({ profile });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Analysis failed' });
    }
  });

  app.post('/api/projects/:id/style-clone', async (req: Request, res: Response) => {
    const sc = services.styleClone;
    if (!sc) return res.status(503).json({ error: 'Style clone not initialized' });
    const engine = gateway.getProjectEngine?.();
    const project = engine?.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const chapters = await gatherChapters(project);
    if (chapters.length === 0) return res.status(400).json({ error: 'No completed chapters found.' });
    const combined = chapters.map(c => c.text).join('\n\n');
    try {
      const profile = sc.analyze(combined, `project:${project.id}`);
      res.json({ profile });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Analysis failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Wave 3 — Autonomous Career Agent (ALL ACTIONS ARE GATED)
  // ═══════════════════════════════════════════════════════════

  // Universal disclaimer returned with every Wave 3 response header.
  const addWaveDisclaimer = (res: Response) => {
    res.setHeader('X-AuthorClaw-Disclaimer', 'Wave 3 actions create confirmation requests but do not execute irreversible actions autonomously. You are responsible for every approved action. See SECURITY.md.');
  };

  // ── Confirmation Gate ──

  app.get('/api/confirmations', (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.json({ requests: [], disclaimer: '' });
    const status = req.query.status as any;
    const service = req.query.service as any;
    addWaveDisclaimer(res);
    res.json({
      requests: gate.list({ status, service }),
      disclaimer: services.disclosures?.universalDisclaimer() || '',
    });
  });

  app.get('/api/confirmations/:id', (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    const req_ = gate.get(req.params.id);
    if (!req_) return res.status(404).json({ error: 'Not found' });
    addWaveDisclaimer(res);
    res.json({ request: req_ });
  });

  app.post('/api/confirmations/:id/approve', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    try {
      const result = await gate.approve(req.params.id);
      if (!result) return res.status(404).json({ error: 'Not found' });
      addWaveDisclaimer(res);
      res.json({ request: result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Approval failed' });
    }
  });

  app.post('/api/confirmations/:id/reject', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    try {
      const result = await gate.reject(req.params.id, 'user', req.body?.reason);
      if (!result) return res.status(404).json({ error: 'Not found' });
      res.json({ request: result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Rejection failed' });
    }
  });

  app.post('/api/confirmations/:id/outcome', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return res.status(503).json({ error: 'Confirmation gate not initialized' });
    const { success, message, externalId, metadata } = req.body || {};
    if (typeof success !== 'boolean' || !message) {
      return res.status(400).json({ error: 'success (boolean) and message (string) required' });
    }
    try {
      const result = await gate.recordOutcome(req.params.id, {
        success, message, externalId, executedAt: new Date().toISOString(), metadata,
      });
      if (!result) return res.status(404).json({ error: 'Not found' });
      res.json({ request: result });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Outcome recording failed' });
    }
  });

  // ── Disclosures ──

  app.get('/api/disclosures/universal', (_req: Request, res: Response) => {
    const d = services.disclosures;
    if (!d) return res.status(503).json({ error: 'Disclosures not initialized' });
    res.json({ text: d.universalDisclaimer() });
  });

  app.post('/api/disclosures/check', (req: Request, res: Response) => {
    const d = services.disclosures;
    if (!d) return res.status(503).json({ error: 'Disclosures not initialized' });
    const { platform, scopes, acknowledgedScopes } = req.body || {};
    if (!platform || !Array.isArray(scopes)) {
      return res.status(400).json({ error: 'platform and scopes (array) required' });
    }
    const result = d.checkCompliance({
      platform, scopes,
      acknowledgedScopes: Array.isArray(acknowledgedScopes) ? acknowledgedScopes : [],
    });
    res.json(result);
  });

  // ── Launch Orchestrator ──

  app.get('/api/launches', (_req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.json({ launches: [] });
    addWaveDisclaimer(res);
    res.json({ launches: l.listLaunches() });
  });

  app.post('/api/launches', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const { projectId, bookTitle, authorName, targetReleaseDate, metadata } = req.body || {};
    if (!projectId || !bookTitle || !authorName || !targetReleaseDate) {
      return res.status(400).json({ error: 'projectId, bookTitle, authorName, targetReleaseDate required' });
    }
    const launch = await l.createLaunch({ projectId, bookTitle, authorName, targetReleaseDate, metadata });
    addWaveDisclaimer(res);
    res.json({ launch });
  });

  app.get('/api/launches/:id', (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const launch = l.getLaunch(req.params.id);
    if (!launch) return res.status(404).json({ error: 'Not found' });
    res.json({ launch, plan: l.buildPlan(launch) });
  });

  app.patch('/api/launches/:id', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const result = await l.updateMetadata(req.params.id, req.body?.metadata || {});
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ launch: result });
  });

  app.post('/api/launches/:id/acknowledge-disclosures', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const { scopes } = req.body || {};
    if (!Array.isArray(scopes)) return res.status(400).json({ error: 'scopes (array) required' });
    const result = await l.acknowledgeDisclosures(req.params.id, scopes);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ launch: result });
  });

  app.post('/api/launches/:id/propose-step', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const { phase } = req.body || {};
    if (!phase) return res.status(400).json({ error: 'phase required' });
    try {
      const result = await l.proposeStep(req.params.id, phase);
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Proposal failed' });
    }
  });

  app.delete('/api/launches/:id', async (req: Request, res: Response) => {
    const l = services.launchOrchestrator;
    if (!l) return res.status(503).json({ error: 'Launch orchestrator not initialized' });
    const removed = await l.deleteLaunch(req.params.id);
    res.json({ success: removed });
  });

  // ── AMS Ads ──

  app.post('/api/ams/propose-campaigns', (req: Request, res: Response) => {
    const ams = services.amsAds;
    if (!ams) return res.status(503).json({ error: 'AMS service not initialized' });
    const { bookTitle, genre, keywords, dailyBudgetCeilingUSD } = req.body || {};
    if (!bookTitle || !genre || !Array.isArray(keywords) || typeof dailyBudgetCeilingUSD !== 'number') {
      return res.status(400).json({ error: 'bookTitle, genre, keywords (array), dailyBudgetCeilingUSD (number) required' });
    }
    addWaveDisclaimer(res);
    res.json({ campaigns: ams.proposeCampaigns({ bookTitle, genre, keywords, dailyBudgetCeilingUSD }) });
  });

  app.post('/api/ams/optimize', (req: Request, res: Response) => {
    const ams = services.amsAds;
    if (!ams) return res.status(503).json({ error: 'AMS service not initialized' });
    const { performance, acosTargetPct, dailyBudgetCeilingUSD, currentDailySpendUSD } = req.body || {};
    if (!Array.isArray(performance) || typeof acosTargetPct !== 'number'
        || typeof dailyBudgetCeilingUSD !== 'number' || typeof currentDailySpendUSD !== 'number') {
      return res.status(400).json({ error: 'performance (array), acosTargetPct, dailyBudgetCeilingUSD, currentDailySpendUSD required' });
    }
    addWaveDisclaimer(res);
    res.json(ams.optimize({ performance, acosTargetPct, dailyBudgetCeilingUSD, currentDailySpendUSD }));
  });

  // ── BookBub ──

  app.post('/api/bookbub/draft', (req: Request, res: Response) => {
    const bb = services.bookbub;
    if (!bb) return res.status(503).json({ error: 'BookBub service not initialized' });
    const { title, authorName, genre, amazonBlurb } = req.body || {};
    if (!title || !authorName || !genre || !amazonBlurb) {
      return res.status(400).json({ error: 'title, authorName, genre, amazonBlurb required' });
    }
    addWaveDisclaimer(res);
    res.json({ draft: bb.buildDraft(req.body) });
  });

  // ── Release Calendar ──

  app.get('/api/calendar', (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.json({ events: [] });
    res.json({
      events: c.list({
        projectId: req.query.projectId as any,
        category: req.query.category as any,
        from: req.query.from as any,
        to: req.query.to as any,
      }),
      atRisk: c.atRisk(),
    });
  });

  app.post('/api/calendar', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    try {
      const event = await c.createEvent(req.body);
      res.json({ event });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Create failed' });
    }
  });

  app.post('/api/calendar/price-pulse-plan', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const { projectId, bookTitle, releaseDate, launchPrice, tailPrice } = req.body || {};
    if (!projectId || !bookTitle || !releaseDate) {
      return res.status(400).json({ error: 'projectId, bookTitle, releaseDate required' });
    }
    const events = c.buildPricePulsePlan({ projectId, bookTitle, releaseDate, launchPrice, tailPrice });
    for (const ev of events) await c.createEvent(ev);
    res.json({ events });
  });

  app.patch('/api/calendar/:id', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const result = await c.updateEvent(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ event: result });
  });

  app.delete('/api/calendar/:id', async (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const removed = await c.removeEvent(req.params.id);
    res.json({ success: removed });
  });

  app.get('/api/calendar/export.ics', (req: Request, res: Response) => {
    const c = services.releaseCalendar;
    if (!c) return res.status(503).json({ error: 'Calendar not initialized' });
    const ics = c.exportICS({
      projectId: req.query.projectId as any,
      from: req.query.from as any,
      to: req.query.to as any,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="authorclaw-calendar.ics"');
    res.send(ics);
  });

  // ── Reader Intel ──

  app.post('/api/reader-intel/analyze', async (req: Request, res: Response) => {
    const ri = services.readerIntel;
    if (!ri) return res.status(503).json({ error: 'Reader intel not initialized' });
    const { reviews } = req.body || {};
    if (!Array.isArray(reviews)) return res.status(400).json({ error: 'reviews (array) required' });
    try {
      const sanitized = await ri.sanitize(reviews);
      const report = ri.analyze(sanitized);
      res.json({ report, sanitizedCount: sanitized.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Analysis failed' });
    }
  });

  // ── Translation Pipeline ──

  app.post('/api/translation/plan', (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });
    const { projectId, bookTitle, targetLangs, estimatedWordCount, sourceLang } = req.body || {};
    if (!projectId || !bookTitle || !Array.isArray(targetLangs) || typeof estimatedWordCount !== 'number') {
      return res.status(400).json({ error: 'projectId, bookTitle, targetLangs (array), estimatedWordCount (number) required' });
    }
    addWaveDisclaimer(res);
    res.json(tp.plan({ projectId, bookTitle, targetLangs, estimatedWordCount, sourceLang }));
  });

  app.post('/api/translation/propose', async (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });
    const { projectId, bookTitle, targetLang, estimatedWordCount, sampleText } = req.body || {};
    if (!projectId || !bookTitle || !targetLang || typeof estimatedWordCount !== 'number') {
      return res.status(400).json({ error: 'projectId, bookTitle, targetLang, estimatedWordCount required' });
    }
    try {
      const result = await tp.proposeTranslation({ projectId, bookTitle, targetLang, estimatedWordCount, sampleText });
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Proposal failed' });
    }
  });

  app.post('/api/translation/rights-pitch', (req: Request, res: Response) => {
    const tp = services.translationPipeline;
    if (!tp) return res.status(503).json({ error: 'Translation pipeline not initialized' });
    const { targetLang, bookTitle, authorName, genre, wordCountApprox, comps, marketingAngle } = req.body || {};
    if (!targetLang || !bookTitle || !authorName || !genre || typeof wordCountApprox !== 'number') {
      return res.status(400).json({ error: 'targetLang, bookTitle, authorName, genre, wordCountApprox required' });
    }
    res.json(tp.generateRightsPitch({ targetLang, bookTitle, authorName, genre, wordCountApprox, comps, marketingAngle }));
  });

  // ── Website Builder ──

  app.get('/api/websites', async (_req: Request, res: Response) => {
    const w = services.websiteBuilder;
    if (!w) return res.json({ sites: [] });
    const sites = await w.listSites();
    res.json({ sites });
  });

  app.post('/api/websites/build', async (req: Request, res: Response) => {
    const w = services.websiteBuilder;
    if (!w) return res.status(503).json({ error: 'Website builder not initialized' });
    const { config, books, blogPosts, aboutHTML, contactHTML } = req.body || {};
    if (!config || !config.slug || !config.siteName || !config.authorName || !config.baseUrl) {
      return res.status(400).json({ error: 'config with slug, siteName, authorName, baseUrl required' });
    }
    try {
      const result = await w.build({
        config,
        books: Array.isArray(books) ? books : [],
        blogPosts: Array.isArray(blogPosts) ? blogPosts : [],
        aboutHTML, contactHTML,
      });
      addWaveDisclaimer(res);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Build failed' });
    }
  });
}

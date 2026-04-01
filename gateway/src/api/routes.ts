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

    // Clean up on disconnect
    req.on('close', cleanup);
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
    const deleted = await services.vault.delete(req.params.key);
    if (deleted) {
      await services.audit.log('vault', 'key_deleted', { key: req.params.key });
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
  app.post('/api/config/update', (req: Request, res: Response) => {
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
    services.config.set(path, value);
    // Sync global provider preference to router
    if (path === 'ai.preferredProvider') {
      services.aiRouter.setGlobalPreferredProvider(value || null);
    }
    res.json({ success: true, path, value });
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

  app.post('/api/telegram/connect', async (_req: Request, res: Response) => {
    try {
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
  async function getSmartExcerpt(filePath: string, wordCount: number): Promise<string> {
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');

    if (!ex(filePath)) {
      return `[Document not found at ${filePath} — it may have been moved or deleted]`;
    }

    const fullText = await rf(filePath, 'utf-8');
    const MAX_CHARS = 25000; // ~6K words — fits comfortably in AI context

    if (fullText.length <= MAX_CHARS) {
      return fullText; // Small enough to include everything
    }

    // Smart split: first 20K + last 5K
    const headSize = 20000;
    const tailSize = 5000;
    const head = fullText.substring(0, headSize);
    const tail = fullText.substring(fullText.length - tailSize);

    const omittedChars = fullText.length - headSize - tailSize;
    const omittedWords = Math.round(omittedChars / 5); // rough estimate

    return `${head}\n\n` +
      `[... ⚠️ MIDDLE SECTION OMITTED: ~${omittedWords.toLocaleString()} words skipped to fit context. ` +
      `Full document (${wordCount.toLocaleString()} words) is saved in workspace/documents/. ...]\n\n` +
      `${tail}`;
  }

  // Helper: build user message for project step execution
  // Injects uploaded manuscript DIRECTLY into the user message so the AI can't miss it
  // For large documents (15K+ words): reads from disk and applies smart truncation
  async function buildStepUserMessage(project: any, step: any): Promise<string> {
    let message = step.prompt;
    const uploads = project.context?.uploads || [];
    const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount?.toLocaleString() || '?'} words)`).join(', ');

    // Large document path: read from disk with smart truncation
    if (project.context?.documentLibraryFile) {
      const excerpt = await getSmartExcerpt(
        project.context.documentLibraryFile,
        project.context.documentWordCount || 0
      );
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}\n\n${excerpt}\n\n---\n\n## Your Task\n\n${message}`;
      return message;
    }

    // Small document path: use inline uploaded content (same as before)
    if (project.context?.uploadedContent) {
      const uploaded = String(project.context.uploadedContent).substring(0, 30000);
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}\n\n${uploaded}\n\n---\n\n## Your Task\n\n${message}`;
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
    const filename = req.file.originalname;
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
      const outputBaseName = isChapterProject ? 'manuscript' : 'compiled-output';
      await wf(j(projectDir, `${outputBaseName}.md`), compiledMd, 'utf-8');

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
      res.json({
        success: true,
        sections: sectionContents.length,
        totalWords,
        files: exportFiles,
        outputName: outputBaseName,
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
}

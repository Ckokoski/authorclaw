/**
 * AuthorAgent Project Engine — V4
 * Autonomous book production at scale
 *
 * 6 Core Project Types (chainable into a Pipeline):
 *   book-planning    - Market analysis → premise → characters → outline → synopsis
 *   book-bible       - World-building → character bible → continuity → style guide
 *   book-production  - Write chapters sequentially with context injection
 *   deep-revision    - 21-step, 3-pass revision (macro → medium → micro + beta readers)
 *   format-export    - Front/back matter → DOCX/EPUB/PDF export (KDP-ready)
 *   book-launch      - Blurb → Amazon desc → keywords → ad copy → social posts
 *
 * Pipeline Mode: Chain all 6 phases from a single idea + persona
 *
 * ── Architecture (Phase 2 refactor) ──
 * ProjectEngine is the FACADE. Its public method signatures are unchanged, but
 * two cohesive concerns now live in sibling modules and are composed in here:
 *   - project-templates.ts : PROJECT_TEMPLATES, TASK_TYPE_MAP, and the pure
 *                            step builders (novel-pipeline / book-production).
 *   - step-executor.ts     : the step-execution engine (executeStepWithRetry,
 *                            autoExecuteLoop, buildStepUserMessage, excerpting).
 * ProjectEngine keeps the state machine, dynamic planning, context building,
 * and persistence — and delegates the above via thin pass-throughs.
 */

import { AuthorOSService } from './author-os.js';
import { ContextEngine } from './context-engine.js';
import type { MemoryTierService } from './memory-tier.js';
import type { SkillCatalogEntry } from '../skills/loader.js';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import {
  PROJECT_TEMPLATES,
  TASK_TYPE_MAP,
  buildNovelPipelineSteps,
  buildBookProductionSteps,
  deriveDependencies,
  applyStepCompletion,
  type Project,
  type ProjectStep,
  type ProjectType,
  type NovelPipelineConfig,
} from './project-templates.js';
import {
  StepExecutor,
  type EnginePort,
  type MessageHandler,
  type StepServices,
  type ExecuteStepOptions,
} from './step-executor.js';

const log = logger.child('[projects]');

/**
 * Feature flag (Chunk B1): inject the tiered "# CORE STORY MEMORY" block into
 * project-step context. Defaults ON. Set AUTHORCLAW_CORE_INJECTION=off (or
 * 'false'/'0') to disable and fall back to the exact prior context assembly —
 * a kill switch if CORE ever misbehaves in production. Read once at module
 * load; the guard is additionally null-checked at every call site.
 */
const CORE_INJECTION_ENABLED = !['off', 'false', '0'].includes(
  String(process.env.AUTHORCLAW_CORE_INJECTION || '').trim().toLowerCase(),
);

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

// Core project types are defined in project-templates.ts (so that module has
// no back-import to ProjectEngine). Re-exported here to preserve the original
// public export surface — external code that imports these from
// './services/projects.js' keeps working unchanged.
export type { Project, ProjectStep, ProjectType, NovelPipelineConfig } from './project-templates.js';

// Step-execution types are defined in step-executor.ts and re-exported here for
// the same reason.
export type { MessageHandler, StepServices, ExecuteStepOptions } from './step-executor.js';

/**
 * Callback type for AI completion — injected by the gateway so ProjectEngine
 * can call the AI without importing the router directly.
 */
export type AICompleteFunc = (request: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed: number; estimatedCost: number; provider: string }>;

/**
 * Callback to select the best provider for a task type
 */
export type AISelectProviderFunc = (taskType: string) => { id: string };

// ═══════════════════════════════════════════════════════════
// Project Engine
// ═══════════════════════════════════════════════════════════

export class ProjectEngine {
  private projects: Map<string, Project> = new Map();
  private authorOS: AuthorOSService | null;
  private rootDir: string;
  private nextId = 1;
  private aiComplete: AICompleteFunc | null = null;
  private aiSelectProvider: AISelectProviderFunc | null = null;
  private messageHandler: MessageHandler | null = null;
  private stepServices: StepServices = {};
  private contextEngine?: ContextEngine;
  /**
   * Tiered-memory budgeting layer (Chunk B1). Optional — when unset (or when
   * its internal memorySearch is unavailable) every consumer below degrades to
   * the exact prior behavior, so the CORE/archival integration is fully
   * guarded. Feature-flagged via CORE_INJECTION_ENABLED.
   */
  private memoryTier?: MemoryTierService;
  private coreLessonsCache: string | null = null;
  private coreLessonsCacheTime = 0;
  private stateFilePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Step-execution engine. Reaches the state machine + context builder through
   * a narrow EnginePort (composition, not a god-object) and reads the injected
   * message handler / step services / context engine lazily so services wired
   * after construction (writingJudge, tts) are picked up at run time — matching
   * the original inline behavior.
   */
  private stepExecutor: StepExecutor;

  constructor(authorOS?: AuthorOSService, rootDir?: string) {
    this.authorOS = authorOS || null;
    this.rootDir = rootDir || process.cwd();
    this.stateFilePath = join(this.rootDir, 'workspace', '.config', 'projects-state.json');

    const enginePort: EnginePort = {
      getProject: (id) => this.getProject(id),
      completeStep: (projectId, stepId, result) => this.completeStep(projectId, stepId, result),
      completeStepBare: (projectId, stepId, result) => this.completeStepBare(projectId, stepId, result),
      openStepGate: (projectId, stepId, result) => this.openStepGate(projectId, stepId, result),
      activateStep: (projectId, stepId) => this.activateStep(projectId, stepId),
      failStep: (projectId, stepId, error) => this.failStep(projectId, stepId, error),
      buildProjectContext: (project, step) => this.buildProjectContext(project, step),
    };
    this.stepExecutor = new StepExecutor(enginePort, {
      getMessageHandler: () => this.messageHandler,
      getStepServices: () => this.stepServices,
      getContextEngine: () => this.contextEngine,
    });

    this.loadState();  // Restore projects from disk on startup
  }

  /**
   * Persist all project state to disk (debounced — max once per second).
   * Non-fatal: if save fails, projects continue to work in-memory.
   */
  private persistState(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(async () => {
      try {
        const { mkdir } = await import('fs/promises');
        const { dirname } = await import('path');
        await mkdir(dirname(this.stateFilePath), { recursive: true });
        const state = {
          nextId: this.nextId,
          projects: Array.from(this.projects.values()).map(p => ({
            ...p,
            // Strip large step results to save space — they're already saved as individual files
            steps: p.steps.map(s => ({
              ...s,
              result: s.result ? s.result.substring(0, 500) + (s.result.length > 500 ? '\n\n[... truncated for state file — full output in project files ...]' : '') : undefined,
            })),
          })),
        };
        const { writeFile: wf } = await import('fs/promises');
        await wf(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
      } catch (err) {
        log.error('  ⚠ Failed to persist project state:', err);
      }
    }, 1000);
  }

  /**
   * Load project state from disk on startup.
   */
  private loadState(): void {
    try {
      if (!existsSync(this.stateFilePath)) return;
      const raw = readFileSync(this.stateFilePath, 'utf-8');
      const state = JSON.parse(raw);
      if (state.nextId) this.nextId = state.nextId;
      if (Array.isArray(state.projects)) {
        let migrated = 0;
        for (const p of state.projects) {
          // ── Legacy book-production migration ──
          // Projects created before commit 8bd7940 have analysis-only
          // "Self-review Chapter N" steps that produce critique notes but
          // never apply them. Auto-migrate any PENDING / ACTIVE self-review
          // step to the new polish prompt + phase so old projects benefit
          // from the same revise-and-rewrite behavior as new ones.
          // Completed steps are left alone — their output is already saved.
          if (p.type === 'book-production' && Array.isArray(p.steps)) {
            for (const step of p.steps) {
              const isLegacySelfReview =
                (step.status === 'pending' || step.status === 'active') &&
                typeof step.label === 'string' &&
                step.label.startsWith('Self-review Chapter') &&
                step.skill === 'revise' &&
                step.phase !== 'polish';
              if (isLegacySelfReview) {
                const ch = step.chapterNumber || (step.label.match(/Chapter (\d+)/)?.[1] ?? 'N');
                const wpc = (p.context?.targetWordsPerChapter as number) || 3000;
                step.label = `Polish Chapter ${ch}`;
                step.phase = 'polish';
                step.wordCountTarget = wpc;
                step.prompt =
                  `You just wrote Chapter ${ch} of "${p.title}" (in your context above).\n\n` +
                  `Produce a REVISED, POLISHED version of THE ENTIRE chapter. Apply these fixes as you rewrite:\n` +
                  `- Tighten pacing; cut throat-clearing\n` +
                  `- Strengthen weak verbs; remove unnecessary -ly adverbs\n` +
                  `- Replace filter words (saw, heard, felt, noticed, realized) with direct sensory experience\n` +
                  `- Cut repetition and redundancy\n` +
                  `- Sharpen dialogue; remove "as you know Bob" exposition\n` +
                  `- Maintain the chapter's plot beats and emotional arc — don't change the story, just the prose quality\n` +
                  `- Ensure word count is at least ${wpc}\n\n` +
                  `CRITICAL OUTPUT RULES:\n` +
                  `1. Output the COMPLETE polished chapter as prose. No commentary. No "here's the revised version:" preamble.\n` +
                  `2. Do NOT output a list of changes or a critique.\n` +
                  `3. Do NOT shorten the chapter. The polished version should be the same length or longer.\n` +
                  `4. Start directly with the chapter content (or "# Chapter ${ch}: ..." heading).`;
                migrated++;
              }
            }
          }
          this.projects.set(p.id, p);
        }
        log.info(`  ✓ Restored ${state.projects.length} projects from disk` +
          (migrated > 0 ? ` (migrated ${migrated} legacy self-review step${migrated === 1 ? '' : 's'} to polish)` : ''));
        // Persist the migration so it doesn't run again on next boot.
        if (migrated > 0) this.persistState();
      }
    } catch (err) {
      log.error('  ⚠ Failed to load project state:', err);
    }
  }

  /**
   * Wire up AI capabilities so ProjectEngine can call the AI for dynamic planning.
   * Called after the router is initialized in index.ts.
   */
  setAI(complete: AICompleteFunc, selectProvider: AISelectProviderFunc): void {
    this.aiComplete = complete;
    this.aiSelectProvider = selectProvider;
  }

  setContextEngine(engine: ContextEngine): void {
    this.contextEngine = engine;
  }

  /**
   * Inject the tiered-memory service (Chunk B1). Follows the setContextEngine
   * pattern. When never called, memoryTier stays undefined and every CORE /
   * archival integration point falls back to the exact prior behavior.
   */
  setMemoryTier(tier: MemoryTierService): void {
    this.memoryTier = tier;
  }

  /**
   * Inject the gateway's message pipeline so the engine can execute project
   * steps through the full AI stack. Called from index.ts after the gateway
   * is constructed. Kept as a callback to avoid a circular import.
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Inject the subset of gateway services the step-execution hooks use
   * (quality judge, activity log, heartbeat, TTS, personas, aiRouter).
   */
  setStepServices(services: StepServices): void {
    this.stepServices = services || {};
  }

  // ── Novel Pipeline ──

  /**
   * Create a full novel pipeline project with 30+ steps covering all phases:
   * premise → book bible → outline → writing → revision → assembly
   */
  createNovelPipeline(title: string, description: string, config: NovelPipelineConfig = {}): Project {
    const id = `project-${this.nextId++}`;
    const now = new Date().toISOString();

    const { steps, chapters, wordsPerChapter } = buildNovelPipelineSteps(id, title, description, config);

    const project: Project = {
      id,
      type: 'novel-pipeline',
      title,
      description,
      status: 'pending',
      progress: 0,
      steps,
      createdAt: now,
      updatedAt: now,
      context: {
        planning: 'novel-pipeline',
        config,
        targetChapters: chapters,
        targetWordsPerChapter: wordsPerChapter,
        estimatedTotalWords: chapters * wordsPerChapter,
      },
    };

    this.projects.set(id, project);
    this.persistState();
    log.info(`  ✓ Novel pipeline created: "${title}" — ${steps.length} steps, ${chapters} chapters, ~${(chapters * wordsPerChapter).toLocaleString()} words target`);
    return project;
  }

  // ── Template Discovery ──

  /**
   * Return all available project templates for the dashboard
   */
  getTemplates(): Array<{ type: ProjectType; label: string; description: string; stepCount: number; stepCountLabel?: string }> {
    return PROJECT_TEMPLATES.map(t => ({
      type: t.type,
      label: t.label,
      description: t.description,
      stepCount: t.type === 'novel-pipeline' ? 30 : t.steps.length,
      stepCountLabel: t.type === 'novel-pipeline' ? '30+ auto-generated steps' : undefined,
    }));
  }

  // ── Dynamic Planning (The "Magic") ──

  /**
   * Ask the AI to decompose a task into steps dynamically.
   * This is the core "tell the agent what you want and it figures out the steps" feature.
   * Falls back to template-based planning if AI planning fails.
   */
  async planProject(
    title: string,
    description: string,
    skillCatalog: SkillCatalogEntry[],
    authorOSTools: string[],
    context?: Record<string, any>
  ): Promise<Project> {
    if (!this.aiComplete || !this.aiSelectProvider) {
      // No AI wired — fall back to template
      log.warn('  ⚠ AI not wired for planning — falling back to template');
      const type = this.inferProjectType(description);
      return this.createProject(type, title, description, context);
    }

    try {
      const provider = this.aiSelectProvider('general');

      // Build skill catalog for the planner prompt
      const skillList = skillCatalog.map(s =>
        `- **${s.name}** (${s.category}${s.premium ? ' ★' : ''}): ${s.description} [triggers: ${s.triggers.join(', ')}]`
      ).join('\n');

      const toolList = authorOSTools.length > 0
        ? `\n\nAuthor OS Tools Available:\n${authorOSTools.map(t => `- ${t}`).join('\n')}`
        : '';

      const validTaskTypes = Object.keys(TASK_TYPE_MAP).join(', ');

      const plannerPrompt = `You are a task planner for AuthorAgent, an autonomous AI writing agent.

The user wants to accomplish something. Your job is to break it down into a sequence of concrete, executable steps.

## Available Skills
${skillList}
${toolList}

## Valid Task Types
${validTaskTypes}

## Rules
1. Match step count to task complexity:
   - Simple tasks (write a blurb, intro, scene, short piece): 1-2 steps
   - Medium tasks (outline a story, research a topic, analyze style): 3-5 steps
   - Large tasks (write a full novel/book): 7-15 steps with ALL phases
2. ONLY plan full novel pipelines (premise → characters → world → outline → chapters → revision → assembly) when the user EXPLICITLY asks for a novel, book, or full manuscript
3. Each step should be a single, focused task
4. Reference specific skills by name when relevant
5. Use appropriate taskType for each step (affects which AI model is used)
6. Each step's prompt should be detailed enough to execute standalone
7. Later steps should reference earlier work naturally (e.g., "Using the characters we developed...")

## Output Format
Return ONLY valid JSON, no markdown fences, no explanation:
{"steps":[{"label":"step name","skill":"skill-name-or-null","taskType":"task_type","prompt":"detailed prompt for this step"}]}

## User's Request
Title: ${title}
Description: ${description}`;

      const result = await this.aiComplete({
        provider: provider.id,
        system: plannerPrompt,
        messages: [{ role: 'user', content: `Plan the steps to accomplish: ${description}` }],
        maxTokens: 4096,
        temperature: 0.3,
      });

      // Parse the AI's response
      const parsed = this.parsePlanResponse(result.text);

      if (parsed && parsed.steps && parsed.steps.length > 0) {
        // Build the project from AI-planned steps
        const id = `project-${this.nextId++}`;
        const now = new Date().toISOString();

        const steps: ProjectStep[] = parsed.steps.map((s: any, i: number) => ({
          id: `${id}-step-${i + 1}`,
          label: s.label || `Step ${i + 1}`,
          skill: s.skill && s.skill !== 'null' ? s.skill : undefined,
          taskType: s.taskType || 'general',
          prompt: s.prompt || description,
          status: 'pending' as const,
        }));

        // Enhance with Author OS
        const enhancedSteps = this.authorOS ? this.enhanceWithAuthorOS(steps) : steps;
        // Derive conductor dependencies (dynamic plans are linear → sequential).
        deriveDependencies(enhancedSteps);

        const project: Project = {
          id,
          type: this.inferProjectType(description),
          title,
          description,
          status: 'pending',
          progress: 0,
          steps: enhancedSteps,
          createdAt: now,
          updatedAt: now,
          context: { ...context, planning: 'dynamic', planProvider: result.provider },
        };

        this.projects.set(id, project);
        this.persistState();
        log.info(`  ✓ AI planned ${steps.length} steps for "${title}" (via ${result.provider})`);
        return project;
      }

      // If parsing failed, fall back to template
      log.warn('  ⚠ AI plan parsing failed — falling back to template');
      const type = this.inferProjectType(description);
      return this.createProject(type, title, description, context);

    } catch (error) {
      log.error('  ✗ AI planning failed:', error);
      const type = this.inferProjectType(description);
      return this.createProject(type, title, description, context);
    }
  }

  /**
   * Parse the AI's JSON plan response, handling common formatting issues
   */
  private parsePlanResponse(text: string): any {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
    cleaned = cleaned.trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // Try to extract JSON from mixed text
      const jsonMatch = cleaned.match(/\{[\s\S]*"steps"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch { /* fall through */ }
      }
      return null;
    }
  }

  // ── Project Lifecycle ──

  /**
   * Create a new project from a template or custom definition.
   * Returns the project with auto-planned steps.
   */
  createProject(
    type: ProjectType,
    title: string,
    description: string,
    context?: Record<string, any>
  ): Project {
    const id = `project-${this.nextId++}`;
    const now = new Date().toISOString();

    // Find matching template
    const template = PROJECT_TEMPLATES.find(t => t.type === type);

    let steps: ProjectStep[];

    if (template) {
      log.debug(`  Project "${title}": using template "${type}" with ${template.steps.length} steps`);
      steps = template.steps.map((s: any, i) => ({
        id: `${id}-step-${i + 1}`,
        label: s.label,
        skill: s.skill,
        toolSuggestion: s.toolSuggestion,
        taskType: s.taskType,
        prompt: this.expandTemplate(s.promptTemplate, { title, description, ...context }),
        status: 'pending' as const,
        // Preserve optional metadata from the template (phase, wordCountTarget, chapterNumber)
        ...(s.phase ? { phase: s.phase } : {}),
        ...(s.wordCountTarget ? { wordCountTarget: s.wordCountTarget } : {}),
        ...(s.chapterNumber ? { chapterNumber: s.chapterNumber } : {}),
      }));
    } else {
      // Custom project — single step with the user's description
      log.warn(`  Project "${title}": no template found for type "${type}" — creating single-step project`);
      steps = [{
        id: `${id}-step-1`,
        label: title,
        taskType: this.inferTaskType(description),
        prompt: description,
        status: 'pending',
      }];
    }

    // Enhance steps with Author OS tool suggestions if available
    if (this.authorOS) {
      steps = this.enhanceWithAuthorOS(steps);
    }

    // Derive conductor dependencies so this project can run under the parallel
    // supervisor (sequential fallback keeps single-step templates in order).
    deriveDependencies(steps);

    const project: Project = {
      id,
      type,
      title,
      description,
      status: 'pending',
      progress: 0,
      steps,
      createdAt: now,
      updatedAt: now,
      context: context || {},
    };

    this.projects.set(id, project);
    this.persistState();
    return project;
  }

  /**
   * Get a specific project by ID
   */
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /**
   * List all projects, optionally filtered by status
   */
  listProjects(status?: string): Project[] {
    const projects = Array.from(this.projects.values());
    if (status) {
      return projects.filter(p => p.status === status);
    }
    return projects;
  }

  /**
   * Start executing a project — marks it active and returns the first step
   */
  startProject(id: string): ProjectStep | null {
    const project = this.projects.get(id);
    if (!project) return null;

    project.status = 'active';
    project.updatedAt = new Date().toISOString();

    const firstPending = project.steps.find(s => s.status === 'pending');
    if (firstPending) {
      firstPending.status = 'active';
      return firstPending;
    }

    return null;
  }

  /**
   * Complete the current step and advance to the next.
   * Returns the next step, or null if the project is complete.
   */
  completeStep(projectId: string, stepId: string, result: string): ProjectStep | null {
    const project = this.projects.get(projectId);
    if (!project) return null;

    const step = project.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.result = result;
    }

    // Calculate progress (include skipped as "done")
    const done = project.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    project.progress = Math.round((done / project.steps.length) * 100);
    project.updatedAt = new Date().toISOString();

    // Find next step to run — prefer pending, then check for orphaned active steps
    // (active steps can occur from race conditions in concurrent auto-execute)
    const next = project.steps.find(s => s.status === 'pending')
              || project.steps.find(s => s.status === 'active' && s.id !== stepId);
    if (next) {
      next.status = 'active';
      // Enrich the next prompt with results from completed steps
      next.prompt = this.enrichWithPriorResults(next.prompt, project);
      return next;
    }

    // Truly all steps done — mark project complete only if no pending/active remain
    const remaining = project.steps.filter(s => s.status === 'pending' || s.status === 'active');
    if (remaining.length === 0) {
      project.status = 'completed';
      project.completedAt = new Date().toISOString();
      // Fire the completion hook (used by AutoSkill + UserModel observation).
      // Fire-and-forget so persistence isn't blocked by hook latency.
      try {
        for (const fn of this.completionHooks) {
          Promise.resolve(fn(project)).catch(err => log.error('[project-completion-hook] error:', err));
        }
      } catch (err) {
        // hook crashes never block completeStep
        logger.debug('project-completion hook dispatch failed', err);
      }
    }
    this.persistState();
    return null;
  }

  /**
   * Conductor variant of completeStep: mark the step completed + persist, but
   * do NOT auto-advance/activate a "next" step — the conductor supervisor owns
   * dispatch (it activates steps whose dependencies are satisfied). Still fires
   * the project-completion hooks + sets 'completed' status when no pending/active
   * steps remain, so completion semantics match completeStep for the last step.
   */
  completeStepBare(projectId: string, stepId: string, result: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;

    const step = project.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.result = result;
    }

    const done = project.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    project.progress = Math.round((done / project.steps.length) * 100);
    project.updatedAt = new Date().toISOString();

    const remaining = project.steps.filter(s => s.status === 'pending' || s.status === 'active');
    if (remaining.length === 0) {
      project.status = 'completed';
      project.completedAt = new Date().toISOString();
      try {
        for (const fn of this.completionHooks) {
          Promise.resolve(fn(project)).catch(err => log.error('[project-completion-hook] error:', err));
        }
      } catch (err) {
        logger.debug('project-completion hook dispatch failed', err);
      }
    }
    this.persistState();
  }

  /**
   * Open a step's review gate instead of completing it (M1.3 — ALP-1557).
   * Called by the executor in place of completeStep/completeStepBare when
   * resolveStepGate() (project-templates.ts) says the step gates on
   * completion. Delegates the state transition to applyStepCompletion — the
   * same pure function the gate state machine's own tests cover — so this
   * is just persistence + timestamp bookkeeping around it.
   *
   * Deliberately does NOT recompute "remaining steps" / project-completion —
   * an awaiting_review step is neither pending/active nor completed/skipped,
   * so it simply falls out of both checks: dependents stay blocked (conductor
   * ready-set) and the project is never mis-marked complete around it.
   */
  openStepGate(projectId: string, stepId: string, result: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    const step = project.steps.find(s => s.id === stepId);
    if (!step) return;

    applyStepCompletion(step, project, result);

    project.updatedAt = new Date().toISOString();
    this.persistState();
  }

  /**
   * Conductor helper: mark a specific pending step 'active' and enrich its
   * prompt with prior results (mirrors the activation the sequential completeStep
   * does for the "next" step). Called by the conductor at dispatch time.
   */
  activateStep(projectId: string, stepId: string): ProjectStep | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const step = project.steps.find(s => s.id === stepId);
    if (!step) return null;
    step.status = 'active';
    step.prompt = this.enrichWithPriorResults(step.prompt, project);
    project.updatedAt = new Date().toISOString();
    return step;
  }

  /** Callbacks invoked when a project transitions to 'completed' status. */
  private completionHooks: Array<(project: Project) => void | Promise<void>> = [];

  /** Register a callback fired on project completion. */
  onProjectCompleted(fn: (project: Project) => void | Promise<void>): void {
    this.completionHooks.push(fn);
  }

  /**
   * Mark a step as failed
   */
  failStep(projectId: string, stepId: string, error: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;

    const step = project.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'failed';
      step.error = error;
    }

    project.updatedAt = new Date().toISOString();
    this.persistState();
  }

  /**
   * Reset a single failed (or active) step back to pending so the user can
   * retry it. Clears the error message + result. Does NOT delete the step's
   * file output on disk — caller can do that separately if needed.
   *
   * Returns the step so the caller can re-run it via auto-execute / execute.
   */
  retryStep(projectId: string, stepId: string): ProjectStep | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const step = project.steps.find(s => s.id === stepId);
    if (!step) return null;
    if (step.status === 'completed') {
      // Allow re-running completed steps too (user wants a different output).
      // Keep the old result in step.error as a "previous attempt" marker.
      step.error = `[Previous output preserved on retry]\n${step.result?.substring(0, 500) || ''}`;
    }
    step.status = 'pending';
    step.error = step.error || undefined;
    step.result = undefined;
    project.status = 'active';
    project.updatedAt = new Date().toISOString();
    this.persistState();
    return step;
  }

  /**
   * Reset the entire project: every failed/active step → pending, project
   * status → pending. Useful when the user wants to clean-start after a
   * cluster of failures.
   *
   * Optionally deletes step output files from disk. The route handler is
   * responsible for actually unlinking files; this method only mutates state.
   *
   * Returns a summary of which steps were reset.
   */
  restartProject(projectId: string, opts: { keepCompleted?: boolean } = {}): {
    project: Project;
    reset: string[];
  } | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const reset: string[] = [];
    for (const step of project.steps) {
      if (step.status === 'failed' || step.status === 'active') {
        step.status = 'pending';
        step.error = undefined;
        step.result = undefined;
        reset.push(step.id);
      } else if (step.status === 'completed' && !opts.keepCompleted) {
        step.status = 'pending';
        step.error = undefined;
        step.result = undefined;
        reset.push(step.id);
      }
    }
    project.status = reset.length > 0 ? 'pending' : project.status;
    project.progress = 0;
    project.updatedAt = new Date().toISOString();
    this.persistState();
    return { project, reset };
  }

  /**
   * Skip a step
   */
  skipStep(projectId: string, stepId: string): ProjectStep | null {
    const project = this.projects.get(projectId);
    if (!project) return null;

    const step = project.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'skipped';
    }

    // Update progress
    const done = project.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    project.progress = Math.round((done / project.steps.length) * 100);
    project.updatedAt = new Date().toISOString();

    // Advance
    const next = project.steps.find(s => s.status === 'pending');
    if (next) {
      next.status = 'active';
      this.persistState();
      return next;
    }

    project.status = 'completed';
    project.completedAt = new Date().toISOString();
    this.persistState();
    return null;
  }

  /**
   * Pause a project
   */
  pauseProject(id: string): void {
    const project = this.projects.get(id);
    if (!project) return;
    project.status = 'paused';
    project.updatedAt = new Date().toISOString();

    // Pause any active steps
    project.steps.forEach(s => {
      if (s.status === 'active') s.status = 'pending';
    });
    this.persistState();
  }

  /**
   * Delete a project
   */
  deleteProject(id: string): boolean {
    const result = this.projects.delete(id);
    if (result) this.persistState();
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  // Step Execution — thin pass-throughs to StepExecutor
  // (retry, continuation, quality loop, hooks). The implementation lives in
  // step-executor.ts; these delegate so no route/index.ts call site changes.
  // ═══════════════════════════════════════════════════════════

  /**
   * Returns true if the step requires the FULL manuscript in context (not a
   * truncated excerpt). Revision-apply steps must see the whole book to rewrite
   * it correctly.
   */
  stepNeedsFullManuscript(step: any): boolean {
    return this.stepExecutor.stepNeedsFullManuscript(step);
  }

  /**
   * Build the user message for project step execution.
   * Injects uploaded manuscript DIRECTLY into the user message so the AI can't
   * miss it. For large documents (15K+ words): reads from disk and applies
   * smart truncation.
   */
  async buildStepUserMessage(project: any, step: any): Promise<string> {
    return this.stepExecutor.buildStepUserMessage(project, step);
  }

  /**
   * Execute the project's currently-active step through the injected message
   * handler, with a single short-response retry that falls back to free-tier
   * ('general') routing. Detects the [AI provider failure] sentinel and
   * unusably-short responses, marking the step failed in those cases.
   *
   * This is the thin single-step path used by POST /api/projects/:id/execute.
   * It does NOT run word-count continuation, the quality loop, or the
   * file-save / context-engine / auto-narrate / assembly hooks — matching the
   * original route behavior exactly.
   *
   * Returns a discriminated result the route serializes directly.
   */
  async executeStepWithRetry(projectId: string):
    Promise<
      | { ok: true; completedStep: string; response: string; nextStep: ProjectStep | null; project: Project }
      | { ok: false; kind: 'no-project' }
      | { ok: false; kind: 'no-active-step' }
      | { ok: false; kind: 'provider-failure'; detail: string; project: Project }
      | { ok: false; kind: 'short-response'; reason: string; project: Project }
      | { ok: false; kind: 'error'; error: string; project: Project }
    > {
    return this.stepExecutor.executeStepWithRetry(projectId);
  }

  /**
   * Fully autonomous mode: loop over ALL active steps of a project, executing
   * each through the message pipeline. Long-running — can run for many minutes
   * or hours. Honors external pause/complete transitions (via /pause, /stop, or
   * the dashboard) by re-checking project status at the top of each iteration
   * AND immediately after each step's (potentially long) AI call.
   *
   * Preserves the exact behavior of the former route handler:
   *  - short-response retry (1x) with 'general' routing
   *  - [AI provider failure] + unusably-short detection → failStep + stop
   *  - word-count continuation (revision-apply / writing steps), max 6 passes
   *  - AutoNovel-style quality loop (judge → retry with feedback)
   *  - per-step file save, heartbeat word tracking
   *  - context-engine summary/entity hooks, auto-narrate, manuscript assembly
   *
   * Uses channel 'project-engine' (matching the original loop).
   */
  async autoExecuteLoop(projectId: string, opts: ExecuteStepOptions): Promise<{
    results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }>;
    project: Project | undefined;
  }> {
    return this.stepExecutor.autoExecuteLoop(projectId, opts);
  }

  /**
   * Build the system prompt addition for a project step.
   * This tells the AI what context it's operating in.
   */
  async buildProjectContext(project: Project, step: ProjectStep): Promise<string> {
    let context = `\n# Current Project\n\n`;
    context += `**Project**: ${project.title}\n`;
    context += `**Type**: ${project.type}\n`;
    context += `**Progress**: ${project.progress}% (step ${project.steps.indexOf(step) + 1} of ${project.steps.length})\n`;
    context += `**Current Step**: ${step.label}\n\n`;

    // ── CORE STORY MEMORY (Chunk B1) ──
    // Prepend the tiered CORE block (budgeted ≤3,500 chars) so the always-in
    // active chapter state / key characters / open threads / style / world
    // rules ride at the top of the project context for EVERY project type —
    // including book-production and non-novel-pipeline types that never touched
    // ContextEngine before. Purely additive; guarded on the flag + a non-null
    // memoryTier + a non-empty result, so search-off / no-cache degrades to the
    // exact prior context byte-for-byte.
    if (CORE_INJECTION_ENABLED && this.memoryTier) {
      try {
        // buildCore reads the ContextEngine's IN-MEMORY cache, which is lazily
        // populated. Ensure this project's persisted context (chapter summaries
        // + entity index) is hydrated before we read it — idempotent + cached,
        // and it degrades to an empty context if nothing is on disk.
        if (this.contextEngine) {
          await this.contextEngine.loadContext(project.id).catch(() => {});
        }
        const core = this.memoryTier.buildCore(
          project.id,
          this.resolveActiveChapterNumber(project, step),
          step.prompt || '',
        );
        if (core) context += `${core}\n\n`;
      } catch (err) {
        // Never let CORE assembly break a step — degrade to no CORE block.
        logger.debug('[memory-tier] buildCore failed', err);
      }
    }

    // ── ARCHIVAL trigger (Chunk B1) ──
    // On revision / consistency / book-production steps, pull budgeted excerpts
    // (≤2,000 chars) from the FTS archive keyed on the step prompt + active
    // character names. Additive; guarded on memoryTier + (internally) on
    // memorySearch availability, so with search off this contributes nothing.
    if (CORE_INJECTION_ENABLED && this.memoryTier && this.stepWantsArchival(project, step)) {
      try {
        const query = this.buildArchivalQuery(project, step);
        const archival = this.memoryTier.searchArchival(query, {
          limit: 6,
          projectId: project.id,
          sources: ['manuscript', 'project_step'],
        });
        if (archival) context += `${archival}\n\n`;
      } catch (err) {
        logger.debug('[memory-tier] searchArchival failed', err);
      }
    }

    // Novel pipeline: phase-aware context accumulation
    if (project.type === 'novel-pipeline' && step.phase) {
      context += this.buildNovelPipelineContext(project, step);
    } else if (project.type === 'book-production') {
      // Book production: per-chapter scope. The polish step needs the FULL
      // prior write step (the chapter to revise) — truncating it would force
      // the AI to half-revise from a fragment. Other writing steps just need
      // compact summaries of prior chapters so the AI has continuity without
      // the context window exploding on chapter 25.
      context += this.buildBookProductionContext(project, step);
    } else {
      // Default: add results from prior steps
      const completedSteps = project.steps.filter(s => s.status === 'completed' && s.result);
      if (completedSteps.length > 0) {
        context += `## Previous Steps Completed\n\n`;
        for (const cs of completedSteps) {
          context += `### ${cs.label}\n`;
          const result = cs.result!;
          if (result.length > 2000) {
            context += `[...truncated...]\n${result.slice(-2000)}\n\n`;
          } else {
            context += `${result}\n\n`;
          }
        }
      }
    }

    // Include uploaded manuscript content (from Upload button).
    //
    // DE-DUP (Chunk B1): buildStepUserMessage (step-executor.ts) already injects
    // the manuscript into the USER message — from uploadedContent (inline) or
    // documentLibraryFile (disk). Injecting the same text again here in the
    // SYSTEM context wastes tokens (the manuscript was going out TWICE per
    // step). Only include the system-side copy when the user message will NOT
    // already carry it, i.e. when there is no documentLibraryFile. When present,
    // we still keep the lightweight file-list header for orientation but skip
    // the (duplicated) body.
    if (project.context?.uploadedContent) {
      const uploads = project.context.uploads || [];
      const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount} words)`).join(', ');
      const userMessageCarriesManuscript = !!project.context?.documentLibraryFile
        || !!project.context?.uploadedContent;
      context += `## Uploaded Manuscript\n\n`;
      context += `**Files**: ${fileList}\n\n`;
      if (userMessageCarriesManuscript) {
        // Body is already in the user message — don't duplicate it here.
        context += `_(Full manuscript text is provided in the task message below.)_\n\n`;
      } else {
        // Include up to 30k chars of uploaded content for the AI to work with
        const uploaded = String(project.context.uploadedContent);
        if (uploaded.length > 30000) {
          context += uploaded.substring(0, 30000) + '\n\n[...truncated at 30,000 chars — full text available in workspace...]\n\n';
        } else {
          context += uploaded + '\n\n';
        }
      }
    }

    // Inject Core Lessons from self-improvement analysis (if available)
    // These are distilled insights from all previous completed projects
    const coreLessons = await this.getCoreLessons();
    if (coreLessons) {
      context += `\n## Writing Lessons Learned\n\n${coreLessons}\n\n`;
    }

    // Add Author OS tool suggestion with actionable instructions
    if (step.toolSuggestion) {
      const toolInstructions: Record<string, string> = {
        'workflow-engine': 'Load the relevant JSON workflow template and follow its step sequence.',
        'book-bible': 'Use the Book Bible data for character/world consistency checks.',
        'manuscript-autopsy': 'Run manuscript analysis for pacing and structure feedback.',
        'format-factory': 'Use Format Factory Pro: python format_factory_pro.py <input> -t "Title" --all',
        'creator-asset-suite': 'Generate marketing assets using the Creator Asset Suite tools.',
        'ai-author-library': 'Reference writing prompts and voice markers from the library.',
      };
      context += `\n**Suggested Tool**: Author OS ${step.toolSuggestion}\n`;
      const instruction = toolInstructions[step.toolSuggestion];
      if (instruction) {
        context += `**How to use**: ${instruction}\n`;
      }
    }

    return context;
  }

  // ── Tiered-memory integration helpers (Chunk B1) ──────────

  /**
   * Best-effort "active chapter number" for CORE assembly. Prefers the current
   * step's own chapterNumber; else the max chapterNumber across the project's
   * steps; else the count of completed writing/polish chapters + 1; else 1.
   * Pure, never throws — CORE degrades to '' if summaries don't line up anyway.
   */
  private resolveActiveChapterNumber(project: Project, step: ProjectStep): number {
    const own = Number((step as any).chapterNumber);
    if (Number.isFinite(own) && own > 0) return own;

    let maxCh = 0;
    for (const s of project.steps) {
      const ch = Number((s as any).chapterNumber);
      if (Number.isFinite(ch) && ch > maxCh) maxCh = ch;
    }
    if (maxCh > 0) return maxCh;

    const writtenDone = project.steps.filter(
      s => (s.skill === 'write' || s.phase === 'polish' || s.phase === 'writing') && s.status === 'completed',
    ).length;
    return writtenDone > 0 ? writtenDone + 1 : 1;
  }

  /**
   * True if this step should pull ARCHIVAL excerpts: revision / consistency
   * steps (by taskType or phase) or ANY step of a book-production project
   * (design: "revision/consistency/book-production"). Pure, no I/O.
   */
  private stepWantsArchival(project: Project, step: ProjectStep): boolean {
    if (project.type === 'book-production') return true;
    const taskType = String((step as any).taskType || '').toLowerCase();
    const phase = String((step as any).phase || '').toLowerCase();
    return (
      taskType === 'revision' ||
      taskType === 'consistency' ||
      phase === 'revision' ||
      phase === 'revision_apply'
    );
  }

  /**
   * Build the archival FTS query: the step prompt plus the names of characters
   * active in (or near) the current chapter, so the search surfaces prior
   * manuscript passages featuring those characters. Falls back to the prompt
   * alone when no ContextEngine/entities are available. Pure, never throws.
   */
  private buildArchivalQuery(project: Project, step: ProjectStep): string {
    const promptPart = (step.prompt || '').slice(0, 400);
    const names = this.getActiveCharacterNames(project, step);
    return names.length > 0 ? `${promptPart} ${names.join(' ')}` : promptPart;
  }

  /**
   * Names of characters active near the current chapter, from the ContextEngine
   * entity index / chapter summaries. Empty when no context is cached. Capped
   * so the query stays small. Pure, guarded, never throws.
   */
  private getActiveCharacterNames(project: Project, step: ProjectStep): string[] {
    if (!this.contextEngine) return [];
    try {
      const activeCh = this.resolveActiveChapterNumber(project, step);
      const summaries = this.contextEngine.getSummaries(project.id);
      const names = new Set<string>();
      // Characters named in the active (or nearest prior) chapter summary.
      const nearby = summaries.filter(s => s.chapterNumber <= activeCh).slice(-2);
      for (const s of nearby) {
        for (const c of s.characters ?? []) {
          const n = (c ?? '').trim();
          if (n) names.add(n);
        }
      }
      // Backfill with top entity-index characters if the summary yielded few.
      if (names.size < 3) {
        for (const c of this.contextEngine.getEntitiesByType(project.id, 'character')) {
          if (names.size >= 6) break;
          const n = (c.name ?? '').trim();
          if (n) names.add(n);
        }
      }
      return [...names].slice(0, 6);
    } catch {
      return [];
    }
  }

  /**
   * Phase-aware context for book-production projects.
   *
   * For polish steps: includes the FULL preceding write step (the chapter to
   * revise) at unlimited length, plus compact 200-word endings of older
   * chapters for continuity. Without this, the polish step's AI was getting
   * a 2000-char fragment of the chapter and producing inconsistent rewrites.
   *
   * For write steps: includes compact summaries of prior chapters so chapter
   * 25 doesn't cost 60K tokens of full prior-chapter context.
   */
  private buildBookProductionContext(project: Project, step: ProjectStep): string {
    const stepIdx = project.steps.indexOf(step);
    const stepCh = (step as any).chapterNumber || 0;
    const isPolish = step.phase === 'polish';
    const isWrite = step.skill === 'write';

    let context = '';
    const completed = project.steps.filter(s => s.status === 'completed' && s.result);
    if (completed.length === 0) return context;

    if (isPolish && stepIdx > 0) {
      // The Write step for the same chapter is immediately prior. Find it
      // explicitly rather than relying on indexOf order.
      const writeStep = project.steps.find(s =>
        s.skill === 'write' &&
        (s as any).chapterNumber === stepCh &&
        s.status === 'completed' && s.result);
      if (writeStep) {
        context += `## Chapter ${stepCh} — first draft (revise this)\n\n`;
        context += writeStep.result!;
        context += '\n\n';
      }
      // Also include 1-line endings of earlier chapters for tone continuity.
      const earlier = completed.filter(s =>
        s.skill === 'write' && ((s as any).chapterNumber || 0) < stepCh);
      if (earlier.length > 0) {
        context += `## Earlier chapter endings (for continuity)\n\n`;
        for (const e of earlier.slice(-3)) {
          const ch = (e as any).chapterNumber;
          const tail = (e.result || '').slice(-300).replace(/\s+/g, ' ');
          context += `Ch ${ch} ended: ${tail}\n\n`;
        }
      }
      return context;
    }

    if (isWrite && stepCh > 1) {
      // For chapter N's write step, give last 1-2 polished/written chapters
      // in compact form. Pick polish output if available, write otherwise.
      const priorChapters = new Map<number, ProjectStep>();
      for (const s of completed) {
        const ch = (s as any).chapterNumber || 0;
        if (ch === 0 || ch >= stepCh) continue;
        const existing = priorChapters.get(ch);
        if (!existing) priorChapters.set(ch, s);
        else if (s.phase === 'polish' && existing.phase !== 'polish') priorChapters.set(ch, s);
      }
      const sortedChapters = Array.from(priorChapters.values())
        .sort((a, b) => ((a as any).chapterNumber || 0) - ((b as any).chapterNumber || 0));

      // Include full prose of the most recent chapter, summary of older ones.
      const lastTwo = sortedChapters.slice(-2);
      const olderOnes = sortedChapters.slice(0, -2);

      if (olderOnes.length > 0) {
        context += `## Earlier chapters (compact summary)\n\n`;
        for (const e of olderOnes) {
          const ch = (e as any).chapterNumber;
          const r = (e.result || '');
          // First 100 + last 100 chars to give opening + ending feel
          const head = r.slice(0, 200).replace(/\s+/g, ' ');
          const tail = r.slice(-200).replace(/\s+/g, ' ');
          context += `**Ch ${ch}** opening: ${head}\n  ending: ${tail}\n\n`;
        }
      }
      if (lastTwo.length > 0) {
        context += `## Most recent chapter${lastTwo.length === 1 ? '' : 's'} (full)\n\n`;
        for (const e of lastTwo) {
          const ch = (e as any).chapterNumber;
          const phaseLabel = e.phase === 'polish' ? 'polished' : 'first draft';
          context += `### Chapter ${ch} (${phaseLabel})\n\n`;
          // Cap at 4000 chars per chapter so context doesn't blow up at high N.
          const r = e.result || '';
          context += (r.length > 4000 ? r.slice(0, 2000) + '\n[...]\n' + r.slice(-2000) : r);
          context += '\n\n';
        }
      }
      return context;
    }

    // Other steps (assembly, etc.) — modest history.
    const recent = completed.slice(-3);
    if (recent.length > 0) {
      context += `## Recent steps\n\n`;
      for (const r of recent) {
        const trunc = (r.result || '').length > 1500
          ? (r.result || '').slice(-1500) : (r.result || '');
        context += `### ${r.label}\n${trunc}\n\n`;
      }
    }
    return context;
  }

  /**
   * Build phase-aware context for novel pipeline steps.
   * Each phase gets relevant prior outputs without overwhelming the context window.
   */
  private buildNovelPipelineContext(project: Project, step: ProjectStep): string {
    let context = '';
    const completed = project.steps.filter(s => s.status === 'completed' && s.result);

    const getPhaseResults = (phase: string) =>
      completed.filter(s => s.phase === phase);

    const truncate = (text: string, max: number) =>
      text.length > max ? text.slice(0, max) + '\n\n[...truncated...]' : text;

    switch (step.phase) {
      case 'premise': {
        // First premise step gets just the config; second gets first premise result
        const priorPremise = getPhaseResults('premise');
        if (priorPremise.length > 0) {
          context += `## Prior Premise Work\n\n${priorPremise.map(s => s.result).join('\n\n')}\n\n`;
        }
        break;
      }

      case 'bible': {
        // Bible steps get the full premise
        const premiseResults = getPhaseResults('premise');
        if (premiseResults.length > 0) {
          context += `## Premise\n\n${premiseResults.map(s => s.result).join('\n\n')}\n\n`;
        }
        // Plus any prior bible steps
        const priorBible = getPhaseResults('bible').filter(s => s.id !== step.id);
        if (priorBible.length > 0) {
          context += `## Book Bible (so far)\n\n`;
          for (const bs of priorBible) {
            context += `### ${bs.label}\n${truncate(bs.result!, 1500)}\n\n`;
          }
        }
        break;
      }

      case 'outline': {
        // Outline gets premise + summarized bible
        const premiseResults = getPhaseResults('premise');
        if (premiseResults.length > 0) {
          context += `## Premise\n\n${truncate(premiseResults.map(s => s.result).join('\n\n'), 3000)}\n\n`;
        }
        const bibleResults = getPhaseResults('bible');
        if (bibleResults.length > 0) {
          context += `## Book Bible\n\n`;
          for (const bs of bibleResults) {
            context += `### ${bs.label}\n${truncate(bs.result!, 1000)}\n\n`;
          }
        }
        // Prior outline steps
        const priorOutline = getPhaseResults('outline').filter(s => s.id !== step.id);
        if (priorOutline.length > 0) {
          context += `## Outline (so far)\n\n${priorOutline.map(s => s.result).join('\n\n')}\n\n`;
        }
        break;
      }

      case 'writing': {
        // Writing steps get: premise (brief) + bible (summaries) + outline + last 2 chapters (sliding window)
        const premiseResults = getPhaseResults('premise');
        if (premiseResults.length > 0) {
          context += `## Premise\n\n${truncate(premiseResults.map(s => s.result).join('\n\n'), 1500)}\n\n`;
        }
        const bibleResults = getPhaseResults('bible');
        if (bibleResults.length > 0) {
          context += `## Book Bible (key details)\n\n`;
          for (const bs of bibleResults) {
            context += `### ${bs.label}\n${truncate(bs.result!, 600)}\n\n`;
          }
        }
        // Full outline
        const outlineResults = getPhaseResults('outline');
        if (outlineResults.length > 0) {
          context += `## Outline\n\n${truncate(outlineResults.map(s => s.result).join('\n\n'), 4000)}\n\n`;
        }
        // Try ContextEngine first for smarter context
        const engineContext = this.contextEngine?.getRelevantContext(project.id, step.id, step.prompt || '', 12000);
        if (engineContext && engineContext.length > 100) {
          context += engineContext + '\n\n';
        } else {
          // Fall back to existing sliding window behavior
          // Sliding window: last 2 completed chapter results
          const writtenChapters = getPhaseResults('writing');
          if (writtenChapters.length > 0) {
            const recent = writtenChapters.slice(-2);
            context += `## Recent Chapters (for continuity)\n\n`;
            for (const ch of recent) {
              context += `### ${ch.label}\n${truncate(ch.result!, 2000)}\n\n`;
            }
          }
        }  // end fallback
        break;
      }

      case 'revision': {
        // Revision gets: bible summaries + outline summary + all chapter summaries
        const bibleResults = getPhaseResults('bible');
        if (bibleResults.length > 0) {
          context += `## Book Bible\n\n`;
          for (const bs of bibleResults) {
            context += `### ${bs.label}\n${truncate(bs.result!, 800)}\n\n`;
          }
        }
        const outlineResults = getPhaseResults('outline');
        if (outlineResults.length > 0) {
          context += `## Outline\n\n${truncate(outlineResults.map(s => s.result).join('\n\n'), 3000)}\n\n`;
        }
        // Brief summaries of all chapters.
        //
        // BUG FIX (Chunk B1): the old code used truncate(ch.result!, 500), which
        // is slice(0, 500) — it kept only each chapter's OPENING and threw away
        // the ENDING. For a consistency/revision pass that is exactly backwards:
        // continuity errors live at chapter boundaries (how a chapter ENDS vs
        // how the next BEGINS). Prefer the ContextEngine's ChapterSummary (a
        // real summary of the whole chapter + its endingState) when available;
        // fall back to the old opening slice only when no summary is cached, so
        // behavior is a strict superset of before.
        const writtenChapters = getPhaseResults('writing');
        if (writtenChapters.length > 0) {
          const summaries = this.contextEngine?.getSummaries(project.id) ?? [];
          const summaryByChapterId = new Map(summaries.map(s => [s.chapterId, s]));
          context += `## Chapter Drafts (summaries)\n\n`;
          for (const ch of writtenChapters) {
            const cs = summaryByChapterId.get(ch.id);
            if (cs && (cs.summary || cs.endingState)) {
              const body = cs.summary
                ? `${cs.summary}${cs.endingState ? `\n\n**Chapter ends:** ${cs.endingState}` : ''}`
                : `**Chapter ends:** ${cs.endingState}`;
              context += `### ${ch.label}\n${truncate(body, 900)}\n\n`;
            } else {
              // No cached summary — fall back to the original opening slice.
              context += `### ${ch.label}\n${truncate(ch.result!, 500)}\n\n`;
            }
          }
        }
        break;
      }

      case 'assembly': {
        // Assembly gets a brief overview of everything
        const totalWords = getPhaseResults('writing').reduce((sum, s) => {
          return sum + (s.result?.split(/\s+/).length || 0);
        }, 0);
        context += `## Pipeline Summary\n\n`;
        context += `- Chapters written: ${getPhaseResults('writing').length}\n`;
        context += `- Approximate total words: ${totalWords.toLocaleString()}\n`;
        context += `- Revision steps completed: ${getPhaseResults('revision').length}\n\n`;
        // Include consistency check results if available
        const consistencyCheck = completed.find(s => s.label === 'Consistency check');
        if (consistencyCheck?.result) {
          context += `## Consistency Check Results\n\n${truncate(consistencyCheck.result, 3000)}\n\n`;
        }
        break;
      }

      default: {
        // Fallback: include all prior results (truncated)
        for (const cs of completed) {
          context += `### ${cs.label}\n${truncate(cs.result!, 1000)}\n\n`;
        }
      }
    }

    return context;
  }

  // ── Smart Project from Natural Language ──

  /**
   * Infer the best project type from a natural language description.
   * Used when the user just says what they want without specifying a type.
   */
  inferProjectType(description: string): ProjectType {
    const lower = description.toLowerCase();

    // Novel pipeline signals — ONLY when explicitly asking for a full novel/book
    if (lower.match(/\b(novel|full book|write a book|write my book|entire book|complete novel|full manuscript|book from scratch|novel pipeline|write a complete)\b/)) {
      return 'novel-pipeline';
    }

    // Pipeline signals — wants the full production chain
    if (lower.match(/\b(pipeline|full production|end.?to.?end|planning through launch|all phases)\b/)) {
      return 'pipeline';
    }

    // Book Planning signals
    if (lower.match(/\b(plan|outline|structure|plot|brainstorm|concept|story map|beat sheet|premise|logline|synopsis)\b/)) {
      return 'book-planning';
    }

    // Book Bible signals
    if (lower.match(/\b(world.?build|book.?bible|bible|magic system|timeline|backstory|lore|character bible|continuity)\b/)) {
      return 'book-bible';
    }

    // Book Production signals
    if (lower.match(/\b(chapter|scene|prose|manuscript|draft|write.*chapter|write.*scene|book production)\b/)) {
      return 'book-production';
    }

    // Deep revision signals — must come before general revision
    if (lower.match(/\b(deep.?revis|deep.?edit|full.?revision|manuscript.?review|beta.?reader|comprehensive.?edit|revision.?pipeline|deep.?analysis|manuscript.?analysis|manuscript.?audit|edit.*book|revise|rewrite|feedback|critique|proofread|consistency)\b/)) {
      return 'deep-revision';
    }

    // Format & Export signals
    if (lower.match(/\b(export|format|compile|epub|pdf|docx|publish|kdp|kindle|front matter|back matter)\b/)) {
      return 'format-export';
    }

    // Book Launch signals
    if (lower.match(/\b(launch|blurb|amazon desc|keywords|ad copy|advertise|promote|market|social media|book description|categories)\b/)) {
      return 'book-launch';
    }

    // Default: let the AI planner figure out the best approach
    return 'custom';
  }

  /**
   * Create a full pipeline: chains all 6 project phases from a single idea.
   * Each phase is a separate sub-project linked by pipelineId.
   */
  createPipeline(
    title: string,
    description: string,
    personaId?: string,
    config?: NovelPipelineConfig
  ): { pipelineId: string; projects: Project[] } {
    const pipelineId = `pipeline-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    const phases: Array<{ type: ProjectType; label: string; phaseNum: number }> = [
      { type: 'book-planning', label: `${title} — Planning`, phaseNum: 1 },
      { type: 'book-bible', label: `${title} — Book Bible`, phaseNum: 2 },
      { type: 'book-production', label: `${title} — Production`, phaseNum: 3 },
      { type: 'deep-revision', label: `${title} — Deep Revision`, phaseNum: 4 },
      { type: 'format-export', label: `${title} — Format & Export`, phaseNum: 5 },
      { type: 'book-launch', label: `${title} — Book Launch`, phaseNum: 6 },
    ];

    const projects: Project[] = [];
    for (const phase of phases) {
      let project: Project;
      if (phase.type === 'book-production') {
        // Book production uses the novel pipeline chapter-writing logic
        project = this.createBookProduction(phase.label, description, config);
      } else {
        project = this.createProject(phase.type, phase.label, description, { pipelineTitle: title, ...config });
      }
      project.pipelineId = pipelineId;
      project.pipelinePhase = phase.phaseNum;
      if (personaId) project.personaId = personaId;
      projects.push(project);
    }

    // Only the first phase starts as pending-ready; others wait
    // (Pipeline advancement is managed by the dashboard/API)
    this.persistState();
    return { pipelineId, projects };
  }

  /**
   * Create a Book Production project with dynamic chapter steps.
   */
  createBookProduction(title: string, description: string, config: NovelPipelineConfig = {}): Project {
    const id = `project-${this.nextId++}`;
    const now = new Date().toISOString();

    const { steps, chapters, wordsPerChapter } = buildBookProductionSteps(id, title, description, config);

    const project: Project = {
      id,
      type: 'book-production',
      title,
      description,
      status: 'pending',
      progress: 0,
      steps,
      createdAt: now,
      updatedAt: now,
      context: {
        targetChapters: chapters,
        targetWordsPerChapter: wordsPerChapter,
        estimatedTotalWords: chapters * wordsPerChapter,
        ...config,
      },
    };

    this.projects.set(id, project);
    this.persistState();
    return project;
  }

  /**
   * Get all projects belonging to a pipeline.
   */
  getPipelineProjects(pipelineId: string): Project[] {
    return Array.from(this.projects.values())
      .filter(p => p.pipelineId === pipelineId)
      .sort((a, b) => (a.pipelinePhase || 0) - (b.pipelinePhase || 0));
  }

  // ── Core Lessons (self-improvement feedback loop) ──

  /**
   * Load Core Lessons from the self-improvement analysis file.
   * Cached for 5 minutes to avoid re-reading disk every step.
   * Returns null if no core lessons exist yet.
   */
  private async getCoreLessons(): Promise<string | null> {
    const now = Date.now();
    // Return cached version if less than 5 minutes old
    if (this.coreLessonsCache !== null && (now - this.coreLessonsCacheTime) < 300000) {
      return this.coreLessonsCache;
    }

    const coreLessonsPath = join(this.rootDir, 'workspace', '.agent', 'core-lessons.md');
    if (!existsSync(coreLessonsPath)) {
      this.coreLessonsCache = null;
      this.coreLessonsCacheTime = now;
      return null;
    }

    try {
      const content = await readFile(coreLessonsPath, 'utf-8');
      // Strip the header, just get the lessons content (max 1500 chars to not bloat context)
      const body = content.replace(/^#.*\n\n\*[^*]+\*\n\n/, '').trim();
      this.coreLessonsCache = body.length > 1500 ? body.substring(0, 1500) + '\n...' : body;
      this.coreLessonsCacheTime = now;
      return this.coreLessonsCache;
    } catch {
      this.coreLessonsCache = null;
      this.coreLessonsCacheTime = now;
      return null;
    }
  }

  // ── Private Helpers ──

  private expandTemplate(template: string, vars: Record<string, any>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string') {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
    }
    // Clean up any remaining unexpanded vars
    result = result.replace(/\{\{[^}]+\}\}/g, '');
    return result;
  }

  private inferTaskType(description: string): string {
    const type = this.inferProjectType(description);
    const taskMap: Record<ProjectType, string> = {
      'book-planning': 'outline',
      'book-bible': 'book_bible',
      'book-production': 'creative_writing',
      'deep-revision': 'revision',
      'format-export': 'general',
      'book-launch': 'marketing',
      'novel-pipeline': 'creative_writing',
      pipeline: 'general',
      custom: 'general',
    };
    return taskMap[type] || 'general';
  }

  private enhanceWithAuthorOS(steps: ProjectStep[]): ProjectStep[] {
    if (!this.authorOS) return steps;

    const availableTools = this.authorOS.getAvailableTools();
    return steps.map(step => {
      // If the step suggests a tool, check if it's available
      if (step.toolSuggestion && !availableTools.includes(step.toolSuggestion)) {
        // Tool not available — clear suggestion but keep the step
        step.toolSuggestion = undefined;
      }
      return step;
    });
  }

  private enrichWithPriorResults(prompt: string, project: Project): string {
    // Prior step results are already included in buildProjectContext() system context.
    // Don't duplicate them in the user message — it wastes tokens and can confuse the AI.
    // Just add a brief note referencing the previous step so the AI knows to build on it.
    if (prompt.includes('we developed') || prompt.includes('we created')) {
      return prompt;
    }

    const lastCompleted = [...project.steps].reverse().find(s => s.status === 'completed' && s.result);
    if (lastCompleted) {
      return `[Build on the work from "${lastCompleted.label}" — see system context for details.]\n\n${prompt}`;
    }

    return prompt;
  }
}

/**
 * AuthorAgent Step Executor
 *
 * Extracted verbatim from projects.ts (Phase 2 refactor). Owns the
 * step-execution engine that ProjectEngine previously inlined:
 *   - executeStepWithRetry  (single-step path, POST /api/projects/:id/execute)
 *   - autoExecuteLoop       (fully autonomous multi-step loop)
 *   - buildStepUserMessage  (injects manuscript into the user message)
 *   - getSmartExcerpt       (head+tail excerpt for large manuscripts)
 *   - stepNeedsFullManuscript (revision-apply detection)
 *
 * This module has NO import of ProjectEngine. It reaches the state machine +
 * context builder through a narrow `EnginePort` interface (composition, not a
 * god-object). The message handler, step-service bundle, and context engine
 * are passed in so behavior — thresholds, retry counts, word-count
 * continuation, quality loop, file-save/context-engine/auto-narrate/assembly
 * hooks, channel names — is preserved exactly.
 */

import type { ContextEngine } from './context-engine.js';
import { generateDocxBuffer } from './docx-export.js';
import { logger } from './logger.js';
import { docVersionService } from './doc-versions.js';
import { projectOutputDir, stepOutputFileName, legacyProjectOutputDir } from './project-paths.js';
import type {
  Project,
  ProjectStep,
} from './project-templates.js';

const log = logger.child('[projects]');

/**
 * The gateway's message-pipeline entry point, injected so the executor can
 * run a step through the full AI stack (routing, fallback, injection checks,
 * cost tracking) WITHOUT importing the gateway class — that would create a
 * circular dependency. Signature mirrors AuthorAgentGateway.handleMessage.
 */
export type MessageHandler = (
  content: string,
  channel: string,
  respond: (text: string) => void,
  extraContext?: string,
  overrideTaskType?: string,
  preferredProvider?: string
) => Promise<void>;

/**
 * The narrow slice of gateway services the step-execution hooks need
 * (quality judge, activity feed, heartbeat word tracking, TTS, personas).
 * Injected as a bundle so the executor stays decoupled from the gateway.
 * All members are optional/duck-typed — hooks degrade gracefully if absent.
 */
export interface StepServices {
  writingJudge?: any;
  activityLog?: any;
  heartbeat?: any;
  tts?: any;
  personas?: any;
  aiRouter?: any;
}

/**
 * Options for a single step execution / the auto-execute loop.
 * `workspaceDir` lets the engine write step output files to the same
 * location the routes previously used (baseDir/workspace).
 */
export interface ExecuteStepOptions {
  workspaceDir: string;
}

/**
 * The narrow surface the executor needs from the ProjectEngine — the state
 * machine + context builder. ProjectEngine implements this by delegating to
 * its own methods. Passing this in (rather than the whole engine) keeps the
 * executor free of a back-import to ProjectEngine and documents exactly what
 * it touches.
 */
export interface EnginePort {
  getProject(id: string): Project | undefined;
  completeStep(projectId: string, stepId: string, result: string): ProjectStep | null;
  /**
   * Conductor variant: mark a step completed WITHOUT auto-advancing/activating
   * a next step (the supervisor owns dispatch). Fires completion hooks + sets
   * 'completed' status when nothing remains, like completeStep for the last step.
   */
  completeStepBare(projectId: string, stepId: string, result: string): void;
  /** Mark a specific pending step 'active' + enrich its prompt (conductor dispatch). */
  activateStep(projectId: string, stepId: string): ProjectStep | null;
  failStep(projectId: string, stepId: string, error: string): void;
  buildProjectContext(project: Project, step: ProjectStep): Promise<string>;
}

/**
 * Live accessors for the injected dependencies. These are read lazily on each
 * call so services constructed after the executor (writingJudge, tts) are
 * picked up when a step actually runs — matching the original inline behavior
 * where the engine read `this.stepServices` / `this.contextEngine` at call time.
 */
export interface StepExecutorDeps {
  getMessageHandler(): MessageHandler | null;
  getStepServices(): StepServices;
  getContextEngine(): ContextEngine | undefined;
}

export class StepExecutor {
  constructor(
    private readonly engine: EnginePort,
    private readonly deps: StepExecutorDeps,
  ) {}

  /**
   * Smart excerpt builder for large manuscripts.
   * Reads the full document from disk and extracts a relevant excerpt
   * that fits within AI context limits while preserving the most useful content.
   *
   * Strategy: 80% head + 20% tail (with truncation marker). This gives the AI
   * the beginning (setup, style, voice) and ending (current state) which is
   * ideal for revision, editing, and analysis tasks.
   */
  private async getSmartExcerpt(filePath: string, wordCount: number, maxChars = 25000): Promise<string> {
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

  /**
   * Returns true if the step requires the FULL manuscript in context (not a
   * truncated excerpt). Revision-apply rewrites AND consistency checks must see
   * the whole book: a consistency pass can't catch a contradiction between
   * ch 2 and ch 30 if it only ever sees a 30K-char excerpt.
   *
   * (Chunk B1) Extended the allowlist to include consistency steps (by taskType
   * or phase). This only widens the CONTEXT CAP in buildStepUserMessage — it
   * does NOT trigger word-count continuation, which is gated on the narrower
   * stepIsFullRewrite() so a consistency REPORT is never padded to manuscript
   * length.
   */
  stepNeedsFullManuscript(step: any): boolean {
    if (this.stepIsFullRewrite(step)) return true;
    const taskType = String(step?.taskType || '').toLowerCase();
    const phase = String(step?.phase || '').toLowerCase();
    const label = String(step?.label || '').toLowerCase();
    return taskType === 'consistency' ||
      phase === 'consistency' ||
      label.includes('consistency check') ||
      label.includes('continuity scan') ||
      label.includes('continuity check');
  }

  /**
   * Narrower signal: the step actually REWRITES the whole manuscript (macro /
   * scene / line revision-apply). This is the original stepNeedsFullManuscript
   * behavior, preserved verbatim so the word-count continuation loop still only
   * fires for real rewrites — never for analysis/consistency steps.
   */
  stepIsFullRewrite(step: any): boolean {
    const phase = String(step?.phase || '').toLowerCase();
    const label = String(step?.label || '').toLowerCase();
    return phase === 'revision_apply' ||
      label.includes('apply macro revision') ||
      label.includes('apply scene-level revision') ||
      label.includes('apply line-level revision') ||
      label.includes('full manuscript rewrite');
  }

  /**
   * Build the user message for project step execution.
   * Injects uploaded manuscript DIRECTLY into the user message so the AI can't
   * miss it. For large documents (15K+ words): reads from disk and applies
   * smart truncation.
   */
  async buildStepUserMessage(project: any, step: any): Promise<string> {
    let message = step.prompt;
    const uploads = project.context?.uploads || [];
    const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount?.toLocaleString() || '?'} words)`).join(', ');

    // Steps that need the WHOLE book (revision-apply rewrites + consistency
    // checks) get the full-manuscript cap; analysis steps get a smart excerpt.
    // The "you MUST rewrite" header note is gated on the narrower rewrite signal
    // so a consistency step gets the full text WITHOUT being told to rewrite it.
    const fullNeeded = this.stepNeedsFullManuscript(step);
    const isRewrite = this.stepIsFullRewrite(step);
    const charCap = fullNeeded ? 600000 : 30000;  // ~120K words when needed (fits Claude/Gemini context)
    const rewriteNote = `\n\n⚠️ This is a REVISION APPLY step. You MUST rewrite the ENTIRE manuscript below (or as much as fits in your response — the system will ask for continuations).\n\n`;

    // Large document path: read from disk with cap-aware truncation
    if (project.context?.documentLibraryFile) {
      const excerpt = await this.getSmartExcerpt(
        project.context.documentLibraryFile,
        project.context.documentWordCount || 0,
        charCap
      );
      const headerNote = isRewrite ? rewriteNote : '';
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}${headerNote}\n\n${excerpt}\n\n---\n\n## Your Task\n\n${message}`;
      return message;
    }

    // Small document path: use inline uploaded content
    if (project.context?.uploadedContent) {
      const uploaded = String(project.context.uploadedContent).substring(0, charCap);
      const headerNote = isRewrite ? rewriteNote : '';
      message = `## Manuscript to Work With\n\nUploaded files: ${fileList}${headerNote}\n\n${uploaded}\n\n---\n\n## Your Task\n\n${message}`;
    }

    return message;
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
    const messageHandler = this.deps.getMessageHandler();
    if (!messageHandler) throw new Error('ProjectEngine: message handler not wired (call setMessageHandler)');
    const project = this.engine.getProject(projectId);
    if (!project) return { ok: false, kind: 'no-project' };

    const activeStep = project.steps.find((s: any) => s.status === 'active');
    if (!activeStep) return { ok: false, kind: 'no-active-step' };

    try {
      const projectContext = await this.engine.buildProjectContext(project, activeStep);
      const userMessage = await this.buildStepUserMessage(project, activeStep);
      let response = '';

      await messageHandler(
        userMessage,
        'projects',
        (text: string) => { response = text; },
        projectContext,
        activeStep.taskType || undefined  // Use step's own taskType for routing
      );

      // Retry once with 'general' routing if the response is too short
      if (!response || response.length < 50) {
        log.warn(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
        response = '';
        await messageHandler(
          userMessage,
          'projects',
          (text: string) => { response = text; },
          projectContext,
          'general'
        );
      }

      // Detect the [AI provider failure] sentinel from handleMessage when both
      // primary and fallback errored. Treat as failure with the real reason
      // instead of writing the error message into the manuscript file.
      if (response && response.startsWith('[AI provider failure]')) {
        const detail = response.replace(/^\[AI provider failure\]\s*/, '').substring(0, 500);
        this.engine.failStep(project.id, activeStep.id, detail);
        return { ok: false, kind: 'provider-failure', detail, project: this.engine.getProject(project.id)! };
      }
      if (!response || response.length < 50) {
        const reason = `AI returned an unusably short response (${response?.length ?? 0} chars). ` +
          `This usually means the chosen provider hit a safety filter, ran out of context, or the model is misconfigured. ` +
          `Try a different provider in Settings, shorten the project description, or split the task.`;
        this.engine.failStep(project.id, activeStep.id, reason);
        return { ok: false, kind: 'short-response', reason, project: this.engine.getProject(project.id)! };
      }

      const nextStep = this.engine.completeStep(project.id, activeStep.id, response);

      return {
        ok: true,
        completedStep: activeStep.id,
        response,
        nextStep,
        project: this.engine.getProject(project.id)!,
      };
    } catch (error) {
      this.engine.failStep(project.id, activeStep.id, String(error));
      return { ok: false, kind: 'error', error: String(error), project: this.engine.getProject(project.id)! };
    }
  }

  /**
   * Serializes context-engine summary/entity extraction so the chapter-continuity
   * memory hooks NEVER run concurrently — even when steps finish out of order.
   * Chapter WRITE steps complete in chapter order (they depend on the prior
   * chapter), so FIFO serialization here yields chapter-ordered memory updates.
   */
  private hookChain: Promise<void> = Promise.resolve();

  private enqueueSerial(fn: () => Promise<void>): Promise<void> {
    const run = this.hookChain.then(fn, fn);
    // Keep the chain alive regardless of individual hook success/failure.
    this.hookChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Resolve the conductor concurrency: per-project override
   * (context.conductorConcurrency) beats env AUTHORAGENT_CONDUCTOR_CONCURRENCY,
   * beats the default of 2. Clamped to [1, 3] so a stray config can never spawn
   * a retry storm of AI calls.
   */
  private resolveConcurrency(project: Project): number {
    const projC = Number(project.context?.conductorConcurrency);
    const envC = Number(process.env.AUTHORAGENT_CONDUCTOR_CONCURRENCY);
    let c = 2;
    if (Number.isFinite(projC) && projC > 0) c = projC;
    else if (Number.isFinite(envC) && envC > 0) c = envC;
    return Math.max(1, Math.min(3, Math.floor(c)));
  }

  /**
   * Fully autonomous mode. Dispatches to one of two engines:
   *
   *  - CONDUCTOR (true-parallel supervisor): used when the project's steps carry
   *    `dependsOn` metadata (all projects created after the conductor upgrade).
   *    Runs up to N independent steps concurrently while chapters stay strictly
   *    sequential; a failed step blocks only its dependents.
   *
   *  - LEGACY SEQUENTIAL: used for projects persisted BEFORE the upgrade (no
   *    `dependsOn` on any step). Byte-for-byte the prior one-step-at-a-time loop,
   *    so restored projects behave exactly as they did.
   *
   * Both paths share `runStep`, which preserves the full per-step pipeline:
   * short-response retry, provider-failure detection, word-count continuation,
   * quality loop, file save, context-engine/auto-narrate/assembly hooks.
   */
  async autoExecuteLoop(projectId: string, opts: ExecuteStepOptions): Promise<{
    results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }>;
    project: Project | undefined;
  }> {
    const messageHandler = this.deps.getMessageHandler();
    if (!messageHandler) throw new Error('ProjectEngine: message handler not wired (call setMessageHandler)');
    const services = this.deps.getStepServices();

    const results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }> = [];

    const project0 = this.engine.getProject(projectId);
    const hasDeps = !!project0 && project0.steps.some((s: any) => Array.isArray(s.dependsOn));

    if (hasDeps) {
      await this.conductorLoop(projectId, opts, results, messageHandler, services);
    } else {
      await this.legacySequentialLoop(projectId, opts, results, messageHandler, services);
    }

    return { results, project: this.engine.getProject(projectId) };
  }

  /**
   * Legacy strictly-sequential loop — preserves the EXACT prior behavior for
   * projects that predate `dependsOn` (any failure stops the whole run).
   */
  private async legacySequentialLoop(
    projectId: string,
    opts: ExecuteStepOptions,
    results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }>,
    messageHandler: MessageHandler,
    services: StepServices,
  ): Promise<void> {
    while (true) {
      const currentProject = this.engine.getProject(projectId);
      if (!currentProject) break;

      // Check if project was paused externally (via /stop or dashboard)
      if (currentProject.status === 'paused' || currentProject.status === 'completed') break;

      const activeStep = currentProject.steps.find((s: any) => s.status === 'active');
      if (!activeStep) break;

      const outcome = await this.runStep(projectId, activeStep.id, opts, results, messageHandler, services, true);
      // Legacy contract: ANY failure (provider failure, short response, or a
      // thrown error) halts the entire run.
      if (outcome.halt) break;

      // Re-check pause AFTER step completes (catches /stop sent during long AI call)
      const freshProject = this.engine.getProject(projectId);
      if (freshProject?.status === 'paused' || freshProject?.status === 'completed') break;
    }
  }

  /**
   * True-parallel conductor. Ready set = pending steps whose `dependsOn` are all
   * completed/skipped. Dispatches up to CONCURRENCY steps at once, filling slots
   * as they free (Promise.race, not Promise.all). Semantics:
   *   - Pause/stop: stop dispatching immediately when the project is paused/
   *     completed; let in-flight steps finish, then halt.
   *   - Failure: a failed step is left failed → its dependents' deps never
   *     satisfy → only that branch stalls; independent branches keep running.
   *   - Termination: loop ends when nothing is ready AND nothing is in flight.
   * Total concurrent AI calls are bounded by CONCURRENCY (each runStep issues
   * its AI calls sequentially), so no retry storm.
   */
  private async conductorLoop(
    projectId: string,
    opts: ExecuteStepOptions,
    results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }>,
    messageHandler: MessageHandler,
    services: StepServices,
  ): Promise<void> {
    const start = this.engine.getProject(projectId);
    if (!start) return;
    const concurrency = this.resolveConcurrency(start);

    // The route pre-activates the first step for sequential mode. The conductor
    // owns dispatch, so normalize any 'active' steps back to 'pending' and let
    // the ready-set logic re-activate them by dependency order. (Also repairs
    // orphaned active steps from a prior interrupted run.)
    for (const s of start.steps) {
      if (s.status === 'active') s.status = 'pending';
    }

    const depsSatisfied = (project: Project, step: ProjectStep): boolean => {
      const deps = (step as any).dependsOn as string[] | undefined;
      if (!deps || deps.length === 0) return true;
      return deps.every(depId => {
        const d = project.steps.find(x => x.id === depId);
        return !!d && (d.status === 'completed' || d.status === 'skipped');
      });
    };

    const inFlight = new Map<string, Promise<void>>();

    while (true) {
      const project = this.engine.getProject(projectId);
      if (!project) break;

      const paused = project.status === 'paused' || project.status === 'completed';

      // Dispatch as many ready steps as free slots allow (unless paused).
      if (!paused) {
        while (inFlight.size < concurrency) {
          const next = project.steps.find(s =>
            s.status === 'pending' && !inFlight.has(s.id) && depsSatisfied(project, s));
          if (!next) break;

          // Activate + enrich the prompt, then run. Capture the id — `next` is a
          // live reference but the status flips to 'active' immediately.
          this.engine.activateStep(projectId, next.id);
          const stepId = next.id;
          const p = this.runStep(projectId, stepId, opts, results, messageHandler, services, false)
            .then(() => {}, (err) => {
              // runStep already fails the step on error; guard the chain anyway.
              log.error('[conductor] runStep rejected:', err);
            })
            .finally(() => { inFlight.delete(stepId); });
          inFlight.set(stepId, p);
        }
      }

      if (inFlight.size === 0) {
        // Nothing running. If paused, or no ready steps remain (completion or
        // fully blocked by failures), we're done.
        break;
      }

      // Wait for at least one in-flight step to finish, then re-evaluate.
      await Promise.race(inFlight.values());
    }

    // Drain any stragglers (e.g. dispatched right before a pause was observed).
    if (inFlight.size > 0) await Promise.all(inFlight.values());
  }

  /**
   * Execute a single already-active step through the full pipeline. Shared by
   * the legacy sequential loop (advance=true → completeStep auto-advances the
   * next step) and the conductor (advance=false → completeStepBare; the
   * supervisor owns dispatch).
   *
   * Returns `{ success, halt }`. `halt` marks a failure that the legacy loop
   * treats as a hard stop (provider failure / short response / thrown error).
   * The conductor ignores `halt` — a failed step simply blocks its dependents.
   * Pushes exactly one entry onto `results`, matching the prior behavior.
   */
  private async runStep(
    projectId: string,
    stepId: string,
    opts: ExecuteStepOptions,
    results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }>,
    messageHandler: MessageHandler,
    services: StepServices,
    advance: boolean,
  ): Promise<{ success: boolean; halt: boolean }> {
    const { join } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');
    const workspaceDir = opts.workspaceDir;

    const currentProject = this.engine.getProject(projectId);
    if (!currentProject) return { success: false, halt: true };
    const activeStep = currentProject.steps.find((s: any) => s.id === stepId);
    if (!activeStep) return { success: false, halt: true };

    const complete = (result: string) => {
      if (advance) this.engine.completeStep(currentProject.id, activeStep.id, result);
      else this.engine.completeStepBare(currentProject.id, activeStep.id, result);
    };

    try {
      const projectContext = await this.engine.buildProjectContext(currentProject, activeStep);
      const userMessage = await this.buildStepUserMessage(currentProject, activeStep);
      let response = '';

      await messageHandler(
        userMessage,
        'project-engine',
        (text: string) => { response = text; },
        projectContext,
        activeStep.taskType || undefined  // Use step's own taskType for routing
      );

      // Retry once with 'general' routing if the response is too short
      // This catches cases where a premium/mid provider fails but free providers work fine
      if (!response || response.length < 50) {
        log.warn(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
        response = '';
        await messageHandler(
          userMessage,
          'project-engine',
          (text: string) => { response = text; },
          projectContext,
          'general'  // Force free-tier routing (Gemini first)
        );
      }

      if (response && response.startsWith('[AI provider failure]')) {
        const detail = response.replace(/^\[AI provider failure\]\s*/, '').substring(0, 500);
        this.engine.failStep(currentProject.id, activeStep.id, detail);
        results.push({ step: activeStep.label, success: false, error: detail });
        return { success: false, halt: true };
      }
      if (!response || response.length < 50) {
        const reason = `AI returned an unusably short response (${response?.length ?? 0} chars). ` +
          `Cause is usually a safety filter trip, context overflow, or misconfigured provider. ` +
          `Switch providers in Settings or shorten the project description.`;
        this.engine.failStep(currentProject.id, activeStep.id, reason);
        results.push({ step: activeStep.label, success: false, error: reason });
        return { success: false, halt: true };
      }

      // ── Continuation logic for long-output steps (revision-apply + novel writing) ──
      // Revision-apply steps must produce a FULL manuscript. If the response is shorter
      // than the source (or shorter than the explicit wordCountTarget), ask the AI to
      // continue. This prevents the user from getting a half-revised book.
      {
        // Continuation must only fire for actual full-manuscript REWRITES —
        // not consistency checks (which stepNeedsFullManuscript now also
        // covers). Use the narrower rewrite signal here so a consistency
        // REPORT is never padded out to manuscript length.
        const isRevisionApply = this.stepIsFullRewrite(activeStep);
        const wcTarget = (activeStep as any).wordCountTarget ||
          (isRevisionApply ? Math.floor((currentProject.context?.documentWordCount || 0) * 0.9) : 0);
        if (wcTarget && wcTarget > 0) {
          let wc = response.split(/\s+/).length;
          let continuations = 0;
          while (wc < wcTarget && continuations < 6) {
            continuations++;
            const remaining = wcTarget - wc;
            log.debug(`  [${isRevisionApply ? 'revision-apply' : 'writing'}] Response word count: ${wc}/${wcTarget} — requesting continuation #${continuations} (~${remaining} more words)`);
            let contResponse = '';
            try {
              const contPrompt = isRevisionApply
                ? `Continue the revised manuscript from EXACTLY where you left off. You've produced ${wc} words so far; the target is ${wcTarget}. Output at least ${Math.min(remaining, 15000)} more words of the revised manuscript, continuing from the last chapter boundary. Do NOT repeat content. Do NOT summarize. Do NOT add commentary. Output ONLY the continued manuscript prose.`
                : `Continue writing from where you left off. You wrote ${wc} words so far but the target is ${wcTarget}. Write at least ${remaining} more words of prose narrative, continuing the story seamlessly. Do NOT repeat what was already written. Do NOT summarize.`;
              await messageHandler(
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
            log.debug(`  [${isRevisionApply ? 'revision-apply' : 'writing'}] Final word count after ${continuations} continuation(s): ${response.split(/\s+/).length}`);
          }
        }
      }

      // ── Quality loop: evaluate + retry on write/polish steps ──
      // AutoNovel-inspired modify-evaluate-retry. Defaults to 1 retry
      // (so each chapter costs at most 3 AI calls: draft + judge + retry).
      // Authors can disable per-project via context.qualityLoopEnabled=false.
      try {
        const judge = services.writingJudge;
        const stepSkill = (activeStep as any).skill || '';
        const stepPhase = (activeStep as any).phase || '';
        const isQualityCandidate = stepSkill === 'write' || stepPhase === 'polish';
        const qualityLoopEnabled = currentProject.context?.qualityLoopEnabled !== false;
        const qualityThreshold = Number(currentProject.context?.qualityThreshold) || 70;
        const maxRetries = Number(currentProject.context?.qualityMaxRetries) ?? 1;
        // Per-project flag for the dual Craft + Market judge mode.
        // Doubles the judge AI cost (one extra call per attempt) but
        // surfaces craft↔market disagreement, which is the most
        // actionable signal. Off by default — opt-in per project.
        const dualJudgeEnabled = currentProject.context?.dualJudge === true;

        if (judge && isQualityCandidate && qualityLoopEnabled && response.length > 500) {
          let attempt = 0;
          let bestResponse = response;
          let bestScore = -1;
          while (attempt <= maxRetries) {
            const verdict = await judge.evaluate(response, {
              aiComplete: (r: any) => services.aiRouter.complete(r),
              aiSelectProvider: (taskType: string) => services.aiRouter.selectProvider(taskType),
              threshold: qualityThreshold,
              dualJudge: dualJudgeEnabled,
            });
            log.debug(`  [judge] "${activeStep.label}" attempt ${attempt + 1}: ${verdict.summary}`);
            if (verdict.score > bestScore) {
              bestScore = verdict.score;
              bestResponse = response;
            }
            if (!verdict.retry || attempt >= maxRetries) break;

            // Retry with feedback as additional steering.
            attempt++;
            log.debug(`  [judge] Retrying with feedback (attempt ${attempt + 1}/${maxRetries + 1})...`);
            const userMsgWithFeedback = userMessage +
              '\n\n## Quality feedback on your previous draft\n\n' + verdict.retryFeedback +
              '\n\nProduce a NEW draft that fixes these specific issues. Output ONLY the chapter prose — no commentary.';
            let retryResponse = '';
            try {
              await messageHandler(
                userMsgWithFeedback,
                'project-engine',
                (text: string) => { retryResponse = text; },
                projectContext,
                activeStep.taskType || undefined,
              );
              if (retryResponse && retryResponse.length > 500 &&
                  !retryResponse.startsWith('[AI provider failure]')) {
                response = retryResponse;
              } else {
                // Retry failed — keep previous best and stop looping.
                break;
              }
            } catch {
              break;
            }
          }
          // Always keep the highest-scoring version we saw.
          response = bestResponse;
          services.activityLog?.log({
            type: 'step_completed',
            source: 'internal',
            goalId: currentProject.id,
            stepLabel: activeStep.label,
            message: `Quality score: ${bestScore.toFixed(1)}/100 after ${attempt + 1} attempt(s)`,
            metadata: { qualityScore: bestScore, attempts: attempt + 1 },
          });
        }
      } catch (judgeErr) {
        // Judge failures should NEVER block step completion — degrade gracefully.
        log.warn('  [judge] evaluation hook failed:', (judgeErr as Error)?.message || judgeErr);
      }

      const wordCount = response.split(/\s+/).length;

      // Save to file + append immutable version
      try {
        const projectDir = projectOutputDir(workspaceDir, currentProject);
        await mkdir(projectDir, { recursive: true });
        const stepFileName = stepOutputFileName(activeStep);
        const canonicalPath = join(projectDir, stepFileName);
        const stepContent = `# ${activeStep.label}\n\n${response}`;

        // Append to immutable version storage
        await docVersionService.appendVersion(projectDir, activeStep.id, stepContent);

        // Write canonical/current pointer
        await writeFile(canonicalPath, stepContent, 'utf-8');
      } catch (err) {
        logger.debug('step output file save / versioning failed', err);
      }

      complete(response);
      // Track words for Morning Briefing
      services.heartbeat?.addWords(wordCount);
      results.push({ step: activeStep.label, success: true, wordCount });

      // ── ContextEngine: summarize + extract entities for canonical chapter prose ──
      // Bug fix (2026-04): the previous heuristic matched any step whose label
      // contained "chapter" or "write" — which included "Self-review Chapter N"
      // and other analysis steps. That doubled AI cost AND polluted the entity
      // index with character/location names mentioned in critique form ("Sarah's
      // motivation feels weak" → indexed as a Sarah attribute change). Now uses
      // the precise skill+phase signal: only `skill === 'write'` (first-draft
      // chapter prose) OR `phase === 'polish'` (revised chapter prose) qualify.
      // The polish step replaces the prior summary because its chapterNumber
      // matches the write step and the summary upserts on (projectId, chapterId)
      // — so the polished version becomes canonical without dropping memory.
      //
      // CONDUCTOR: serialized via enqueueSerial so concurrent step completions
      // never interleave context-engine writes. Chapter WRITE steps finish in
      // chapter order (dependency chain), so the memory index stays ordered.
      await this.enqueueSerial(async () => {
        try {
          const contextEngine = this.deps.getContextEngine();
          const stepLabel = (activeStep as any).label || '';
          const stepSkill = (activeStep as any).skill || '';
          const stepPhase = (activeStep as any).phase || '';
          const isCanonicalChapter = stepSkill === 'write' || stepPhase === 'polish';
          const isBibleStep = currentProject.type === 'book-bible' ||
            stepLabel.toLowerCase().includes('bible') ||
            stepLabel.toLowerCase().includes('world') ||
            (stepLabel.toLowerCase().includes('character') && stepSkill !== 'revise');

          if (contextEngine && response.length > 200 && (isCanonicalChapter || isBibleStep)) {
            const chapterNum = currentProject.steps.filter((s: any) =>
              s.status === 'completed' && s.id !== activeStep.id
            ).length + 1;

            const aiCompleteFn = (req: any) => services.aiRouter.complete(req);
            const aiSelectFn = (taskType: string) => services.aiRouter.selectProvider(taskType);

            // Await context engine calls so they complete before the next hook.
            await Promise.allSettled([
              contextEngine.generateSummary(
                currentProject.id, activeStep.id, stepLabel, chapterNum, response,
                aiCompleteFn, aiSelectFn
              ).catch((err: any) => log.error('[context-engine] Summary error:', err.message)),
              contextEngine.extractEntities(
                currentProject.id, activeStep.id, response,
                aiCompleteFn, aiSelectFn
              ).catch((err: any) => log.error('[context-engine] Entity extraction error:', err.message)),
            ]);
          }
        } catch (contextErr) {
          log.error('[context-engine] Hook error:', contextErr);
        }
      });

      // SEAM (ALP-1595 follow-on): book-bible.md is currently compiled
      // on-demand only (POST /api/projects/:id/book-bible). Auto-regenerate
      // was left out of v1 scope — when it's built, the natural place to
      // trigger it is right here, gated on `isBibleStep` above, since that's
      // already the signal that this step's output feeds the bible.

      // ── Auto-narrate completed chapter (opt-in via project.context.autoNarrate) ──
      // Inspired by OpenClaw's chat-scoped /tts auto controls. Generates an audio
      // preview of the just-completed chapter so the author can listen back without
      // manually triggering the TTS endpoint. Fire-and-forget — never blocks step flow.
      try {
        const autoNarrate = !!currentProject.context?.autoNarrate;
        // Match the same canonical-chapter signal as the ContextEngine hook so
        // we don't auto-narrate review/polish notes — only first-draft prose
        // and polished revisions get audio.
        const stepSkill = (activeStep as any).skill || '';
        const stepPhase = (activeStep as any).phase || '';
        const isWritingStep = stepSkill === 'write' || stepPhase === 'polish';
        if (autoNarrate && isWritingStep && services.tts && response.length > 200) {
          // Resolve the persona's voice if the project has one — keeps each pen
          // name's narration consistent across chapters.
          let voice: string | undefined;
          const personaId = (currentProject as any).personaId;
          if (personaId && services.personas) {
            const persona = services.personas.get?.(personaId);
            if (persona?.ttsVoice) voice = persona.ttsVoice;
          }
          // ElevenLabs costs credits per call. Cap auto-narrate text to a safe length
          // and warn in the audit log when ElevenLabs is the active provider.
          const activeProvider = services.tts.getActiveProvider();
          const cap = activeProvider === 'elevenlabs' ? 3000 : 30000;
          const narrationText = response.replace(/^#[^\n]+\n+/, '').substring(0, cap);
          services.tts.generate(narrationText, { voice })
            .then((result: any) => {
              if (result.success) {
                services.activityLog?.log({
                  type: 'file_saved',
                  source: 'internal',
                  goalId: currentProject.id,
                  message: `🔊 Auto-narrated "${activeStep.label}" (${result.provider}, ~${result.duration}s) → ${result.filename}`,
                  metadata: { audioFile: result.filename, voice, provider: result.provider },
                });
              } else {
                log.error('[auto-narrate] failed:', result.error);
              }
            })
            .catch((err: any) => log.error('[auto-narrate] error:', err));
        }
      } catch (narrationErr) {
        log.error('[auto-narrate] hook error:', narrationErr);
      }

      // ── Manuscript Assembly: combine chapter files after assembly step ──
      if ((activeStep as any).phase === 'assembly' && currentProject.type === 'novel-pipeline') {
        try {
          const { existsSync: exLocal } = await import('fs');
          const { readFile: readF } = await import('fs/promises');
          const projectDir = projectOutputDir(workspaceDir, currentProject);

          const writingSteps = currentProject.steps
            .filter((s: any) => s.phase === 'writing' && s.status === 'completed')
            .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

          const chapterContents: string[] = [];
          for (const ws of writingSteps) {
            const fileName = stepOutputFileName(ws);
            const newPath = join(projectDir, fileName);
            const fullPath = exLocal(newPath) ? newPath : join(legacyProjectOutputDir(workspaceDir, currentProject), fileName);
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
              author: 'AuthorAgent',
              content: manuscriptMd,
            });
            await writeFile(join(projectDir, 'manuscript.docx'), docxBuffer);
            log.info(`  [assembly] Manuscript assembled: ${chapterContents.length} chapters`);
          }
        } catch (err) {
          logger.debug('manuscript assembly save failed', err);
        }
      }

      return { success: true, halt: false };
    } catch (error) {
      this.engine.failStep(currentProject.id, activeStep.id, String(error));
      results.push({ step: activeStep.label, success: false, error: String(error) });
      return { success: false, halt: true };
    }
  }
}

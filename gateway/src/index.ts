/**
 * AuthorAgent Gateway - Main Entry Point
 * A secure, author-focused fork of OpenClaw
 *
 * Security: MoatBot-grade (encrypted vault, sandboxed, audited)
 * Purpose: Fiction & nonfiction writing assistant
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { join } from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { resolveInstallRootDir, loadInstallDotenv } from './services/install-root.js';
import { resolveWorkspaceRoot, resolveActiveWorkspace } from './services/workspace-routing.js';
import { projectOutputDir, stepOutputFileName, legacyProjectOutputDir } from './services/project-paths.js';

import { ConfigService } from './services/config.js';
import { MemoryService } from './services/memory.js';
import { SoulService } from './services/soul.js';
import { HeartbeatService } from './services/heartbeat.js';
import { CostTracker } from './services/costs.js';
import { ResearchGate } from './services/research.js';
import { ActivityLog } from './services/activity-log.js';
import { AIRouter } from './ai/router.js';
import { Vault } from './security/vault.js';
import { PermissionManager } from './security/permissions.js';
import { AuditLog } from './security/audit.js';
import { SandboxGuard } from './security/sandbox.js';
import { InjectionDetector } from './security/injection.js';
import { resolveWithin } from './security/paths.js';
import { SkillLoader } from './skills/loader.js';
import { AuthorOSService } from './services/author-os.js';
import { TTSService } from './services/tts.js';
import { ImageGenService } from './services/image-gen.js';
import { ProjectEngine } from './services/projects.js';
import { PersonaService } from './services/personas.js';
import { ContextEngine } from './services/context-engine.js';
import { MemorySearchService } from './services/memory-search.js';
import { MemoryTierService } from './services/memory-tier.js';
import { SleepConsolidationService } from './services/sleep-consolidation.js';
import { ReaderFeedbackService } from './services/reader-feedback.js';
import { UserModelService } from './services/user-model.js';
import { CronSchedulerService } from './services/cron-scheduler.js';
import { AutoSkillService } from './services/auto-skill.js';
import { SkillCuratorService } from './services/skill-curator.js';
import { WritingJudgeService } from './services/writing-judge.js';
import { ProseEvolverService } from './services/prose-evolver.js';
import { ReaderPanelService } from './services/reader-panel.js';
import { ResearchLookupService } from './services/research-lookup.js';
import { VideoResearchService } from './services/video-research.js';
import { StoryStructureService } from './services/story-structures.js';
import { PlotPromisesService } from './services/plot-promises.js';
import { CharacterVoicesService } from './services/character-voices.js';
import { WebsiteSiteService } from './services/website-sites.js';
import { BlogPostDrafterService } from './services/blog-post-drafter.js';
import { WebsiteDeployService } from './services/website-deploy.js';
import { LessonStore } from './services/lessons.js';
import { PreferenceStore } from './services/preferences.js';
import { OrchestratorService } from './services/orchestrator.js';
import { KDPExporter } from './services/kdp-exporter.js';
import { BetaReaderService } from './services/beta-reader.js';
import { DialogueAuditor } from './services/dialogue-auditor.js';
import { ManuscriptHubService } from './services/manuscript-hub.js';
import { CoverTypographyService } from './services/cover-typography.js';
import { ExternalToolsService } from './services/external-tools.js';
import { TrackChangesService } from './services/track-changes.js';
import { GoalsService } from './services/goals.js';
import { SeriesBibleService } from './services/series-bible.js';
import { CraftCriticService } from './services/craft-critic.js';
import { AudiobookPrepService } from './services/audiobook-prep.js';
import { StyleCloneService } from './services/style-clone.js';
import { ContradictionDetector } from './services/contradiction-detector.js';
import { CharacterAgentService } from './services/character-agent.js';
import { RevisionOrchestrator } from './services/revision-orchestrator.js';
import { LearningService } from './services/learning.js';
import { ConfirmationGateService } from './services/confirmation-gate.js';
import { DisclosuresService } from './services/disclosures.js';
import { LaunchOrchestratorService } from './services/launch-orchestrator.js';
import { AMSAdsService } from './services/ams-ads.js';
import { BookBubSubmitterService } from './services/bookbub-submitter.js';
import { ReleaseCalendarService } from './services/release-calendar.js';
import { ReaderIntelService } from './services/reader-intel.js';
import { TranslationPipelineService } from './services/translation-pipeline.js';
import { WebsiteBuilderService } from './services/website-builder.js';
import { TelegramBridge } from './bridges/telegram.js';
import { DiscordBridge } from './bridges/discord.js';
import { createAPIRoutes } from './api/routes.js';
import { logger } from './services/logger.js';
import { ServiceContainer } from './services/container.js';
import { MessagePipeline } from './services/message-pipeline.js';

const ROOT_DIR = resolveInstallRootDir(import.meta.url, 2);

// Load .env FIRST — before anything else reads process.env. See
// install-root.ts for why this must be resolved relative to ROOT_DIR (this
// file's own location) rather than process.cwd() — a real incident where
// AUTHORCLAW_WORKSPACE_DIR silently reverted to its default for hours.
loadInstallDotenv(ROOT_DIR);

// Where all live project data (book bible, chapters, memory, audit logs,
// etc.) is stored. AUTHORCLAW_WORKSPACE_DIR (or the AUTHORCLAW_PROJECTS_ROOT
// alias) is now a ROOT that can hold MANY per-book workspaces at
// `<root>/<book-slug>/`, selected via AUTHORCLAW_ACTIVE_BOOK or a
// `<root>/.active-book` pointer file — see workspace-routing.ts. An existing
// flat single-book install (memory/, soul/, projects/ directly under the
// root, no active book selected) is detected as legacy and the root itself
// is used unchanged, so no migration is required to keep it running.
const WORKSPACE_ROOT = resolveWorkspaceRoot(process.env, join(ROOT_DIR, 'workspace'));
const resolvedWorkspace = resolveActiveWorkspace(WORKSPACE_ROOT, process.env);
const WORKSPACE_DIR = resolvedWorkspace.workspaceDir;
if (resolvedWorkspace.mode === 'active-book') {
  console.log(`[startup] Active book: ${resolvedWorkspace.activeBook} (${WORKSPACE_DIR})`);
} else if (resolvedWorkspace.mode === 'default-book') {
  console.log(`[startup] No active book selected — defaulting to '${resolvedWorkspace.activeBook}' (${WORKSPACE_DIR}). Run \`npm run book -- create <slug>\` and \`npm run book -- use <slug>\` to add more books.`);
}

// ═══════════════════════════════════════════════════════════
// AuthorAgent Gateway
// ═══════════════════════════════════════════════════════════

class AuthorAgentGateway {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private io: SocketIO;

  // All long-lived services live in a typed ServiceContainer. The gateway
  // constructs + wires them (in initialize(), unchanged order) by assigning
  // into this container; every existing `this.<service>` call site keeps
  // working via the getter/setter accessors defined below, and
  // getServices()/getProjectEngine() delegate to the container.
  private services = new ServiceContainer();

  // Bridges are gateway-lifecycle-owned (connect/disconnect) and are NOT part
  // of the service container / getServices() projection.
  private telegram?: TelegramBridge;
  private discord?: DiscordBridge;

  // ── Service accessors ──
  // These delegate to the ServiceContainer so the ~2,600 lines of gateway code
  // below can keep using `this.config`, `this.aiRouter`, etc. unchanged while
  // the container is the single source of truth.
  private get config(): ConfigService { return this.services.config; }
  private set config(v: ConfigService) { this.services.config = v; }
  private get memory(): MemoryService { return this.services.memory; }
  private set memory(v: MemoryService) { this.services.memory = v; }
  private get soul(): SoulService { return this.services.soul; }
  private set soul(v: SoulService) { this.services.soul = v; }
  private get heartbeat(): HeartbeatService { return this.services.heartbeat; }
  private set heartbeat(v: HeartbeatService) { this.services.heartbeat = v; }
  private get costs(): CostTracker { return this.services.costs; }
  private set costs(v: CostTracker) { this.services.costs = v; }
  private get research(): ResearchGate { return this.services.research; }
  private set research(v: ResearchGate) { this.services.research = v; }
  private get activityLog(): ActivityLog { return this.services.activityLog; }
  private set activityLog(v: ActivityLog) { this.services.activityLog = v; }
  private get aiRouter(): AIRouter { return this.services.aiRouter; }
  private set aiRouter(v: AIRouter) { this.services.aiRouter = v; }

  private get vault(): Vault { return this.services.vault; }
  private set vault(v: Vault) { this.services.vault = v; }
  private get permissions(): PermissionManager { return this.services.permissions; }
  private set permissions(v: PermissionManager) { this.services.permissions = v; }
  private get audit(): AuditLog { return this.services.audit; }
  private set audit(v: AuditLog) { this.services.audit = v; }
  private get sandbox(): SandboxGuard { return this.services.sandbox; }
  private set sandbox(v: SandboxGuard) { this.services.sandbox = v; }
  private get injectionDetector(): InjectionDetector { return this.services.injectionDetector; }
  private set injectionDetector(v: InjectionDetector) { this.services.injectionDetector = v; }

  private get skills(): SkillLoader { return this.services.skills; }
  private set skills(v: SkillLoader) { this.services.skills = v; }
  private get authorOS(): AuthorOSService { return this.services.authorOS; }
  private set authorOS(v: AuthorOSService) { this.services.authorOS = v; }
  private get tts(): TTSService { return this.services.tts; }
  private set tts(v: TTSService) { this.services.tts = v; }
  private get imageGen(): ImageGenService { return this.services.imageGen; }
  private set imageGen(v: ImageGenService) { this.services.imageGen = v; }
  private get personas(): PersonaService { return this.services.personas; }
  private set personas(v: PersonaService) { this.services.personas = v; }
  private get projectEngine(): ProjectEngine { return this.services.projectEngine; }
  private set projectEngine(v: ProjectEngine) { this.services.projectEngine = v; }
  private get contextEngine(): ContextEngine { return this.services.contextEngine; }
  private set contextEngine(v: ContextEngine) { this.services.contextEngine = v; }
  private get memorySearch(): MemorySearchService { return this.services.memorySearch; }
  private set memorySearch(v: MemorySearchService) { this.services.memorySearch = v; }
  private get memoryTier(): MemoryTierService { return this.services.memoryTier; }
  private set memoryTier(v: MemoryTierService) { this.services.memoryTier = v; }
  private get sleepConsolidation(): SleepConsolidationService { return this.services.sleepConsolidation; }
  private set sleepConsolidation(v: SleepConsolidationService) { this.services.sleepConsolidation = v; }
  private get userModel(): UserModelService { return this.services.userModel; }
  private set userModel(v: UserModelService) { this.services.userModel = v; }
  private get cronScheduler(): CronSchedulerService { return this.services.cronScheduler; }
  private set cronScheduler(v: CronSchedulerService) { this.services.cronScheduler = v; }
  private get autoSkill(): AutoSkillService { return this.services.autoSkill; }
  private set autoSkill(v: AutoSkillService) { this.services.autoSkill = v; }
  private get skillCurator(): SkillCuratorService { return this.services.skillCurator; }
  private set skillCurator(v: SkillCuratorService) { this.services.skillCurator = v; }
  private get readerFeedback(): ReaderFeedbackService { return this.services.readerFeedback; }
  private set readerFeedback(v: ReaderFeedbackService) { this.services.readerFeedback = v; }
  private get writingJudge(): WritingJudgeService { return this.services.writingJudge; }
  private set writingJudge(v: WritingJudgeService) { this.services.writingJudge = v; }
  private get proseEvolver(): ProseEvolverService { return this.services.proseEvolver; }
  private set proseEvolver(v: ProseEvolverService) { this.services.proseEvolver = v; }
  private get readerPanel(): ReaderPanelService { return this.services.readerPanel; }
  private set readerPanel(v: ReaderPanelService) { this.services.readerPanel = v; }
  private get researchLookup(): ResearchLookupService { return this.services.researchLookup; }
  private set researchLookup(v: ResearchLookupService) { this.services.researchLookup = v; }
  private get videoResearch(): VideoResearchService { return this.services.videoResearch; }
  private set videoResearch(v: VideoResearchService) { this.services.videoResearch = v; }
  private get storyStructures(): StoryStructureService { return this.services.storyStructures; }
  private set storyStructures(v: StoryStructureService) { this.services.storyStructures = v; }
  private get plotPromises(): PlotPromisesService { return this.services.plotPromises; }
  private set plotPromises(v: PlotPromisesService) { this.services.plotPromises = v; }
  private get characterVoices(): CharacterVoicesService { return this.services.characterVoices; }
  private set characterVoices(v: CharacterVoicesService) { this.services.characterVoices = v; }
  private get websiteSites(): WebsiteSiteService { return this.services.websiteSites; }
  private set websiteSites(v: WebsiteSiteService) { this.services.websiteSites = v; }
  private get blogPostDrafter(): BlogPostDrafterService { return this.services.blogPostDrafter; }
  private set blogPostDrafter(v: BlogPostDrafterService) { this.services.blogPostDrafter = v; }
  private get websiteDeploy(): WebsiteDeployService { return this.services.websiteDeploy; }
  private set websiteDeploy(v: WebsiteDeployService) { this.services.websiteDeploy = v; }
  private get lessons(): LessonStore { return this.services.lessons; }
  private set lessons(v: LessonStore) { this.services.lessons = v; }
  private get preferences(): PreferenceStore { return this.services.preferences; }
  private set preferences(v: PreferenceStore) { this.services.preferences = v; }
  private get orchestrator(): OrchestratorService { return this.services.orchestrator; }
  private set orchestrator(v: OrchestratorService) { this.services.orchestrator = v; }
  private get kdpExporter(): KDPExporter { return this.services.kdpExporter; }
  private set kdpExporter(v: KDPExporter) { this.services.kdpExporter = v; }
  private get betaReader(): BetaReaderService { return this.services.betaReader; }
  private set betaReader(v: BetaReaderService) { this.services.betaReader = v; }
  private get dialogueAuditor(): DialogueAuditor { return this.services.dialogueAuditor; }
  private set dialogueAuditor(v: DialogueAuditor) { this.services.dialogueAuditor = v; }
  private get manuscriptHub(): ManuscriptHubService { return this.services.manuscriptHub; }
  private set manuscriptHub(v: ManuscriptHubService) { this.services.manuscriptHub = v; }
  private get coverTypography(): CoverTypographyService { return this.services.coverTypography; }
  private set coverTypography(v: CoverTypographyService) { this.services.coverTypography = v; }
  private get externalTools(): ExternalToolsService { return this.services.externalTools; }
  private set externalTools(v: ExternalToolsService) { this.services.externalTools = v; }
  private get trackChanges(): TrackChangesService { return this.services.trackChanges; }
  private set trackChanges(v: TrackChangesService) { this.services.trackChanges = v; }
  private get goalsService(): GoalsService { return this.services.goalsService; }
  private set goalsService(v: GoalsService) { this.services.goalsService = v; }
  private get seriesBible(): SeriesBibleService { return this.services.seriesBible; }
  private set seriesBible(v: SeriesBibleService) { this.services.seriesBible = v; }
  private get craftCritic(): CraftCriticService { return this.services.craftCritic; }
  private set craftCritic(v: CraftCriticService) { this.services.craftCritic = v; }
  private get audiobookPrep(): AudiobookPrepService { return this.services.audiobookPrep; }
  private set audiobookPrep(v: AudiobookPrepService) { this.services.audiobookPrep = v; }
  private get styleClone(): StyleCloneService { return this.services.styleClone; }
  private set styleClone(v: StyleCloneService) { this.services.styleClone = v; }
  private get contradictionDetector(): ContradictionDetector { return this.services.contradictionDetector; }
  private set contradictionDetector(v: ContradictionDetector) { this.services.contradictionDetector = v; }
  private get characterAgent(): CharacterAgentService { return this.services.characterAgent; }
  private set characterAgent(v: CharacterAgentService) { this.services.characterAgent = v; }
  private get revisionOrchestrator(): RevisionOrchestrator { return this.services.revisionOrchestrator; }
  private set revisionOrchestrator(v: RevisionOrchestrator) { this.services.revisionOrchestrator = v; }
  private get learning(): LearningService { return this.services.learning; }
  private set learning(v: LearningService) { this.services.learning = v; }
  private get confirmationGate(): ConfirmationGateService { return this.services.confirmationGate; }
  private set confirmationGate(v: ConfirmationGateService) { this.services.confirmationGate = v; }
  private get disclosures(): DisclosuresService { return this.services.disclosures; }
  private set disclosures(v: DisclosuresService) { this.services.disclosures = v; }
  private get launchOrchestrator(): LaunchOrchestratorService { return this.services.launchOrchestrator; }
  private set launchOrchestrator(v: LaunchOrchestratorService) { this.services.launchOrchestrator = v; }
  private get amsAds(): AMSAdsService { return this.services.amsAds; }
  private set amsAds(v: AMSAdsService) { this.services.amsAds = v; }
  private get bookbub(): BookBubSubmitterService { return this.services.bookbub; }
  private set bookbub(v: BookBubSubmitterService) { this.services.bookbub = v; }
  private get releaseCalendar(): ReleaseCalendarService { return this.services.releaseCalendar; }
  private set releaseCalendar(v: ReleaseCalendarService) { this.services.releaseCalendar = v; }
  private get readerIntel(): ReaderIntelService { return this.services.readerIntel; }
  private set readerIntel(v: ReaderIntelService) { this.services.readerIntel = v; }
  private get translationPipeline(): TranslationPipelineService { return this.services.translationPipeline; }
  private set translationPipeline(v: TranslationPipelineService) { this.services.translationPipeline = v; }
  private get websiteBuilder(): WebsiteBuilderService { return this.services.websiteBuilder; }
  private set websiteBuilder(v: WebsiteBuilderService) { this.services.websiteBuilder = v; }

  // The core chat pipeline. Owns per-channel conversation history and the
  // injection/rate-limit/context/routing/persistence/fallback flow. Built once
  // in initialize() after all services are wired; handleMessage() delegates to
  // it. Reads services live through the ServiceContainer.
  private pipeline!: MessagePipeline;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIO(this.server, {
      cors: {
        origin: (origin, callback) => {
          if (!origin || this.getAllowedOrigins().includes(origin)) return callback(null, true);
          callback(new Error('Not allowed by CORS'));
        },
      },
    });
    // Diagnostic: Engine.IO's own handshake-failure event, fires BEFORE
    // io.on('connection') for anything rejected during the handshake
    // (bad origin, transport error, etc.) — otherwise these fail silently.
    this.io.engine.on('connection_error', (err: any) => {
      logger.warn(
        `[websocket] handshake failed: code=${err.code} message="${err.message}" ` +
        `origin=${err.req?.headers?.origin || 'none'} url=${err.req?.url || 'unknown'}`
      );
    });

    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", "http://localhost:3847", "http://127.0.0.1:3847"],
          // Helmet's default CSP directive set auto-injects
          // upgrade-insecure-requests, which makes the browser silently
          // rewrite every http:// fetch this page makes to https://. Browsers
          // exempt localhost/127.0.0.1 from that rewrite (they're
          // "potentially trustworthy" origins) but NOT other addresses like a
          // Tailscale IP — so with this directive active, every API call from
          // a non-localhost origin gets rewritten to https:// and fails with
          // ERR_SSL_PROTOCOL_ERROR against this plain-HTTP server. Explicitly
          // nulling it out here removes it from the generated header.
          upgradeInsecureRequests: null,
        },
      },
    }));
    this.app.use(cors({ origin: ['http://localhost:3847', 'http://127.0.0.1:3847'] }));
    this.app.use(express.json({ limit: '5mb' }));
  }

  async initialize(): Promise<void> {
    logger.info('');
    logger.info('  ✍️  AuthorAgent v3.0.0');
    logger.info('  ═══════════════════════════════════');
    logger.info('  The Autonomous AI Writing Agent');
    logger.info('  An OpenClaw fork for authors');
    logger.info('');

    // Build the core chat pipeline up front. It reads services LIVELY through
    // the ServiceContainer (never at construction time), so wiring below that
    // captures `this.handleMessage` — the ProjectEngine message handler, the
    // heartbeat autonomous callbacks, and the Telegram bridge — all resolve to
    // a live pipeline by the time a message is actually handled.
    this.pipeline = new MessagePipeline(this.services);

    // ── Phase 1: Configuration ──
    this.config = new ConfigService(join(ROOT_DIR, 'config'));
    await this.config.load();
    logger.info('  ✓ Configuration loaded');

    // ── Phase 2: Security Layer ──
    this.vault = new Vault(join(ROOT_DIR, 'config', '.vault'));
    await this.vault.initialize();
    logger.info('  ✓ Encrypted vault initialized (AES-256-GCM)');

    this.permissions = new PermissionManager(this.config.get('security.permissionPreset', 'standard'));
    logger.info(`  ✓ Permissions: ${this.permissions.preset} mode`);

    this.audit = new AuditLog(join(WORKSPACE_DIR, '.audit'));
    await this.audit.initialize();
    logger.info('  ✓ Audit logging active');

    this.sandbox = new SandboxGuard(WORKSPACE_DIR);
    logger.info('  ✓ Sandbox: workspace-only file access');

    this.injectionDetector = new InjectionDetector();
    logger.info('  ✓ Prompt injection detection active');

    // ── Phase 2b: Activity Log ──
    this.activityLog = new ActivityLog(WORKSPACE_DIR);
    await this.activityLog.initialize();
    logger.info('  ✓ Activity log initialized');

    // ── Phase 3: Soul & Memory ──
    this.soul = new SoulService(join(WORKSPACE_DIR, 'soul'));
    await this.soul.load();
    logger.info(`  ✓ Soul loaded: "${this.soul.getName()}"`);

    this.memory = new MemoryService(join(WORKSPACE_DIR, 'memory'), this.config.get('memory'));
    await this.memory.initialize();
    logger.info('  ✓ Memory system initialized');

    // ── Phase 3b: Memory Search (FTS5 over conversations + project outputs) ──
    // Hermes-inspired persistent cross-session search. Falls back gracefully
    // if better-sqlite3 isn't available on this platform.
    this.memorySearch = new MemorySearchService(WORKSPACE_DIR);
    await this.memorySearch.initialize();
    if (this.memorySearch.isAvailable()) {
      // Wire memory.process() → live FTS indexing
      this.memory.setLiveIndexHook((entry) => this.memorySearch.indexConversationTurn(entry));
      // Index any pre-existing data on first boot — incremental on subsequent.
      try {
        const result = await this.memorySearch.reindexAll();
        const stats = this.memorySearch.getStats();
        logger.info(`  ✓ Memory search ready: ${stats.totalEntries} entries indexed (added ${result.indexed}, skipped ${result.skipped})`);
      } catch (err) {
        logger.warn(`  ⚠ Memory search reindex failed: ${(err as Error)?.message || err}`);
      }
    } else {
      logger.warn('  ⚠ Memory search unavailable (search will be disabled, rest of AuthorAgent works)');
    }

    // ── Phase 4: AI Providers ──
    const costsConfig = this.config.get('costs') || {};
    costsConfig.persistPath = join(WORKSPACE_DIR, 'costs.json');
    this.costs = new CostTracker(costsConfig);
    await this.costs.initialize();
    logger.info(`  ✓ Budget: $${this.costs.dailyLimit}/day, $${this.costs.monthlyLimit}/month (persisted)`);

    this.aiRouter = new AIRouter(this.config.get('ai'), this.vault, this.costs, WORKSPACE_DIR);
    await this.aiRouter.initialize();
    // Load global preferred provider from config
    const globalPref = this.config.get('ai.preferredProvider');
    if (globalPref) {
      this.aiRouter.setGlobalPreferredProvider(globalPref);
      logger.info(`  ✓ Global preferred provider: ${globalPref}`);
    }
    const globalPrefFallback = this.config.get('ai.preferredProviderFallback');
    if (globalPrefFallback) {
      this.aiRouter.setGlobalPreferredProviderFallback(globalPrefFallback);
      logger.info(`  ✓ Preferred provider fallback: ${globalPrefFallback}`);
    }
    const providers = this.aiRouter.getActiveProviders();
    for (const p of providers) {
      const tier = p.tier === 'free' ? '🆓 FREE' : p.tier === 'cheap' ? '💰 CHEAP' : '💎 PAID';
      logger.info(`  ✓ AI: ${p.name} (${p.model}) — ${tier}`);
    }

    // ── Phase 5: Research Gate ──
    this.research = new ResearchGate(
      join(ROOT_DIR, 'config', 'research-allowlist.json'),
      this.audit
    );
    await this.research.initialize();
    logger.info(`  ✓ Research gate: ${this.research.getAllowedDomainCount()} approved domains`);

    // ── Phase 6: Skills ──
    this.skills = new SkillLoader(join(ROOT_DIR, 'skills'), this.permissions, WORKSPACE_DIR);
    await this.skills.loadAll();
    const premiumCount = this.skills.getPremiumSkillCount();
    const premiumLabel = premiumCount > 0 ? `, ${premiumCount} premium ★` : '';
    logger.info(`  ✓ Skills: ${this.skills.getLoadedCount()} loaded (${this.skills.getAuthorSkillCount()} author-specific${premiumLabel})`);

    // ── Phase 6a: Auto-generate SKILLS.txt reference file ──
    await this.writeSkillsReference(ROOT_DIR);

    // ── Phase 6b: Author OS Tools ──
    // Author OS is a SEPARATE project (Author Workflow Engine, Book Bible Engine,
    // Manuscript Autopsy, AI Author Library, Creator Asset Suite, Format Factory Pro).
    // If you have it installed alongside AuthorAgent, we auto-discover and integrate.
    // If you don't, AuthorAgent works fine without it — this is purely additive.
    const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
    const authorOSCandidates = [
      process.env.AUTHOR_OS_PATH || '',                           // Explicit env var (highest priority)
      '/app/author-os',                                           // Docker mount
      join(homeDir, 'author-os'),                                 // ~/author-os (Linux/macOS)
      join(homeDir, 'Author OS'),                                 // ~/Author OS (with space)
      join(ROOT_DIR, '..', 'Author OS'),                          // Sibling to AuthorAgent
      join(ROOT_DIR, '..', '..', 'Author OS'),                    // Automations/Author OS/ (Windows default)
      join(ROOT_DIR, '..', 'author-os'),                          // sibling lowercase
    ].filter(Boolean);
    const authorOSPath = authorOSCandidates.find(p => existsSync(p)) || '';
    this.authorOS = new AuthorOSService(authorOSPath);
    if (authorOSPath) {
      await this.authorOS.initialize();
      const osTools = this.authorOS.getAvailableTools();
      if (osTools.length > 0) {
        logger.info(`  ✓ Author OS: ${osTools.length} tools found at ${authorOSPath}`);
        logger.info(`    (${osTools.join(', ')})`);

        // Auto-generate synthetic skills from Author OS so users don't have to
        // hand-write SKILL.md files for every tool. The skills become matchable
        // triggers in handleMessage and show up in the Available Skills system prompt.
        try {
          const synthSkills = await this.authorOS.generateSyntheticSkills();
          const added = this.skills.registerSynthetic(synthSkills);
          if (added > 0) {
            logger.info(`  ✓ Author OS skills auto-registered: ${added} skill(s) (${synthSkills.map(s => s.name).join(', ')})`);
            // Refresh SKILLS.txt so the synthetic skills are visible to the AI's prompt context.
            await this.writeSkillsReference(ROOT_DIR);
          }
        } catch (err) {
          logger.warn(`  ⚠ Could not auto-generate Author OS skills: ${(err as Error)?.message || err}`);
        }
      } else {
        logger.info(`  ℹ Author OS folder found at ${authorOSPath} but no recognized tools inside.`);
        logger.info(`    Expected subfolders: "Author Workflow Engine", "Book Bible Engine", "Manuscript Autopsy", "AI Author Library".`);
      }
    } else {
      logger.info('  ℹ Author OS: not installed (optional — AuthorAgent works without it).');
      logger.info('    To enable: place the Author OS folder next to AuthorAgent, or set AUTHOR_OS_PATH in .env');
    }

    // ── Phase 6c: TTS Service (Piper) — silent init, optional feature ──
    this.tts = new TTSService(WORKSPACE_DIR, this.vault);
    await this.tts.initialize();

    // ── Phase 6c2: Image Generation Service ──
    this.imageGen = new ImageGenService(WORKSPACE_DIR, this.vault);
    await this.imageGen.initialize();

    // ── Phase 6d: Author Personas ──
    this.personas = new PersonaService(WORKSPACE_DIR);
    await this.personas.initialize();
    logger.info(`  ✓ Personas: ${this.personas.getCount()} author persona(s) loaded`);

    // ── Phase 6e: Project Engine ──
    this.projectEngine = new ProjectEngine(this.authorOS, ROOT_DIR);
    // Wire AI capabilities for dynamic planning
    this.projectEngine.setAI(
      (request) => this.aiRouter.complete(request),
      (taskType) => this.aiRouter.selectProvider(taskType)
    );
    const templates = this.projectEngine.getTemplates();
    logger.info(`  ✓ Project engine: ${templates.length} templates + dynamic AI planning`);

    // ── Phase 6f: Context Engine ──
    this.contextEngine = new ContextEngine(WORKSPACE_DIR);
    this.projectEngine.setContextEngine(this.contextEngine);
    logger.info('  ✓ Context Engine: manuscript memory + continuity checking');

    // ── Phase 6f2: Memory Tier Service (Chunk B1) ──
    // Pure read + budget layer over ContextEngine (CORE tier) + MemorySearch
    // (ARCHIVAL tier). memorySearch may be internally unavailable (no
    // better-sqlite3) — MemoryTierService guards on isAvailable() so archival
    // search degrades to '' and CORE assembly still works from ContextEngine.
    this.memoryTier = new MemoryTierService(
      this.contextEngine,
      this.memorySearch?.isAvailable() ? this.memorySearch : null,
      WORKSPACE_DIR,
    );
    this.projectEngine.setMemoryTier(this.memoryTier);
    logger.info(`  ✓ Memory tier: CORE budgeting + ARCHIVAL search (${this.memorySearch?.isAvailable() ? 'search on' : 'search off'})`);

    // Wire the message pipeline + step-hook services so the ProjectEngine can
    // execute steps (single + autonomous loop) without importing the gateway
    // (which would create a circular dependency). The service bundle is filled
    // lazily inside the arrow fns so services constructed after this phase
    // (writingJudge, tts) are picked up when a step actually runs.
    this.projectEngine.setMessageHandler(
      (content, channel, respond, extraContext, overrideTaskType, preferredProvider) =>
        this.handleMessage(content, channel, respond, extraContext, overrideTaskType, preferredProvider)
    );

    // ── Phase 6g: Lessons & Preferences (from Sneakers) ──
    this.lessons = new LessonStore(join(WORKSPACE_DIR, 'memory'));
    await this.lessons.initialize();
    logger.info(`  ✓ Lessons: ${this.lessons.getAll().length} learned`);

    this.preferences = new PreferenceStore(join(WORKSPACE_DIR, 'memory'));
    await this.preferences.initialize();
    const prefCount = Object.keys(this.preferences.getAll()).length;
    logger.info(`  ✓ Preferences: ${prefCount} tracked`);

    // ── Phase 6g2: User Model (Honcho-style dialectic, simplified) ──
    // Tracks behavioral observations + per-persona breakdown + periodically
    // consolidates them into an LLM-generated narrative profile.
    this.userModel = new UserModelService(WORKSPACE_DIR);
    this.userModel.setAI(
      (req) => this.aiRouter.complete(req),
      (taskType: string) => this.aiRouter.selectProvider(taskType),
    );
    await this.userModel.initialize();
    const um = this.userModel.getSnapshot();
    logger.info(`  ✓ User model: ${um?.observationCount || 0} observations${um?.narrative.confidence ? `, narrative confidence ${(um.narrative.confidence * 100).toFixed(0)}%` : ''}`);

    // ── Phase 6g3: Cron Scheduler (Hermes-inspired) ──
    this.cronScheduler = new CronSchedulerService(WORKSPACE_DIR);
    await this.cronScheduler.initialize();
    // Register built-in handlers — user-created jobs reference these by name.
    this.cronScheduler.registerHandler('reindex-memory-search', async () => {
      if (!this.memorySearch?.isAvailable()) return { success: false, message: 'Search unavailable' };
      const r = await this.memorySearch.reindexAll();
      return { success: true, message: `Indexed ${r.indexed}, skipped ${r.skipped}` };
    });
    this.cronScheduler.registerHandler('consolidate-user-model', async () => {
      const snap = await this.userModel.maybeConsolidate(true);
      return { success: !!snap, message: snap ? `Narrative refreshed (confidence ${(snap.narrative.confidence * 100).toFixed(0)}%)` : 'No AI provider available' };
    });
    this.cronScheduler.registerHandler('heartbeat-broadcast', async (payload) => {
      const message = String(payload?.message || 'Scheduled check-in.');
      try {
        this.io.emit('cron-broadcast', { message, at: new Date().toISOString() });
      } catch (err) {
        logger.debug('cron broadcast emit failed', err);
      }
      return { success: true, message: `Broadcast: ${message.substring(0, 80)}` };
    });
    // Sleep-time consolidation (Tiered Memory Chunk C). The service is built
    // later in initialize() (after SeriesBible), so this handler reads it
    // lazily and guards on it being ready — mirrors how the reindex handler
    // reads this.memorySearch.
    // Reader-feedback weekly sync — lazy-guarded like the handlers above.
    this.cronScheduler.registerHandler('reader-feedback-sync', async () => {
      if (!this.readerFeedback) return { success: false, message: 'Reader feedback not initialized' };
      return this.readerFeedback.syncAll();
    });
    this.cronScheduler.registerHandler('sleep-consolidation', async (payload) => {
      if (!this.sleepConsolidation) return { success: false, message: 'Sleep consolidation not initialized' };
      return this.sleepConsolidation.run(payload || {});
    });
    // Skill curation (Skill Curator, Hermes-pattern). The SkillCuratorService is
    // built later in initialize() (Phase 6g4b), so this handler reads it lazily
    // and guards on it being ready — mirrors the sleep-consolidation handler.
    this.cronScheduler.registerHandler('skill-curation', async (payload) => {
      if (!this.skillCurator) return { success: false, message: 'Skill curator not initialized' };
      try {
        const report = await this.skillCurator.curate(payload || {});
        return {
          success: true,
          message:
            `Curated ${report.totalSkills} skill(s): ${report.unused.length} unused, ` +
            `${report.overlapping.length} overlapping pair(s), ${report.redundantWithService.length} service-redundant`,
        };
      } catch (err: any) {
        return { success: false, message: err?.message || 'Curation failed' };
      }
    });
    this.cronScheduler.start();
    // Seed the daily sleep-consolidation job at 04:00 if it doesn't already
    // exist (idempotent across restarts) — mirrors the design's default schedule.
    if (!this.cronScheduler.list().some(j => j.handler === 'sleep-consolidation')) {
      try {
        await this.cronScheduler.createJob({
          name: 'Sleep-time memory consolidation',
          schedule: '0 4 * * *',
          handler: 'sleep-consolidation',
        });
        logger.info('  ✓ Registered daily sleep-consolidation cron (0 4 * * *)');
      } catch (err) {
        logger.warn(`  ⚠ Could not seed sleep-consolidation cron: ${(err as any)?.message || err}`);
      }
    }
    // Seed the weekly skill-curation job (Monday 05:00) if absent — idempotent
    // across restarts, mirroring the sleep-consolidation seeding above.
    if (!this.cronScheduler.list().some(j => j.handler === 'skill-curation')) {
      try {
        await this.cronScheduler.createJob({
          name: 'Weekly skill-library curation',
          schedule: '0 5 * * 1',
          handler: 'skill-curation',
        });
        logger.info('  ✓ Registered weekly skill-curation cron (0 5 * * 1)');
      } catch (err) {
        logger.warn(`  ⚠ Could not seed skill-curation cron: ${(err as any)?.message || err}`);
      }
    }
    logger.info(`  ✓ Cron scheduler: ${this.cronScheduler.list().length} job(s) scheduled, ${this.cronScheduler.listHandlers().length} handlers`);

    // ── Phase 6g4: Auto-Skill Creator ──
    // Drafts SKILL.md files from completed projects. Drafts go to
    // skills/_drafts and require user approval before promotion to ops/.
    this.autoSkill = new AutoSkillService(ROOT_DIR);
    this.autoSkill.setAI(
      (req) => this.aiRouter.complete(req),
      (taskType: string) => this.aiRouter.selectProvider(taskType),
    );
    this.autoSkill.setExistingSkillsLookup(() => {
      const names = new Set<string>();
      for (const s of this.skills?.getSkillCatalog() || []) names.add(s.name);
      return names;
    });
    await this.autoSkill.initialize();
    const drafts = this.autoSkill.list({ status: 'pending_review' });
    logger.info(`  ✓ Auto-skill drafter: ${drafts.length} draft(s) pending review`);

    // ── Phase 6g4b: Skill Curator (Hermes-pattern library health) ──
    // Reads the loaded skill catalog + the usage stats logged by
    // SkillLoader.matchSkills and produces a READ-ONLY curation report: unused
    // skills, overlapping pairs (cheap non-AI similarity), and skills that
    // duplicate a backend service (the style-clone split-brain). The optional
    // summary uses the FREE tier only. Runs weekly via the 'skill-curation'
    // cron handler registered above; also exposed at GET /api/skills/curation.
    this.skillCurator = new SkillCuratorService(
      this.skills,
      (req) => this.aiRouter.complete(req),
      (taskType: string) => this.aiRouter.selectProvider(taskType),
    );
    logger.info('  ✓ Skill curator: usage tracking + weekly consolidation pass ready');

    // ── Phase 6g5: Writing Judge (AutoNovel-inspired evaluate-retry loop) ──
    // Mechanical screen (regex) + LLM judge runs on every chapter draft.
    // If quality below threshold, the auto-execute path retries with the
    // judge's feedback as steering input. Capped at 1 retry by default to
    // keep AI cost predictable.
    this.writingJudge = new WritingJudgeService();
    logger.info('  ✓ Writing judge: mechanical screen + LLM judge ready');

    // ── GEPA-style Reflective Prose Evolution ──
    // Uses the WritingJudge as a fitness signal to iteratively improve a prose
    // passage (score → reflect → revise → re-score), keeping only candidates
    // that strictly beat the running best (Pareto / no-regression) and stopping
    // after 2 non-improving rounds. Voice is preserved via the soul/style-guide;
    // manuscript consistency via CORE memory. Stateless — deps (judge + router
    // closures + soul + memoryTier) are passed per request from the route.
    this.proseEvolver = new ProseEvolverService();
    logger.info('  ✓ Prose evolver: GEPA reflective evolution (judge-as-fitness, no-regression) ready');

    // ── Synthetic Reader Panels — tournament-based marketing-asset testing ──
    // Pairwise persona tournament for blurbs/titles/cover-concepts with
    // anti-slop safeguards (clustering, repetition, position-bias, confidence).
    // Stateless; the router closures are passed per-request from the route.
    this.readerPanel = new ReaderPanelService();
    logger.info('  ✓ Reader panels: synthetic persona tournament ready');

    // ── Phase 6g6: Research services (sourced lookup + video extraction) ──
    this.researchLookup = new ResearchLookupService();
    this.researchLookup.setDependencies(this.vault, this.aiRouter);

    this.videoResearch = new VideoResearchService(WORKSPACE_DIR);
    this.videoResearch.setDependencies(this.vault, this.aiRouter);
    const videoDoctor = await this.videoResearch.doctor();
    if (videoDoctor.ready) {
      logger.info(`  ✓ Research lookup ready (Perplexity via OpenRouter or fallback) | Video research ready (yt-dlp${videoDoctor.ffmpegInstalled ? ' + ffmpeg' : ''}${videoDoctor.whisperKeyConfigured ? ' + Whisper' : ''})`);
    } else {
      logger.info('  ✓ Research lookup ready | Video research disabled (yt-dlp not installed — see /api/video/doctor)');
    }

    // ── Phase 6g7: Story Structures (smart-recommend, not forced) ──
    this.storyStructures = new StoryStructureService();
    logger.info(`  ✓ Story structures: ${this.storyStructures.list().length} structures available (Save the Cat, three-act, five-act / Freytag, Seven-Point / Wells, Hero's Journey, Romancing the Beat, Story Circle, Mystery 5-Stage, Martell Thematic, none)`);

    // ── Phase 6g8: Plot Promises (Sanderson-style promises + payoffs) ──
    this.plotPromises = new PlotPromisesService(WORKSPACE_DIR);
    await this.plotPromises.initialize();
    logger.info(`  ✓ Plot promises: tracker ready`);

    // ── Phase 6g9: Character voices (per-character StyleClone fingerprinting) ──
    this.characterVoices = new CharacterVoicesService(WORKSPACE_DIR);
    this.characterVoices.setStyleClone(this.styleClone);
    await this.characterVoices.initialize();
    logger.info(`  ✓ Character voices: per-character voice drift tracker ready`);

    // ── Phase 6h: Website management — auto-add-book, blog drafter, deploy ──
    this.websiteSites = new WebsiteSiteService(WORKSPACE_DIR);
    await this.websiteSites.initialize();
    this.blogPostDrafter = new BlogPostDrafterService();
    this.websiteDeploy = new WebsiteDeployService();
    const sitesCount = this.websiteSites.list().length;
    logger.info(`  ✓ Website management: ${sitesCount} site${sitesCount === 1 ? '' : 's'} registered, blog drafter + deploy adapters ready`);

    // Register the project-completion hook for auto-add-book.
    // When a book-production project completes AND has linked sites, the
    // book is auto-added to each site's books list (idempotent on slug).
    // Author still has to render + deploy explicitly — auto-publishing
    // would be too aggressive.
    this.projectEngine.onProjectCompleted(async (project: any) => {
      try {
        const isBookProject = project.type === 'book-production' || project.type === 'novel-pipeline';
        if (!isBookProject) return;
        const linkedSites = this.websiteSites.findSitesForProject(project.id);
        if (linkedSites.length === 0) return;

        const persona = project.personaId ? this.personas.get?.(project.personaId) : null;
        const authorName = persona?.penName || 'AuthorAgent';
        const slug = String(project.title || 'untitled').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        const book: import('./services/website-builder.js').WebsiteBook = {
          slug,
          title: project.title,
          subtitle: project.context?.subtitle,
          blurb: this.escapeBasicHTML(String(project.description || '')),
          releaseDate: new Date().toISOString().split('T')[0],
          seriesName: project.context?.seriesName,
          seriesNumber: project.context?.seriesNumber,
          genre: project.context?.genre,
          formats: ['ebook'],
        };

        for (const site of linkedSites) {
          await this.websiteSites.autoAddBook(site.id, book);
          this.activityLog.log({
            type: 'file_saved',
            source: 'internal',
            goalId: project.id,
            message: `Auto-added "${project.title}" to site "${site.config.siteName}". Render + deploy when ready.`,
            metadata: { siteId: site.id, bookSlug: slug, authorName },
          });
        }
      } catch (err) {
        logger.warn('  [website-sites] auto-add-book hook failed:', (err as Error)?.message || err);
      }
    });

    // ── Wire project-completion hooks ──
    // When a project finishes, observe the event for the user model AND
    // give the auto-skill drafter a chance to capture the workflow.
    this.projectEngine.onProjectCompleted((project: any) => {
      // User-model observation
      try {
        this.userModel?.observe({
          type: 'project_completed',
          metadata: { projectId: project.id, type: project.type, stepCount: project.steps?.length || 0 },
          personaId: project.personaId || this.memory.getActivePersonaId(),
        });
      } catch { /* never block completion */ }
      // Auto-skill draft (fire-and-forget; AI may take a few seconds)
      this.autoSkill?.maybeDraftFromProject({
        id: project.id,
        type: project.type,
        title: project.title,
        description: project.description,
        steps: project.steps || [],
      }).catch(err => logger.error('[auto-skill] draft error:', err));
    });

    // ── Phase 6h: Orchestrator (script manager) ──
    this.orchestrator = new OrchestratorService(WORKSPACE_DIR);
    await this.orchestrator.initialize();
    const scriptCount = this.orchestrator.getConfigs().length;
    logger.info(`  ✓ Orchestrator: ${scriptCount} script(s) configured`);
    await this.orchestrator.autoStartAll();
    this.orchestrator.startHealthCheck();

    // ── Phase 6i: Author-facing export & feedback services ──
    this.kdpExporter = new KDPExporter();
    this.betaReader = new BetaReaderService();
    this.dialogueAuditor = new DialogueAuditor();
    this.manuscriptHub = new ManuscriptHubService();
    this.coverTypography = new CoverTypographyService();
    this.externalTools = new ExternalToolsService(ROOT_DIR);
    this.trackChanges = new TrackChangesService();
    logger.info('  ✓ KDP exporter, beta reader, dialogue auditor, hub, cover typography, external tools, track-changes ready');

    // ── Phase 6j: Wave 2 — career/craft/series/audiobook/voice ──
    this.goalsService = new GoalsService(WORKSPACE_DIR);
    await this.goalsService.initialize();
    logger.info(`  ✓ Author goals: ${this.goalsService.listGoals().length} tracked`);

    this.seriesBible = new SeriesBibleService(WORKSPACE_DIR);
    await this.seriesBible.initialize();
    logger.info(`  ✓ Series bible: ${this.seriesBible.listSeries().length} series`);

    // ── Phase 6j2: Sleep-Time Consolidation (Tiered Memory Chunk C) ──
    // Materializes the CoreDigest read on the hot path, plus prunes prefs,
    // reindexes + backfills FTS ownership, and refreshes the series bible.
    // All AI calls go through the FREE tier only (general/research/marketing).
    // Built here so all its deps (contextEngine, seriesBible, preferences,
    // memorySearch, memoryTier, projectEngine) already exist; the cron handler
    // registered earlier reads it lazily.
    this.sleepConsolidation = new SleepConsolidationService({
      contextEngine: this.contextEngine,
      seriesBible: this.seriesBible,
      preferences: this.preferences,
      memorySearch: this.memorySearch?.isAvailable() ? this.memorySearch : null,
      memoryTier: this.memoryTier,
      projects: this.projectEngine,
      aiComplete: (request) => this.aiRouter.complete(request),
      aiSelectProvider: (taskType: string) => this.aiRouter.selectProvider(taskType),
      workspaceDir: WORKSPACE_DIR,
    });
    logger.info('  ✓ Sleep consolidation: CoreDigest materialization + free-tier passes ready');

    // ── Reader-feedback moat ──
    // Ingests public Royal Road stats/comments (polite, rate-limited) and
    // distills free-tier comment themes so future chapters can be drafted
    // with real reader-reaction data. Wattpad is an honest stub.
    this.readerFeedback = new ReaderFeedbackService({
      workspaceDir: WORKSPACE_DIR,
      aiComplete: (request) => this.aiRouter.complete(request),
      aiSelectProvider: (taskType: string) => this.aiRouter.selectProvider(taskType),
    });
    await this.readerFeedback.initialize();
    logger.info('  ✓ Reader-feedback moat: Royal Road ingestion + free-tier comment themes ready');

    this.craftCritic = new CraftCriticService();
    this.audiobookPrep = new AudiobookPrepService();
    this.styleClone = new StyleCloneService();
    logger.info('  ✓ Craft critic, audiobook prep, style clone ready');

    // ── Active contradiction detection ──
    // ConStory-style consistency checker: diffs a chapter against the entity DB
    // + prior summaries and returns categorized, evidence-chained contradictions.
    // Stateless (deps passed per-call), so a single instance is shared. Built
    // before the revision orchestrator so the continuity pass can use it.
    this.contradictionDetector = new ContradictionDetector();
    logger.info('  ✓ Contradiction detector: active consistency checking (ConStory taxonomy) ready');

    // ── Character persona agents ──
    // Each major character becomes a standing critic of their OWN dialogue: the
    // service extracts a character's lines from a chapter and runs ONE mid-tier
    // ('style_analysis') critique per character, flagging off-voice /
    // anachronistic-knowledge / off-motivation lines with in-voice rewrites.
    // Reuses the CharacterVoices fingerprint store (built above) for each
    // character's voice signature. Stateless per call (entities/summaries passed
    // in), so a single shared instance.
    this.characterAgent = new CharacterAgentService(this.characterVoices);
    logger.info('  ✓ Character persona agents: per-character dialogue self-critique ready');

    // ── Specialist revision passes ──
    // Coordinates narrow expert passes (continuity, voice, craft, anti-slop)
    // into ONE prioritized findings report. Each pass routes to its own
    // cost-appropriate tier; anti-slop is a free mechanical screen. Built here
    // now that every analyzer it composes exists. All deps are optional — a
    // pass whose analyzer is missing is skipped gracefully. The continuity pass
    // uses the contradiction detector (evidence-chained chapter diff) and falls
    // back to ContextEngine.runContinuityCheck when it is absent.
    this.revisionOrchestrator = new RevisionOrchestrator({
      contextEngine: this.contextEngine,
      characterVoices: this.characterVoices,
      styleClone: this.styleClone,
      craftCritic: this.craftCritic,
      dialogueAuditor: this.dialogueAuditor,
      writingJudge: this.writingJudge,
      contradictionDetector: this.contradictionDetector,
      aiComplete: (req) => this.aiRouter.complete(req),
      aiSelectProvider: (taskType: string) => this.aiRouter.selectProvider(taskType),
    });
    logger.info('  ✓ Revision orchestrator: specialist passes (continuity · voice · craft · anti-slop) ready');

    // ── Learn-from-experience loop ──
    // Distils the RECURRING flags across the quality tools' reports (revision,
    // contradiction, character) into durable LESSONS written to the LessonStore.
    // LessonStore.buildContext() already injects high-confidence lessons into the
    // writing system prompt (message-pipeline buildSystemPrompt → "# Lessons
    // Learned"), so a learned lesson feeds forward into the next draft — the
    // improvement loop closes automatically. Aggregation is pure code; at most
    // ONE free-tier ('general') AI call phrases the top patterns. Stateless per
    // call apart from its LessonStore handle, so a single shared instance.
    this.learning = new LearningService(this.lessons);
    logger.info('  ✓ Learning service: recurring-issue → durable-lesson loop ready');

    // ── Phase 6k: Wave 3 — autonomous career agent (gated) ──
    this.confirmationGate = new ConfirmationGateService(WORKSPACE_DIR);
    this.confirmationGate.setAuditLogger((category, action, meta) => this.audit.log(category, action, meta));
    await this.confirmationGate.initialize();
    logger.info(`  ✓ Confirmation gate: ${this.confirmationGate.list({ status: 'pending' }).length} pending`);

    this.disclosures = new DisclosuresService();

    this.launchOrchestrator = new LaunchOrchestratorService(WORKSPACE_DIR);
    this.launchOrchestrator.setDependencies(this.confirmationGate, this.disclosures);
    await this.launchOrchestrator.initialize();
    logger.info(`  ✓ Launch orchestrator: ${this.launchOrchestrator.listLaunches().length} launch(es) tracked`);

    this.amsAds = new AMSAdsService();
    this.bookbub = new BookBubSubmitterService();

    this.releaseCalendar = new ReleaseCalendarService(WORKSPACE_DIR);
    await this.releaseCalendar.initialize();
    logger.info(`  ✓ Release calendar: ${this.releaseCalendar.list().length} event(s)`);

    this.readerIntel = new ReaderIntelService();

    this.translationPipeline = new TranslationPipelineService();
    this.translationPipeline.setGate(this.confirmationGate);
    this.translationPipeline.setAI(
      (req) => this.aiRouter.complete(req),
      (taskType: string) => this.aiRouter.selectProvider(taskType),
    );

    this.websiteBuilder = new WebsiteBuilderService(WORKSPACE_DIR);
    logger.info('  ✓ AMS, BookBub, Reader Intel, Translation, Website Builder ready');
    logger.warn('  ⚠ Wave 3 actions are gated — review SECURITY.md and confirm every external action.');

    // ── Phase 7: Heartbeat ──
    this.heartbeat = new HeartbeatService(this.config.get('heartbeat'), this.memory, WORKSPACE_DIR);

    // Wire autonomous mode — heartbeat can now trigger project steps on a schedule
    const commandHandlers = this.buildTelegramCommandHandlers();
    this.heartbeat.setAutonomous(
      // Run one project step (reuses the same logic as Telegram /project command)
      async (projectId: string) => commandHandlers.startAndRunProject(projectId),
      // List projects with remaining step counts
      () => this.projectEngine.listProjects().map(g => ({
        id: g.id,
        title: g.title,
        status: g.status,
        progress: `${g.progress}%`,
        progressNum: g.progress,
        stepsRemaining: g.steps.filter(s => s.status === 'pending' || s.status === 'active').length,
        type: g.type,
      })),
      // Broadcast status to dashboard (WebSocket) and Telegram
      (message: string) => {
        this.io.emit('autonomous-status', { message, timestamp: new Date().toISOString() });
        if (this.telegram) {
          this.telegram.broadcastToAllowed?.(message);
        }
      },
      // Self-improvement analysis callback
      async (projectId: string) => {
        const project = this.projectEngine.getProject(projectId);
        if (!project) return null;

        // Read the last completed step results for analysis
        const completedSteps = project.steps
          .filter((s: any) => s.status === 'completed' && s.result)
          .slice(-10);

        if (completedSteps.length === 0) return null;

        const sampleText = completedSteps
          .map((s: any) => `### ${s.label}\n${(s.result || '').substring(0, 1500)}`)
          .join('\n\n');

        try {
          const provider = this.aiRouter.selectProvider('general');
          const result = await this.aiRouter.complete({
            provider: provider.id,
            system: 'You are a writing coach analyzing completed manuscript output. Be specific and actionable.',
            messages: [{
              role: 'user' as const,
              content: `Analyze this writing from the completed project "${project.title}". Identify:\n\n` +
                `1. 3-5 actionable insights for improving future writing\n` +
                `2. 2-3 specific strengths to maintain\n` +
                `3. 2-3 specific weaknesses to address\n\n` +
                `Return ONLY valid JSON: {"insights":["..."],"strengths":["..."],"weaknesses":["..."]}\n\n` +
                `Writing samples:\n\n${sampleText}`,
            }],
          });

          // Parse AI response
          const cleaned = result.text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
          const parsed = JSON.parse(cleaned);

          // Save to self-improve log
          const workspaceDir = WORKSPACE_DIR;
          const agentDir = join(workspaceDir, '.agent');
          await fs.mkdir(agentDir, { recursive: true });
          const logPath = join(agentDir, 'self-improve-log.json');
          let log: any[] = [];
          try {
            if (existsSync(logPath)) {
              log = JSON.parse(await fs.readFile(logPath, 'utf-8'));
            }
          } catch { /* start fresh */ }

          log.push({
            projectId,
            projectTitle: project.title,
            timestamp: new Date().toISOString(),
            ...parsed,
          });

          // Keep last 50 entries
          if (log.length > 50) log = log.slice(-50);
          await fs.writeFile(logPath, JSON.stringify(log, null, 2), 'utf-8');

          this.activityLog.log({
            type: 'system',
            source: 'internal',
            goalId: projectId,
            message: `Self-improvement analysis saved: ${parsed.insights?.length || 0} insights`,
            metadata: { insights: parsed.insights?.length, strengths: parsed.strengths?.length },
          });

          // ── Core Lessons Consolidation ──
          // Every 5 entries, distill ALL insights into a persistent "Core Lessons" file.
          // This prevents old improvements from being forgotten as new ones are added.
          // Core Lessons get injected into future project system prompts.
          if (log.length % 5 === 0 && log.length >= 5) {
            try {
              const allInsights = log.flatMap((l: any) => l.insights || []);
              const allStrengths = log.flatMap((l: any) => l.strengths || []);
              const allWeaknesses = log.flatMap((l: any) => l.weaknesses || []);

              const consolidateResult = await this.aiRouter.complete({
                provider: provider.id,
                system: 'You are a writing coach creating a persistent learning document. Distill patterns from many observations into timeless, actionable principles. Remove duplicates. Keep the most important lessons. Be concise — each lesson should be 1-2 sentences max.',
                messages: [{
                  role: 'user' as const,
                  content: `Consolidate these observations from ${log.length} completed writing projects into Core Lessons.\n\n` +
                    `ALL INSIGHTS:\n${allInsights.map((i: string, n: number) => `${n + 1}. ${i}`).join('\n')}\n\n` +
                    `ALL STRENGTHS:\n${allStrengths.map((s: string, n: number) => `${n + 1}. ${s}`).join('\n')}\n\n` +
                    `ALL WEAKNESSES:\n${allWeaknesses.map((w: string, n: number) => `${n + 1}. ${w}`).join('\n')}\n\n` +
                    `Create a concise Core Lessons document with these sections:\n` +
                    `1. TOP PRINCIPLES (5-7 most important writing lessons learned)\n` +
                    `2. PROVEN STRENGTHS (3-5 things to keep doing)\n` +
                    `3. RECURRING WEAKNESSES (3-5 things to actively avoid)\n` +
                    `4. STYLE NOTES (any consistent voice/style observations)\n\n` +
                    `Write in second person ("You tend to..." / "Your strength is..."). Be specific and actionable. Max 500 words total.`,
                }],
              });

              const coreLessonsPath = join(agentDir, 'core-lessons.md');
              const coreLessonsContent = `# AuthorAgent Core Lessons\n\n` +
                `*Auto-consolidated from ${log.length} project analyses on ${new Date().toISOString().split('T')[0]}*\n\n` +
                consolidateResult.text;
              await fs.writeFile(coreLessonsPath, coreLessonsContent, 'utf-8');
              logger.info(`  🧠 Core Lessons consolidated from ${log.length} analyses`);
            } catch (consolidateErr) {
              logger.warn(`  ⚠ Core Lessons consolidation failed: ${consolidateErr}`);
            }
          }

          return parsed;
        } catch {
          return null;
        }
      },
      // Follow-up project creation for completed novel pipelines
      async (originalProjectId: string, originalTitle: string, originalType: string) => {
        if (originalType !== 'novel-pipeline') return null;

        const followUpTitle = `Polish & Publish: ${originalTitle}`;
        const followUpDesc = `Follow-up tasks after completing the first draft of "${originalTitle}". ` +
          `Prepare for beta readers, write query letter, create synopsis.`;

        const project = this.projectEngine.createProject('book-launch', followUpTitle, followUpDesc, {
          parentProjectId: originalProjectId,
          parentTitle: originalTitle,
          autoCreated: true,
        });

        this.activityLog.log({
          type: 'project_created',
          source: 'internal',
          goalId: project.id,
          message: `Auto-created follow-up project: "${followUpTitle}"`,
          metadata: { parentProjectId: originalProjectId, steps: project.steps.length },
        });

        return project.id;
      },
      // Idle task: run configurable author-focused tasks when no projects are active
      // Loads tasks from workspace/.config/idle-tasks.json (user-editable via dashboard)
      async () => {
        // Load tasks from config file, falling back to defaults
        const idleConfigPath = join(WORKSPACE_DIR, '.config', 'idle-tasks.json');
        let idleTasks: Array<{ label: string; prompt: string; enabled?: boolean }> = [];
        try {
          if ((await import('fs')).existsSync(idleConfigPath)) {
            const raw = await fs.readFile(idleConfigPath, 'utf-8');
            const parsed = JSON.parse(raw);
            idleTasks = (parsed.tasks || []).filter((t: any) => t.enabled !== false);
          }
        } catch { /* fall through to defaults */ }

        if (idleTasks.length === 0) {
          idleTasks = (await import('./services/idle-tasks-defaults.js')).DEFAULT_IDLE_TASKS;
          // Save defaults on first run
          try {
            const configDir = join(WORKSPACE_DIR, '.config');
            await fs.mkdir(configDir, { recursive: true });
            await fs.writeFile(idleConfigPath, JSON.stringify({ tasks: idleTasks }, null, 2), 'utf-8');
          } catch { /* non-fatal */ }
        }

        if (idleTasks.length === 0) return null;

        // Pick a random task
        const task = idleTasks[Math.floor(Math.random() * idleTasks.length)];

        try {
          const provider = this.aiRouter.selectProvider('general');
          const result = await this.aiRouter.complete({
            provider: provider.id,
            system: 'You are AuthorAgent, an AI writing agent for authors. Be detailed, actionable, and expert-level.',
            messages: [{ role: 'user' as const, content: task.prompt }],
            maxTokens: 2000,
          });

          if (result.text && result.text.length > 20) {
            // Save to workspace
            const idleDir = join(WORKSPACE_DIR, '.agent');
            await fs.mkdir(idleDir, { recursive: true });
            const dateStr = new Date().toISOString().split('T')[0];
            await fs.writeFile(
              join(idleDir, `idle-${dateStr}.md`),
              `# ${task.label}\n*Generated ${new Date().toISOString()}*\n\n${result.text}`,
              'utf-8'
            );

            this.activityLog.log({
              type: 'system',
              source: 'internal',
              message: `Idle task: ${task.label}`,
              metadata: { taskType: task.label },
            });

            return `${task.label}: ${result.text.substring(0, 200)}`;
          }
          return null;
        } catch {
          return null;
        }
      }
    );

    this.heartbeat.start();
    const autonomousLabel = this.config.get('heartbeat.autonomousEnabled')
      ? ` + autonomous every ${this.config.get('heartbeat.autonomousIntervalMinutes', 30)}min`
      : '';
    logger.info(`  ✓ Heartbeat: every ${this.config.get('heartbeat.intervalMinutes', 15)} minutes${autonomousLabel}`);

    // Now that heartbeat + writing judge + activity log all exist, hand the
    // ProjectEngine the service bundle its step-execution hooks use (quality
    // loop, activity feed, word tracking, auto-narrate). Stable references on
    // `this`, so passing them directly is safe.
    this.projectEngine.setStepServices({
      writingJudge: this.writingJudge,
      activityLog: this.activityLog,
      heartbeat: this.heartbeat,
      tts: this.tts,
      personas: this.personas,
      aiRouter: this.aiRouter,
    });

    // ── Phase 8: Bridges ──
    if (this.config.get('bridges.telegram.enabled')) {
      const token = await this.vault.get('telegram_bot_token');
      if (token) {
        this.telegram = new TelegramBridge(token, this.config.get('bridges.telegram'));
        this.telegram.onMessage((content, channel, respond) =>
          this.handleMessage(content, channel, respond)
        );
        this.telegram.setCommandHandlers(commandHandlers);
        await this.telegram.connect();
        logger.info('  ✓ Telegram bridge connected (command center mode)');
      } else {
        logger.warn('  ⚠ Telegram enabled but no token in vault');
      }
    }

    if (this.config.get('bridges.discord.enabled')) {
      const token = await this.vault.get('discord_bot_token');
      if (token) {
        this.discord = new DiscordBridge(token, this.config.get('bridges.discord'));
        await this.discord.connect();
        logger.info('  ✓ Discord bridge connected');
      } else {
        logger.warn('  ⚠ Discord enabled but no token in vault');
      }
    }

    // ── Phase 9: API Routes ──
    createAPIRoutes(this.app, this, ROOT_DIR);
    logger.info('  ✓ API routes registered');

    // ── Phase 10: WebSocket ──
    this.setupWebSocket();
    logger.info('  ✓ WebSocket ready');

    // ── Phase 11: Static Dashboard ──
    const dashboardPath = join(ROOT_DIR, 'dashboard', 'dist');
    this.app.use(express.static(dashboardPath));

    // JSON 404 handler for API routes — MUST run before SPA fallback
    // so unmatched /api/ requests get JSON errors instead of the dashboard HTML.
    this.app.use((req: any, res: any, next: any) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
      }
      next();
    });

    // SPA fallback — any non-API path serves the dashboard HTML
    this.app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) return; // already handled above
      const htmlFile = join(dashboardPath, 'index.html');
      res.sendFile(htmlFile, (err) => {
        if (err && !res.headersSent) {
          res.status(500).json({ status: 'error', message: 'AuthorAgent running but dashboard HTML not found.' });
        }
      });
    });

    // Global JSON error handler — ensures API errors never return HTML
    this.app.use((err: any, _req: any, res: any, _next: any) => {
      logger.error('Unhandled API error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: String(err?.message || err || 'Internal server error') });
      }
    });

    // Log startup to activity log
    await this.activityLog.log({
      type: 'system',
      source: 'internal',
      message: `AuthorAgent started — ${providers.length} AI provider(s), ${this.skills.getLoadedCount()} skills`,
      metadata: {
        providers: providers.map(p => p.id),
        skillCount: this.skills.getLoadedCount(),
      },
    });

    logger.info('');
    logger.info('  ═══════════════════════════════════');
    logger.info('  ✍️  AuthorAgent is ready to write');
    logger.info(`  📡 Dashboard: http://${this.config.get('server.host', 'localhost')}:${this.config.get('server.port', 3847)}`);
    logger.info('  ═══════════════════════════════════');
    logger.info('');
  }

  /**
   * Origins allowed to talk to the API/WebSocket. Always includes localhost
   * (dashboard opened directly on this machine); also includes the
   * configured `server.host`:port when it's been set to something other than
   * localhost (e.g. a Tailscale IP), so the dashboard still works when
   * accessed remotely from a non-localhost origin.
   */
  private getAllowedOrigins(): string[] {
    const port = this.config?.get?.('server.port', 3847) ?? 3847;
    const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
    const host = this.config?.get?.('server.host', '127.0.0.1');
    if (host && host !== '127.0.0.1' && host !== 'localhost') {
      allowed.push(`http://${host}:${port}`);
    }
    return allowed;
  }

  private setupWebSocket(): void {
    this.io.on('connection', (socket) => {
      const origin = socket.handshake.headers.origin;
      const allowed = this.getAllowedOrigins();
      if (origin && !allowed.includes(origin)) {
        this.audit.log('security', 'websocket_rejected', { origin });
        socket.disconnect();
        return;
      }

      this.audit.log('connection', 'websocket_connected', { id: socket.id });

      socket.on('message', async (data: { content: string }) => {
        try {
          await this.handleMessage(data.content, 'webchat', (response) => {
            socket.emit('response', { content: response });
          });
        } catch (error) {
          socket.emit('error', { message: 'An error occurred processing your message' });
          this.audit.log('error', 'message_processing_failed', { error: String(error) });
        }
      });

      socket.on('disconnect', () => {
        this.audit.log('connection', 'websocket_disconnected', { id: socket.id });
      });
    });
  }

  /**
   * Core message handler — processes input from any channel.
   * Optional extraContext is appended to the system prompt (used by goal engine).
   */
  async handleMessage(
    content: string,
    channel: string,
    respond: (text: string) => void,
    extraContext?: string,
    overrideTaskType?: string,
    preferredProvider?: string
  ): Promise<void> {
    // Thin delegate — the full chat pipeline (injection scan, rate limit,
    // preference auto-detect, context build, task classification, system-prompt
    // build, per-channel history, thinking/maxTokens, aiRouter.complete, success
    // persistence, and primary→fallback failure path) lives in MessagePipeline.
    // All callers (REST /api/chat, WebSocket, Telegram, project step-executor)
    // reach the identical behavior through here.
    return this.pipeline.handleMessage(
      content,
      channel,
      respond,
      extraContext,
      overrideTaskType,
      preferredProvider,
    );
  }

  /** Write the human-readable SKILLS.txt reference file in workspace/. */
  private async writeSkillsReference(rootDir: string): Promise<void> {
    try {
      const skillsRefPath = join(rootDir, 'workspace', 'SKILLS.txt');
      const catalog = this.skills.getSkillCatalog();
      const byCategory = this.skills.getSkillsByCategory();
      let refContent = 'AUTHORAGENT SKILLS REFERENCE\n';
      refContent += `Auto-generated on startup — ${catalog.length} skills loaded\n`;
      refContent += '═'.repeat(60) + '\n\n';

      for (const category of ['core', 'author', 'marketing', 'premium', 'ops']) {
        const skills = byCategory[category];
        if (!skills || skills.length === 0) continue;

        const label = category.charAt(0).toUpperCase() + category.slice(1);
        const extra = category === 'premium' ? ' ★' : '';
        refContent += `── ${label} Skills (${skills.length})${extra} ──\n\n`;

        for (const skill of skills) {
          const catalogEntry = catalog.find(c => c.name === skill.name);
          const triggers = catalogEntry?.triggers?.join(', ') || '';
          refContent += `  ${skill.name}\n`;
          refContent += `    ${skill.description}\n`;
          if (triggers) refContent += `    Keywords: ${triggers}\n`;
          refContent += '\n';
        }
      }

      await fs.writeFile(skillsRefPath, refContent, 'utf-8');
      logger.info(`  ✓ SKILLS.txt auto-updated (${catalog.length} skills)`);
    } catch (e) {
      logger.warn(`  ⚠ Failed to update SKILLS.txt: ${e}`);
    }
  }

  /** Escape HTML chars in a string. Used by the website-sites hook so we
   *  don't pass user-supplied project descriptions raw into a book blurb. */
  private escapeBasicHTML(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Expose services for API routes
   */
  getServices() {
    // Delegates to the ServiceContainer, which owns every long-lived service
    // and projects them into the same shape (keys/order) the API routes expect.
    return this.services.getServices();
  }

  getProjectEngine(): ProjectEngine {
    return this.projectEngine;
  }

  getImageGen(): ImageGenService {
    return this.imageGen;
  }

  getActivityLog(): ActivityLog {
    return this.activityLog;
  }

  /**
   * Handle slash commands from the dashboard chat.
   * Mirrors Telegram command logic but returns strings.
   */
  // Dashboard file list cache for /read and /export number-picking
  private dashboardLastFileList: string[] = [];

  async handleDashboardCommand(input: string): Promise<string> {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = input.substring(cmd.length).trim();
    const workspaceDir = WORKSPACE_DIR;
    const handlers = this.buildTelegramCommandHandlers();

    // Natural language commands (no slash prefix)
    const lower = input.toLowerCase().trim();
    if (lower === 'continue' || lower === 'next' || lower === 'go' || lower === 'resume') {
      const projects = this.projectEngine.listProjects();
      const resumable = projects.find(p => p.status === 'active' || p.status === 'paused');
      if (!resumable) return 'No projects to continue. Create one with `/project [task]`.';
      if (resumable.status === 'paused') {
        resumable.status = 'active';
        const firstPending = resumable.steps.find((s: any) => s.status === 'pending');
        if (firstPending) firstPending.status = 'active';
      }
      // Run one step and return the result
      try {
        const result = await handlers.startAndRunProject(resumable.id);
        if ('error' in result) return `Error: ${result.error}`;
        return `▶️ Resumed **"${resumable.title}"**\n\n**Completed:** ${result.completed}\n${result.response.substring(0, 500)}${result.response.length > 500 ? '...' : ''}\n\n${result.nextStep ? `**Next:** ${result.nextStep}` : '✅ Project complete!'}`;
      } catch (err) {
        return `Error resuming project: ${String(err)}`;
      }
    }

    switch (cmd) {
      case '/help':
        return [
          '**Available Commands:**',
          '',
          '📝 **Projects**',
          '`/novel [idea]` — Create a full novel pipeline (all 6 phases)',
          '`/project [task]` — Create any project (AI plans the steps)',
          '`/write [idea]` — Quick writing task',
          '`/projects` — List all projects with status',
          '`/continuity` — Run continuity check on active/completed project',
          '`/status` — Check what\'s running',
          '`/stop` — Pause active project',
          '`continue` — Resume paused project',
          '',
          '📁 **Files & Export**',
          '`/files [folder]` — List project files (numbered)',
          '`/read [# or name]` — Preview a file',
          '`/export [# or name] [format]` — Export to DOCX/HTML/TXT',
          '',
          '🔍 **Research**',
          '`/research [topic]` — Web research with AI synthesis',
          '',
          '🔊 **Voice**',
          '`/speak [text]` — Generate voice audio',
          '`/voice [preset]` — Set TTS voice preset',
          '',
          '🎨 **Images**',
          '`/cover [description]` — Generate a book cover image',
          '',
          '🧹 **Workspace**',
          '`/clean` — View workspace usage',
        ].join('\n');

      case '/novel': {
        if (!args) return 'Usage: `/novel [your novel idea]`\nExample: `/novel a small-town romance about a baker and a firefighter`';
        try {
          const project = this.projectEngine.createNovelPipeline(args, `Write a complete novel: ${args}`);
          this.activityLog.log({ type: 'project_created', source: 'dashboard', goalId: project.id, message: `Novel pipeline: "${args}" (${project.steps.length} steps)` });
          return `Novel pipeline created: **"${args}"** (${project.steps.length} steps)\n\nGo to **Projects** to start execution.`;
        } catch (err) {
          return `Error creating novel pipeline: ${String(err)}`;
        }
      }

      case '/project':
      case '/goal': {
        if (!args) return 'Usage: `/project [describe your task]`\nExample: `/project outline a thriller about a rogue AI`';
        try {
          const result = await handlers.createProject(args, args);
          return `Project created: **"${args}"** (${result.steps} steps)\n\nGo to **Projects** to start execution.`;
        } catch (err) {
          return `Error: ${String(err)}`;
        }
      }

      case '/write': {
        if (!args) return 'Usage: `/write [what to write]`\nExample: `/write a snarky YouTube intro for my channel`';
        try {
          const result = await handlers.createProject(args, args);
          return `Writing project created: **"${args}"** (${result.steps} steps)\n\nGo to **Projects** to start execution.`;
        } catch (err) {
          return `Error: ${String(err)}`;
        }
      }

      case '/projects':
      case '/goals': {
        const projects = this.projectEngine.listProjects();
        if (projects.length === 0) return 'No projects yet. Create one with `/project [task]` or use the **Projects** panel.';
        const lines = projects.map(p => {
          const status = p.status === 'completed' ? '✅' : p.status === 'active' ? '🔄' : '⏸️';
          return `${status} **${p.title}** — ${p.progress}% (${p.steps.filter((s: any) => s.status === 'completed').length}/${p.steps.length} steps)`;
        });
        return `**Projects (${projects.length}):**\n\n${lines.join('\n')}`;
      }

      case '/continuity': {
        const contProjects = this.projectEngine.listProjects();
        const target = contProjects.find((p: any) => p.status === 'completed' || p.status === 'active');
        if (!target) return 'No projects available for continuity check. Create and run a project first.';

        const aiCompleteFn = (req: any) => this.aiRouter.complete(req);
        const aiSelectFn = (taskType: string) => this.aiRouter.selectProvider(taskType);

        try {
          const report = await this.contextEngine.runContinuityCheck(
            target.id,
            aiCompleteFn,
            aiSelectFn,
          );
          let summary = `✅ **Continuity Check Complete**\n\n`;
          summary += `Found **${report.totalIssues}** issue(s):\n`;
          for (const [cat, count] of Object.entries(report.issuesByCategory)) {
            if (count > 0) summary += `- ${cat}: ${count}\n`;
          }
          if (report.issues.length > 0) {
            summary += '\n**Top Issues:**\n';
            report.issues.slice(0, 10).forEach((issue, i) => {
              const icon = issue.severity === 'error' ? '🔴' : issue.severity === 'warning' ? '🟡' : 'ℹ️';
              summary += `${i + 1}. ${icon} ${issue.description}\n`;
            });
            if (report.issues.length > 10) {
              summary += `\n...and ${report.issues.length - 10} more. View full report in the project detail.`;
            }
          }
          return summary;
        } catch (err) {
          return '❌ Continuity check failed: ' + String(err);
        }
      }

      case '/status': {
        const projects = this.projectEngine.listProjects();
        const active = projects.filter(p => p.status === 'active');
        const completed = projects.filter(p => p.status === 'completed');
        const paused = projects.filter(p => p.status === 'paused');
        const autoStatus = this.heartbeat.getAutonomousStatus();
        const stats = this.heartbeat.getStats();
        let status = `**AuthorAgent Status**\n\n`;
        status += `📊 Projects: ${active.length} active, ${paused.length} paused, ${completed.length} completed\n`;
        status += `🤖 Agent: ${autoStatus.enabled ? (autoStatus.running ? '**WORKING**' : '**ON**') : 'OFF'}\n`;
        status += `📝 Words today: ${stats.todayWords.toLocaleString()}/${stats.dailyWordGoal.toLocaleString()} (${stats.goalPercent}%)`;
        if (stats.streak > 0) status += ` 🔥 ${stats.streak}-day streak`;
        status += '\n';
        if (active.length > 0) {
          const current = active[0];
          const currentStep = current.steps.find((s: any) => s.status === 'active');
          status += `\n▶️ Active: **${current.title}** (${current.progress}%)\n`;
          if (currentStep) status += `   Current step: ${currentStep.label}`;
        }
        status += `\n\n🌐 Dashboard: http://localhost:3847`;
        return status;
      }

      case '/stop':
      case '/pause': {
        const projects = this.projectEngine.listProjects();
        const active = projects.find(p => p.status === 'active');
        if (!active) return 'No active project to pause.';
        this.projectEngine.pauseProject(active.id);
        return `⏸️ Paused **"${active.title}"** at ${active.progress}%. Type \`continue\` to resume.`;
      }

      case '/files': {
        const projectsDir = join(workspaceDir, 'projects');
        try {
          const { readdirSync, statSync } = await import('fs');
          if (!existsSync(projectsDir)) return 'No project files yet.';

          // Build numbered file list (like Telegram)
          this.dashboardLastFileList = [];
          const lines: string[] = [];
          const dirs = readdirSync(projectsDir).filter(d => statSync(join(projectsDir, d)).isDirectory());

          if (args) {
            // Show files in specific directory
            const targetDir = join(projectsDir, args);
            if (!existsSync(targetDir)) return `Folder "${args}" not found.`;
            const entries = readdirSync(targetDir, { withFileTypes: true });
            const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
            files.forEach(f => {
              this.dashboardLastFileList.push(join(args, f));
              lines.push(`${this.dashboardLastFileList.length}. ${f}`);
            });
            // Descend one level into per-phase subfolders (ALP-1548).
            const phaseDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
            phaseDirs.forEach(ph => {
              const phaseFiles = readdirSync(join(targetDir, ph)).filter(f => !statSync(join(targetDir, ph, f)).isDirectory());
              lines.push(`📁 **${ph}/** (${phaseFiles.length} files)`);
              phaseFiles.forEach(f => {
                this.dashboardLastFileList.push(join(args, ph, f));
                lines.push(`  ${this.dashboardLastFileList.length}. ${f}`);
              });
            });
            return `**Files in ${args}/:** (${files.length + phaseDirs.length})\n\n${lines.join('\n')}\n\nUse \`/read 1\` to preview or \`/export 1\` to export.`;
          }

          // Show all project directories with files
          dirs.forEach(d => {
            const entries = readdirSync(join(projectsDir, d), { withFileTypes: true });
            const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
            lines.push(`📁 **${d}/** (${files.length} files)`);
            files.forEach(f => {
              this.dashboardLastFileList.push(join(d, f));
              lines.push(`  ${this.dashboardLastFileList.length}. ${f}`);
            });
            // Descend one level into per-phase subfolders (ALP-1548).
            const phaseDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
            phaseDirs.forEach(ph => {
              const phaseFiles = readdirSync(join(projectsDir, d, ph)).filter(f => !statSync(join(projectsDir, d, ph, f)).isDirectory());
              lines.push(`  📁 **${ph}/** (${phaseFiles.length} files)`);
              phaseFiles.forEach(f => {
                this.dashboardLastFileList.push(join(d, ph, f));
                lines.push(`    ${this.dashboardLastFileList.length}. ${f}`);
              });
            });
          });
          return `**Project Files:**\n\n${lines.join('\n')}\n\nUse \`/read 1\` to preview or \`/export 1 docx\` to export.`;
        } catch {
          return 'Could not read project files.';
        }
      }

      case '/read': {
        if (!args) return '📖 Use `/files` first to see numbered list, then:\n`/read 1` — read file #1\n`/read 3` — read file #3\n\nOr use a path:\n`/read projects/my-book/premise.md`';
        try {
          let filename = args;
          const num = parseInt(args, 10);
          if (!isNaN(num) && this.dashboardLastFileList.length > 0 && num >= 1 && num <= this.dashboardLastFileList.length) {
            filename = this.dashboardLastFileList[num - 1];
          }
          const result = await handlers.readFile(filename);
          if (result.error) return `⚠️ ${result.error}\n\n💡 Use \`/files\` first, then \`/read 1\` to read by number.`;
          const preview = result.content.length > 2000
            ? result.content.substring(0, 2000) + `\n\n... (${result.content.length.toLocaleString()} chars total — view full in Library)`
            : result.content;
          return `📄 **${filename}:**\n\n${preview}`;
        } catch (err) {
          return `Error reading file: ${String(err)}`;
        }
      }

      case '/export': {
        if (!args) {
          return [
            '📦 **Export your manuscript:**',
            '',
            '`/export [file] ` — Export to Word (.docx)',
            '`/export [file] html` — Export as HTML',
            '`/export [file] txt` — Export as plain text',
            '`/export [file] all` — All formats',
            '',
            'Use `/files` first, then:',
            '`/export 1` — Export file #1 to Word',
            '`/export 3 html` — Export file #3 as HTML',
          ].join('\n');
        }
        try {
          const exportParts = args.split(/\s+/);
          let filename = exportParts[0];
          const format = exportParts[1]?.toLowerCase() || 'docx';

          const num = parseInt(filename, 10);
          if (!isNaN(num) && this.dashboardLastFileList.length > 0 && num >= 1 && num <= this.dashboardLastFileList.length) {
            filename = this.dashboardLastFileList[num - 1];
          }

          const title = filename.replace(/\.[^.]+$/, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());

          const exportRes = await fetch('http://localhost:3847/api/author-os/format', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inputFile: filename,
              title,
              formats: format === 'all' ? ['all'] : [format],
            }),
          });
          const exportData = await exportRes.json() as any;

          if (exportData.error) return `❌ ${exportData.error}`;
          if (exportData.success) {
            const fileList = (exportData.files || []).map((f: string) => `  📄 ${f.split('/').pop()}`).join('\n');
            return `✅ Export complete!\n\n${fileList}\n\n📁 Saved to workspace/exports/\nUse \`/files exports\` to see them, or check the **Library** panel.`;
          }
          return `⚠️ Export failed: ${exportData.error || 'Unknown error'}`;
        } catch (err) {
          return `❌ Export error: ${String(err)}`;
        }
      }

      case '/research': {
        if (!args) return '🔍 What should I research?\n\nExamples:\n`/research medieval sword types`\n`/research self-publishing trends 2026`\n`/research romance tropes readers love`';
        try {
          const result = await handlers.research(args);
          if (result.error) return `⚠️ ${result.error}`;
          return result.results;
        } catch (err) {
          return `❌ Research failed: ${String(err)}`;
        }
      }

      case '/speak': {
        if (!args) return 'Usage: `/speak [text]` — Generate voice audio\nExample: `/speak Hello, I am your writing assistant`';
        if (!this.tts) return 'TTS service not available.';
        try {
          const result = await this.tts.generate(args, {});
          if (!result.success) return `Voice generation failed: ${result.error || 'unknown error'}`;
          const provider = result.provider ? ` (${result.provider})` : '';
          return `🔊 Voice generated${provider}! Audio saved to: \`${result.file || 'workspace/audio/'}\`\n\nDownload from the **Library** panel.`;
        } catch (err) {
          return `Voice generation failed: ${String(err)}`;
        }
      }

      case '/tts': {
        // Inspired by OpenClaw 2026.4.25 /tts commands.
        // Usage:
        //   /tts                       — show status
        //   /tts latest                — narrate the most recently completed step
        //   /tts persona <name>        — narrate as a specific persona
        //   /tts provider <edge|elevenlabs> — set default provider
        if (!this.tts) return 'TTS service not available.';
        const sub = (args || '').trim().toLowerCase();
        if (!sub) {
          return `**TTS status**\n\n• Provider: \`${this.tts.getActiveProvider()}\`\n• Voice: \`${this.tts.getActiveVoice()}\`\n\nSubcommands:\n• \`/tts latest\` — narrate most recently completed step\n• \`/tts persona <name>\` — narrate using a persona's configured voice\n• \`/tts provider <edge|elevenlabs>\` — set default provider`;
        }
        if (sub === 'latest') {
          // Find the most recently active project (sort by updatedAt desc), then take its
          // last completed step. ProjectStep has no per-step timestamp, so we proxy by
          // project recency.
          const projects = (this.projectEngine.listProjects() || [])
            .filter((p: any) => p.steps?.some((s: any) => s.status === 'completed' && s.result))
            .sort((a: any, b: any) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
          const latestProject = projects[0];
          if (!latestProject) return 'No completed steps to narrate. Finish a project step first.';
          const completed = latestProject.steps.filter((s: any) => s.status === 'completed' && s.result);
          const latestStep = completed[completed.length - 1];
          if (!latestStep) return 'No completed steps to narrate.';
          // Strip the "# <heading>" preamble + cap to ~5000 chars for ElevenLabs friendliness.
          const text = String(latestStep.result || '').replace(/^#[^\n]+\n+/, '').substring(0, 5000);
          // Resolve the persona's voice if the project has one.
          let voice: string | undefined;
          if (latestProject?.personaId) {
            const persona = this.personas.get?.(latestProject.personaId);
            if (persona?.ttsVoice) voice = persona.ttsVoice;
          }
          const result = await this.tts.generate(text, { voice });
          if (!result.success) return `Narration failed: ${result.error}`;
          return `🔊 Narrated **${latestStep.label}** from "${latestProject.title}" (${result.provider}, ~${result.duration}s).\n\nDownload from the **Library** panel: \`${result.filename}\``;
        }
        if (sub.startsWith('persona ')) {
          const personaName = sub.replace(/^persona\s+/, '').trim();
          if (!this.personas) return 'Persona service not available.';
          const all = this.personas.list?.() || [];
          const match = all.find((p: any) => p.penName?.toLowerCase() === personaName.toLowerCase() || p.id === personaName);
          if (!match) return `Persona "${personaName}" not found. List them in the **Personas** panel.`;
          if (!match.ttsVoice) return `Persona "${match.penName}" has no ttsVoice set. Edit the persona in the dashboard.`;
          await this.tts.setVoice(match.ttsVoice);
          return `🔊 Default voice set to ${match.penName}'s voice (\`${match.ttsVoice}\`).`;
        }
        if (sub.startsWith('provider ')) {
          const p = sub.replace(/^provider\s+/, '').trim();
          if (p !== 'edge' && p !== 'elevenlabs') return 'Provider must be `edge` or `elevenlabs`.';
          await this.tts.setProvider(p);
          return `TTS provider set to **${p}**.${p === 'elevenlabs' ? ' Make sure `elevenlabs_api_key` is in the vault.' : ''}`;
        }
        return `Unknown subcommand "${sub}". Try \`/tts\` for help.`;
      }

      case '/voice': {
        if (!this.tts) return 'TTS service not available.';
        const presets = ['narrator_female', 'narrator_male', 'narrator_deep', 'narrator_warm', 'british_male', 'british_female', 'storyteller', 'snarky_nerd', 'curious_kid'];
        if (!args) {
          const active = this.tts.getActiveVoice();
          return `**Voice Presets:**\n\n${presets.map(p => `• \`${p}\`${active?.includes(p) ? ' ✅ (active)' : ''}`).join('\n')}\n\nUsage: \`/voice narrator_warm\` to set your default voice.`;
        }
        if (presets.includes(args.toLowerCase())) {
          try {
            await this.tts.setVoice(args.toLowerCase());
            return `🔊 Voice set to **${args}**.`;
          } catch {
            return `Could not set voice to "${args}".`;
          }
        }
        return `Unknown voice preset "${args}". Available: ${presets.join(', ')}`;
      }

      case '/recall':
      case '/search': {
        // Cross-session full-text memory search (Hermes-inspired).
        // Defaults to filtering by the active persona so pen-name boundaries
        // are respected. Pass --all to search everything.
        if (!this.memorySearch?.isAvailable()) {
          const stats = this.memorySearch?.getStats();
          return `Memory search unavailable. ${stats?.unavailableReason || 'better-sqlite3 not loaded.'}`;
        }
        if (!args) {
          const stats = this.memorySearch.getStats();
          return `**Memory Search**\n\n${stats.totalEntries.toLocaleString()} entries indexed.\nUsage: \`/recall <query>\` (filters by active persona by default)\nAdd \`--all\` to search across all personas.\nExamples:\n• \`/recall dragon throne\`\n• \`/recall "exact phrase"\`\n• \`/recall character NEAR motivation\``;
        }
        const allFlag = / --all\b/.test(args);
        const query = args.replace(/--all\b/g, '').trim();
        const personaFilter = allFlag ? undefined : this.memory.getActivePersonaId() || undefined;
        const hits = this.memorySearch.search(query, {
          limit: 8,
          personaId: personaFilter,
        });
        if (hits.length === 0) return `No matches for "${query}"${personaFilter ? ` (persona-scoped — try \`--all\`)` : ''}.`;
        const lines = hits.map((h, i) => {
          const date = h.timestamp.split('T')[0];
          const where = h.source === 'conversation' ? 'chat'
            : h.source === 'manuscript' ? 'manuscript'
            : h.source === 'project_step' ? 'project step' : h.source;
          return `${i + 1}. **${h.title || h.sourceRef}** _(${where} · ${date})_\n   ${h.snippet.replace(/\n/g, ' ')}`;
        });
        return `**Recalled ${hits.length} match${hits.length === 1 ? '' : 'es'}**${personaFilter ? ` (persona-scoped)` : ''}:\n\n${lines.join('\n\n')}`;
      }

      case '/persona': {
        // Set the active persona for memory tagging. Future chat turns get
        // tagged with this persona so search can filter by pen name.
        if (!args) {
          const active = this.memory.getActivePersonaId();
          const all = this.personas?.list?.() || [];
          const list = all.map((p: any) => `• \`${p.id || p.penName}\`${active && (p.id === active || p.penName === active) ? ' ✅ (active)' : ''} — ${p.penName} (${p.genre || 'unknown genre'})`).join('\n');
          return `**Active persona:** ${active ? `\`${active}\`` : '_(unscoped — memory shared across all)_'}\n\n${list || 'No personas yet. Create one in the Personas panel.'}\n\nUsage:\n• \`/persona <id-or-pen-name>\` — switch active persona\n• \`/persona clear\` — unscope (shared memory)`;
        }
        if (args.toLowerCase() === 'clear') {
          await this.memory.setActivePersona(null);
          return 'Active persona cleared. Future memory entries are unscoped.';
        }
        const all = this.personas?.list?.() || [];
        const match = all.find((p: any) =>
          p.id === args || p.penName?.toLowerCase() === args.toLowerCase());
        if (!match) return `Persona "${args}" not found. Try \`/persona\` to list available ones.`;
        await this.memory.setActivePersona(match.id);
        return `Active persona set to **${match.penName}** (\`${match.id}\`). Future chat turns will be tagged with this pen name.`;
      }

      case '/clean': {
        try {
          const { readdirSync, statSync } = await import('fs');
          if (!existsSync(workspaceDir)) return 'Workspace is empty.';
          const subdirs = ['projects', 'exports', 'documents', 'audio', 'research'];
          let totalFiles = 0;
          const lines = subdirs.map(d => {
            const dir = join(workspaceDir, d);
            if (!existsSync(dir)) return `📁 **${d}/**: empty`;
            try {
              const files = readdirSync(dir, { recursive: true }) as string[];
              const fileCount = files.filter(f => !statSync(join(dir, String(f))).isDirectory()).length;
              totalFiles += fileCount;
              // Calculate rough size
              let sizeBytes = 0;
              files.forEach(f => {
                try { sizeBytes += statSync(join(dir, String(f))).size; } catch {}
              });
              const sizeStr = sizeBytes < 1024 ? `${sizeBytes} B`
                : sizeBytes < 1048576 ? `${(sizeBytes / 1024).toFixed(1)} KB`
                : `${(sizeBytes / 1048576).toFixed(1)} MB`;
              return `📁 **${d}/**: ${fileCount} files (${sizeStr})`;
            } catch {
              return `📁 **${d}/**: ?`;
            }
          });
          return `**Workspace Usage:**\n\n${lines.join('\n')}\n\nTotal: ${totalFiles} files`;
        } catch {
          return 'Could not read workspace.';
        }
      }

      case '/cover': {
        if (!args) return '🎨 Generate a book cover image.\n\nUsage:\n`/cover [description]` — Generate a cover from a description\n\nExample:\n`/cover A dark fantasy novel about a shadow mage in a crumbling kingdom`\n`/cover romance contemporary, small town, bakery, cozy vibes`';
        if (!this.imageGen) return 'Image generation service not available.';
        try {
          const providers = await this.imageGen.getAvailableProviders();
          if (providers.length === 0) return '⚠️ No image generation API keys configured. Add a Together AI or OpenAI key in Settings.';

          const result = await this.imageGen.generateBookCover({
            title: 'Book Cover',
            author: 'Author',
            genre: args.split(',')[0]?.trim() || 'fiction',
            description: args,
          });

          if (result.success) {
            return `🎨 **Book cover generated!**\n\n📄 File: \`${result.filename}\`\n🖼️ Size: ${result.width}×${result.height}\n🤖 Provider: ${result.provider}\n\nView in the **Library** panel or download from project files.`;
          }
          return `⚠️ ${result.error}`;
        } catch (err) {
          return `❌ Cover generation failed: ${String(err)}`;
        }
      }

      default:
        return `Unknown command: \`${cmd}\`. Type \`/help\` for available commands.`;
    }
  }

  isTelegramConnected(): boolean {
    return this.telegram !== undefined;
  }

  /**
   * Broadcast a message to all Telegram users.
   * Used by routes for conductor status updates.
   */
  broadcastTelegram(message: string): void {
    if (this.telegram) {
      this.telegram.broadcastToAllowed(message);
    }
  }

  async connectTelegram(): Promise<{ error?: string }> {
    if (this.telegram) {
      this.telegram.disconnect();
      this.telegram = undefined;
    }

    const token = await this.vault.get('telegram_bot_token');
    if (!token) {
      return { error: 'No telegram_bot_token in vault. Save your bot token first.' };
    }

    this.config.set('bridges.telegram.enabled', true);

    try {
      this.telegram = new TelegramBridge(token, {
        allowedUsers: this.config.get('bridges.telegram.allowedUsers', []),
        pairingEnabled: this.config.get('bridges.telegram.pairingEnabled', true),
      });
      this.telegram.onMessage((content, channel, respond) =>
        this.handleMessage(content, channel, respond)
      );
      this.telegram.setCommandHandlers(this.buildTelegramCommandHandlers());
      await this.telegram.connect();
      this.audit.log('bridge', 'telegram_connected', {});
      this.activityLog.log({
        type: 'system',
        source: 'internal',
        message: 'Telegram bridge connected',
      });
      logger.info('  ✓ Telegram bridge connected (via dashboard, command center mode)');
      return {};
    } catch (error) {
      this.telegram = undefined;
      return { error: String(error) };
    }
  }

  disconnectTelegram(): void {
    if (this.telegram) {
      this.telegram.disconnect();
      this.telegram = undefined;
      this.config.set('bridges.telegram.enabled', false);
      this.audit.log('bridge', 'telegram_disconnected', {});
      logger.warn('  ⚠ Telegram bridge disconnected (via dashboard)');
    }
  }

  updateTelegramUsers(users: string[]): void {
    if (this.telegram) {
      this.telegram.updateAllowedUsers(users);
    }
  }

  /**
   * Build command handlers for the Telegram bridge.
   * These let Telegram commands directly interact with GoalEngine,
   * file system, and AI — without dumping long responses into chat.
   */
  private buildTelegramCommandHandlers() {
    const gateway = this;
    const workspaceDir = WORKSPACE_DIR;

    return {
      /**
       * Create a project using DYNAMIC AI PLANNING.
       * The AI figures out the steps, skills, and tools needed.
       * Falls back to template-based planning if AI planning fails.
       */
      async createProject(title: string, description: string, config?: Record<string, any>): Promise<{ id: string; steps: number }> {
        // Detect novel-pipeline requests and use the dedicated pipeline builder
        const inferredType = gateway.projectEngine.inferProjectType(description);
        let project;

        if (inferredType === 'novel-pipeline') {
          project = gateway.projectEngine.createNovelPipeline(title, description, config);
        } else {
          const skillCatalog = gateway.skills.getSkillCatalog();
          const authorOSTools = gateway.authorOS?.getAvailableTools() || [];
          project = await gateway.projectEngine.planProject(
            title,
            description,
            skillCatalog,
            authorOSTools,
            config
          );
        }

        // Log project creation to activity
        gateway.activityLog.log({
          type: 'project_created',
          source: 'telegram',
          goalId: project.id,
          message: `Project created: "${title}" (${project.steps.length} steps, ${project.context?.planning || 'template'} planning)`,
          metadata: { totalSteps: project.steps.length },
        });

        return { id: project.id, steps: project.steps.length };
      },

      /**
       * Start (or continue) a project and run ONE step through the AI.
       * Returns a short summary for Telegram + accurate word count.
       */
      async startAndRunProject(projectId: string): Promise<
        { completed: string; response: string; wordCount: number; nextStep?: string } | { error: string }
      > {
        const project = gateway.projectEngine.getProject(projectId);
        if (!project) return { error: 'Project not found' };

        let activeStep: any = project.steps.find(s => s.status === 'active');
        if (!activeStep) {
          activeStep = gateway.projectEngine.startProject(projectId) ?? undefined;
        }
        if (!activeStep) return { error: 'No pending steps' };

        // Log step start
        gateway.activityLog.log({
          type: 'step_started',
          source: 'telegram',
          goalId: projectId,
          stepLabel: activeStep.label,
          message: `Step started: ${activeStep.label}`,
        });

        // Build project context and inject the relevant skill if specified
        let projectContext = await gateway.projectEngine.buildProjectContext(project, activeStep);

        // If the step references a specific skill, inject its full content
        const stepSkill = (activeStep as any).skill;
        if (stepSkill) {
          const skillData = gateway.skills.getSkillByName(stepSkill);
          if (skillData) {
            projectContext += `\n\n# Skill: ${skillData.name}\n\n${skillData.content}`;
          }
        }

        // Build user message with uploaded content injected directly
        // For large documents (15K+ words): read from disk with smart truncation
        let stepUserMessage = activeStep!.prompt;
        const uploads = project.context?.uploads || [];
        const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount?.toLocaleString() || '?'} words)`).join(', ');

        if (project.context?.documentLibraryFile) {
          // Large document: read from disk with smart excerpt
          let excerpt = '';
          try {
            if (existsSync(project.context.documentLibraryFile)) {
              const fullText = await fs.readFile(project.context.documentLibraryFile, 'utf-8');
              const MAX_CHARS = 25000;
              if (fullText.length <= MAX_CHARS) {
                excerpt = fullText;
              } else {
                const head = fullText.substring(0, 20000);
                const tail = fullText.substring(fullText.length - 5000);
                const omitted = Math.round((fullText.length - 25000) / 5);
                excerpt = `${head}\n\n[... ⚠️ ~${omitted.toLocaleString()} words omitted. Full document in workspace/documents/. ...]\n\n${tail}`;
              }
            } else {
              excerpt = '[Document file not found — it may have been moved or deleted]';
            }
          } catch (e) {
            excerpt = '[Error reading document: ' + String(e) + ']';
          }
          stepUserMessage = `## Manuscript to Work With\n\nUploaded files: ${fileList}\n\n${excerpt}\n\n---\n\n## Your Task\n\n${stepUserMessage}`;
        } else if (project.context?.uploadedContent) {
          // Small document: use inline content
          const uploaded = String(project.context.uploadedContent).substring(0, 30000);
          stepUserMessage = `## Manuscript to Work With\n\nUploaded files: ${fileList}\n\n${uploaded}\n\n---\n\n## Your Task\n\n${stepUserMessage}`;
        }

        let aiResponse = '';
        const projectProvider = (project as any).preferredProvider || undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            gateway.handleMessage(
              stepUserMessage,
              'goal-engine',
              (response) => {
                aiResponse = response;
                resolve();
              },
              projectContext,
              (activeStep as any).taskType || undefined,
              projectProvider
            ).catch(reject);
          });

          // Retry once with 'general' routing if response is too short
          if (!aiResponse || aiResponse.length < 50) {
            logger.warn(`  ↻ Step "${activeStep.label}" got short response — retrying with general routing...`);
            aiResponse = '';
            await new Promise<void>((resolve, reject) => {
              gateway.handleMessage(
                stepUserMessage,
                'goal-engine',
                (response) => { aiResponse = response; resolve(); },
                projectContext,
                'general',
                projectProvider
              ).catch(reject);
            });
          }
        } catch (err) {
          gateway.projectEngine.failStep(projectId, activeStep.id, String(err));
          gateway.activityLog.log({
            type: 'step_failed',
            source: 'telegram',
            goalId: projectId,
            stepLabel: activeStep.label,
            message: `Step failed: ${activeStep.label} — ${String(err)}`,
          });
          return { error: `AI error: ${String(err)}` };
        }

        // Word count continuation for novel-pipeline writing steps
        const wcTarget = (activeStep as any).wordCountTarget;
        if (wcTarget && wcTarget > 0) {
          let wc = aiResponse.split(/\s+/).length;
          let continuations = 0;
          while (wc < wcTarget && continuations < 3) {
            continuations++;
            const remaining = wcTarget - wc;
            logger.debug(`  [novel-pipeline] Chapter word count: ${wc}/${wcTarget} — requesting continuation #${continuations} (~${remaining} more words)`);
            let contResponse = '';
            try {
              await new Promise<void>((resolve, reject) => {
                gateway.handleMessage(
                  `Continue writing from where you left off. You wrote ${wc} words so far but the target is ${wcTarget}. Write at least ${remaining} more words of prose narrative, continuing the story seamlessly. Do NOT repeat what was already written. Do NOT summarize. Continue the actual prose.`,
                  'goal-engine',
                  (response) => { contResponse = response; resolve(); },
                  projectContext
                ).catch(reject);
              });
              if (contResponse.length > 100) {
                aiResponse = aiResponse + '\n\n' + contResponse;
                wc = aiResponse.split(/\s+/).length;
              } else {
                break; // Too short, stop trying
              }
            } catch {
              break; // Continuation failed, keep what we have
            }
          }
          if (continuations > 0) {
            logger.debug(`  [novel-pipeline] Final word count after ${continuations} continuation(s): ${aiResponse.split(/\s+/).length}`);
          }
        }

        // Calculate word count from FULL response (not truncated)
        const wordCount = aiResponse.split(/\s+/).length;

        // Save full output to workspace file
        const projectDir = projectOutputDir(workspaceDir, project);
        let savedFileName = '';
        try {
          await fs.mkdir(projectDir, { recursive: true });
          savedFileName = stepOutputFileName(activeStep);
          await fs.writeFile(
            join(projectDir, savedFileName),
            `# ${activeStep.label}\n\n${aiResponse}`,
            'utf-8'
          );

          gateway.activityLog.log({
            type: 'file_saved',
            source: 'internal',
            goalId: projectId,
            message: `Saved: ${savedFileName} (~${wordCount.toLocaleString()} words)`,
            metadata: { fileName: savedFileName, wordCount },
          });
        } catch (fileErr) {
          logger.error('Failed to save project step output:', fileErr);
        }

        // Complete the step and advance
        const nextStep = gateway.projectEngine.completeStep(projectId, activeStep.id, aiResponse);

        // After completeStep — generate context for writing and bible steps
        try {
          const stepLabel = (activeStep as any).label || '';
          const isWritingStep = stepLabel.toLowerCase().includes('chapter') ||
            stepLabel.toLowerCase().includes('write') ||
            (activeStep as any).phase === 'writing';
          const isBibleStep = project.type === 'book-bible' ||
            stepLabel.toLowerCase().includes('bible') ||
            stepLabel.toLowerCase().includes('character') ||
            stepLabel.toLowerCase().includes('world');

          if ((isWritingStep || isBibleStep) && aiResponse.length > 200) {
            const chapterNum = project.steps.filter((s: any) =>
              s.status === 'completed' && s.id !== activeStep.id
            ).length + 1;

            const aiCompleteFn = (req: any) => gateway.aiRouter.complete(req);
            const aiSelectFn = (taskType: string) => gateway.aiRouter.selectProvider(taskType);

            // Fire and forget — don't block step completion
            gateway.contextEngine.generateSummary(
              projectId, activeStep.id, stepLabel, chapterNum, aiResponse,
              aiCompleteFn, aiSelectFn
            ).catch(err => logger.error('[context-engine] Summary error:', err.message));

            gateway.contextEngine.extractEntities(
              projectId, activeStep.id, aiResponse,
              aiCompleteFn, aiSelectFn
            ).catch(err => logger.error('[context-engine] Entity extraction error:', err.message));
          }
        } catch (contextErr) {
          logger.error('[context-engine] Hook error:', contextErr);
        }

        // Track words for Morning Briefing
        gateway.heartbeat.addWords(wordCount);

        gateway.activityLog.log({
          type: 'step_completed',
          source: 'telegram',
          goalId: projectId,
          stepLabel: activeStep.label,
          message: `Step completed: ${activeStep.label} (~${wordCount.toLocaleString()} words)`,
          metadata: { wordCount, fileName: savedFileName },
        });

        // ── Manuscript Assembly: combine chapter files after assembly step ──
        if ((activeStep as any).phase === 'assembly' && project.type === 'novel-pipeline') {
          try {
            const { generateDocxBuffer } = await import('./services/docx-export.js');

            // Find writing-phase steps that completed, sorted by chapter number
            const writingSteps = project.steps
              .filter((s: any) => s.phase === 'writing' && s.status === 'completed')
              .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

            const chapterContents: string[] = [];
            for (const ws of writingSteps) {
              const fileName = stepOutputFileName(ws);
              const newPath = join(projectDir, fileName);
              const fullPath = existsSync(newPath) ? newPath : join(legacyProjectOutputDir(workspaceDir, project), fileName);
              try {
                const raw = await fs.readFile(fullPath, 'utf-8');
                // Strip the "# Step Label" header that was prepended during save
                const content = raw.replace(/^# .+\n\n/, '');
                chapterContents.push(`## Chapter ${(ws as any).chapterNumber || chapterContents.length + 1}\n\n${content}`);
              } catch { /* skip missing files */ }
            }

            if (chapterContents.length > 0) {
              const manuscriptMd = `# ${project.title}\n\n` + chapterContents.join('\n\n---\n\n');
              await fs.writeFile(join(projectDir, 'manuscript.md'), manuscriptMd, 'utf-8');

              // Generate DOCX version
              const docxBuffer = await generateDocxBuffer({
                title: project.title,
                author: 'AuthorAgent',
                content: manuscriptMd,
              });
              await fs.writeFile(join(projectDir, 'manuscript.docx'), docxBuffer);

              const totalWords = manuscriptMd.split(/\s+/).length;
              logger.info(`  [assembly] Manuscript assembled: ${chapterContents.length} chapters, ~${totalWords.toLocaleString()} words`);

              gateway.activityLog.log({
                type: 'file_saved',
                source: 'internal',
                goalId: projectId,
                message: `Manuscript assembled: manuscript.md + manuscript.docx (${chapterContents.length} chapters, ~${totalWords.toLocaleString()} words)`,
                metadata: { fileName: 'manuscript.md', wordCount: totalWords, chapters: chapterContents.length },
              });
            }
          } catch (assemblyErr) {
            logger.error('  [assembly] Manuscript assembly failed:', assemblyErr);
          }
        }

        return {
          completed: activeStep.label,
          response: aiResponse.length > 200
            ? aiResponse.substring(0, 200).replace(/\n/g, ' ').trim() + '...'
            : aiResponse.replace(/\n/g, ' ').trim(),
          wordCount,
          nextStep: nextStep?.label,
        };
      },

      /**
       * AUTONOMOUS AUTO-RUN: Execute ALL remaining steps of a project in sequence.
       * Sends Telegram status updates via the callback after each step.
       * Now includes accurate word counts in status messages.
       */
      async autoRunProject(projectId: string, statusCallback: (msg: string) => Promise<void>): Promise<void> {
        const project = gateway.projectEngine.getProject(projectId);
        if (!project) {
          await statusCallback('⚠️ Project not found');
          return;
        }

        if (project.status === 'paused') {
          project.status = 'active';
          const firstPending = project.steps.find(s => s.status === 'pending');
          if (firstPending) firstPending.status = 'active';
        }

        let stepNumber = project.steps.filter(s => s.status === 'completed').length + 1;
        const totalSteps = project.steps.length;

        while (true) {
          // Check BOTH the bridge flag AND the project's actual status
          const currentProject = gateway.projectEngine.getProject(projectId);
          if (gateway.telegram?.pauseRequested || currentProject?.status === 'paused') {
            gateway.telegram && (gateway.telegram.pauseRequested = false);
            if (currentProject?.status !== 'paused') gateway.projectEngine.pauseProject(projectId);
            await statusCallback(`⏸ Paused at step ${stepNumber}/${totalSteps}. Say "continue" to resume.`);
            return;
          }

          const result = await this.startAndRunProject(projectId);

          // Re-check pause AFTER step completes (catches /stop sent during long AI call)
          const afterStepProject = gateway.projectEngine.getProject(projectId);
          if (gateway.telegram?.pauseRequested || afterStepProject?.status === 'paused') {
            gateway.telegram && (gateway.telegram.pauseRequested = false);
            if (afterStepProject?.status !== 'paused') gateway.projectEngine.pauseProject(projectId);
            await statusCallback(`⏸ Paused at step ${stepNumber}/${totalSteps}. Say "continue" to resume.`);
            return;
          }

          if ('error' in result) {
            await statusCallback(`⚠️ Step ${stepNumber}/${totalSteps} failed: ${result.error}`);
            return;
          }

          if (result.nextStep) {
            await statusCallback(
              `✅ ${stepNumber}/${totalSteps}: ${result.completed} (~${result.wordCount.toLocaleString()} words)\n` +
              `⏭ Next: ${result.nextStep}...`
            );
            stepNumber++;
          } else {
            await statusCallback(
              `🎉 All ${totalSteps} steps complete!\n` +
              `📁 Files saved to workspace/projects/\n` +
              `Use /files to see what was created.`
            );
            return;
          }
        }
      },

      listProjects() {
        return gateway.projectEngine.listProjects().map(g => ({
          id: g.id,
          title: g.title,
          status: g.status,
          progress: `${g.progress}%`,
          progressNum: g.progress,
          stepsRemaining: g.steps.filter(s => s.status === 'pending' || s.status === 'active').length,
          type: g.type,
        }));
      },

      async saveToFile(filename: string, content: string) {
        // User-supplied filename (Telegram command) — constrain to workspace.
        const filePath = resolveWithin(workspaceDir, filename);
        await fs.mkdir(join(filePath, '..'), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
      },

      async handleMessage(content: string, channel: string, respond: (text: string) => void) {
        await gateway.handleMessage(content, channel, respond);
      },

      async research(query: string): Promise<{ results: string; error?: string }> {
        try {
          // Step 1: Search the web for real results
          const researchGate = gateway.getServices().research;
          let webContext = '';
          let sourceList = '';

          if (researchGate) {
            const searchResults = await researchGate.search(query, 5);

            if (searchResults.results.length > 0) {
              // Fetch and extract text from top 3 results
              const fetchPromises = searchResults.results.slice(0, 3).map(async (r) => {
                const extracted = await researchGate.fetchAndExtract(r.url);
                return { ...r, fullText: extracted.ok ? extracted.text : undefined };
              });
              const fetched = await Promise.all(fetchPromises);

              for (const r of fetched) {
                sourceList += `- ${r.title}: ${r.url}\n`;
                if (r.fullText) {
                  webContext += `\n## Source: ${r.title}\nURL: ${r.url}\n\n${r.fullText.substring(0, 8000)}\n\n`;
                } else if (r.snippet) {
                  webContext += `\n## Source: ${r.title}\nURL: ${r.url}\n${r.snippet}\n\n`;
                }
              }
            }
          }

          // Step 2: Pass real web content to AI for synthesis
          const researchPrompt = webContext
            ? `Here is real research data from the web:\n\n${webContext}\n\nNow synthesize this into a useful, well-organized research summary for an author researching: ${query}\n\nInclude source URLs for key facts.`
            : `Research the following topic thoroughly. Provide factual, detailed information useful for a fiction or nonfiction author: ${query}`;

          let aiResponse = '';
          await new Promise<void>((resolve, reject) => {
            gateway.handleMessage(
              researchPrompt,
              'research',
              (response) => {
                aiResponse = response;
                resolve();
              },
              '\n# Research Mode\nYou are in research mode. Provide factual, well-organized research results. Focus on information useful for writing. Cite sources when available.'
            ).catch(reject);
          });

          // Add source list if we had web results
          if (sourceList) {
            aiResponse += `\n\n---\n**Sources:**\n${sourceList}`;
          }

          const filename = `research-${query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`;
          const filePath = join(workspaceDir, 'research', filename);
          await fs.mkdir(join(workspaceDir, 'research'), { recursive: true });
          await fs.writeFile(filePath, `# Research: ${query}\n\n${aiResponse}`, 'utf-8');

          gateway.activityLog.log({
            type: 'file_saved',
            source: 'telegram',
            message: `Research saved: ${filename}`,
            metadata: { fileName: filename, wordCount: aiResponse.split(/\s+/).length },
          });

          const shortResult = aiResponse.length > 2000
            ? aiResponse.substring(0, 2000) + `\n\n📄 Full results saved to research/${filename}`
            : aiResponse + `\n\n📄 Saved to research/${filename}`;

          return { results: shortResult };
        } catch (err) {
          return { results: '', error: String(err) };
        }
      },

      async listFiles(subdir?: string): Promise<string[]> {
        // User-supplied subdir (Telegram /files) — constrain to workspace.
        // On escape, fall back to the default projects dir instead of throwing.
        let targetDir: string;
        try {
          targetDir = subdir
            ? resolveWithin(workspaceDir, subdir)
            : join(workspaceDir, 'projects');
        } catch {
          targetDir = join(workspaceDir, 'projects');
        }

        const files: string[] = [];

        async function listDir(dir: string, prefix = '') {
          try {
            if (!existsSync(dir)) return;
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.')) continue;
              if (entry.isDirectory()) {
                files.push(`📁 ${prefix}${entry.name}/`);
                try {
                  const subEntries = await fs.readdir(join(dir, entry.name));
                  for (const sub of subEntries) {
                    if (!sub.startsWith('.')) {
                      files.push(`  📄 ${prefix}${entry.name}/${sub}`);
                    }
                  }
                } catch (err) {
                  logger.debug(`file listing: could not read subdir ${join(dir, entry.name)}`, err);
                }
              } else {
                files.push(`📄 ${prefix}${entry.name}`);
              }
            }
          } catch (err) {
            logger.debug(`file listing: could not read dir ${dir}`, err);
          }
        }

        await listDir(targetDir);
        return files;
      },

      async readFile(filename: string): Promise<{ content: string; error?: string }> {
        const cleanName = filename.replace(/^[📁📄\s]+/, '').trim();
        // User-supplied filename (Telegram /read) — constrain to workspace.
        // A traversal attempt is treated as "not found" (no error leak).
        let filePath: string;
        try {
          filePath = resolveWithin(workspaceDir, cleanName);
          if (!existsSync(filePath)) {
            filePath = resolveWithin(workspaceDir, 'projects', cleanName);
          }
        } catch {
          return { content: '', error: `File not found: ${filename}` };
        }
        if (!existsSync(filePath)) {
          return { content: '', error: `File not found: ${filename}` };
        }
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          return { content };
        } catch (err) {
          return { content: '', error: String(err) };
        }
      },
    };
  }

  async start(): Promise<void> {
    await this.initialize();
    const port = this.config.get('server.port', 3847);
    const host = this.config.get('server.host', '127.0.0.1');
    // Without this handler, a bind failure (port in use, or — since host is
    // config-driven and can be set to a Tailscale/LAN IP — that interface
    // dropping or not being up yet at boot) throws as an unhandled 'error'
    // event and crashes the whole process with no diagnostic in the log
    // beyond a bare non-zero exit code.
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      logger.error(`  ✗ Server failed to bind ${host}:${port}: ${err.code || err.message}`);
      if (err.code === 'EADDRNOTAVAIL') {
        logger.error(`    Address ${host} is not currently assigned to any network interface on this machine.`);
      } else if (err.code === 'EADDRINUSE') {
        logger.error(`    Port ${port} is already in use — another AuthorAgent instance (or something else) is bound to it.`);
      }
      process.exit(1);
    });
    this.server.listen(port, host, () => {
      // Bind address is config-driven (server.host in config/user.json).
      // Defaults to localhost-only; see getAllowedOrigins() for the matching
      // CORS/WebSocket origin allowlist when host is set to something else.
    });
  }

  async shutdown(): Promise<void> {
    logger.info('\n  Shutting down AuthorAgent...');
    this.heartbeat?.stop();
    this.telegram?.disconnect();
    this.discord?.disconnect();
    await this.activityLog?.log({
      type: 'system',
      source: 'internal',
      message: 'AuthorAgent shutting down',
    });
    await this.audit?.log('system', 'shutdown', {});
    this.server.close();
    logger.info('  ✍️  AuthorAgent stopped. Happy writing!\n');
  }
}

// ── Start ──
const gateway = new AuthorAgentGateway();

process.on('SIGINT', async () => {
  await gateway.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await gateway.shutdown();
  process.exit(0);
});

gateway.start().catch((error) => {
  logger.error('Failed to start AuthorAgent:', error);
  process.exit(1);
});

export { AuthorAgentGateway };

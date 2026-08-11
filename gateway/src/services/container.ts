/**
 * ServiceContainer — typed holder for the ~50 long-lived services the gateway
 * constructs during initialize().
 *
 * Extracted from gateway/src/index.ts as part of the Phase 2 god-file split
 * (Phase 2 final, step 1). Behavior-preserving: this file ONLY holds the
 * service field declarations and the getServices() projection that the former
 * AuthorAgentGateway inlined. Construction ORDER and all cross-service wiring
 * (setMessageHandler, setStepServices, setContextEngine, setGate, setAI,
 * bridges, hooks) stay in initialize() in index.ts, because those closures
 * reference gateway-only members (io, telegram, handleMessage, etc.) and the
 * services depend on each other in a fixed order.
 *
 * The gateway keeps a single ServiceContainer instance, assigns each service
 * into it as it is built (identical timing to before), and its
 * getServices()/getProjectEngine() accessors delegate here.
 */

import { ConfigService } from './config.js';
import { MemoryService } from './memory.js';
import { SoulService } from './soul.js';
import { HeartbeatService } from './heartbeat.js';
import { CostTracker } from './costs.js';
import { ResearchGate } from './research.js';
import { ActivityLog } from './activity-log.js';
import { AIRouter } from '../ai/router.js';
import { Vault } from '../security/vault.js';
import { PermissionManager } from '../security/permissions.js';
import { AuditLog } from '../security/audit.js';
import { SandboxGuard } from '../security/sandbox.js';
import { InjectionDetector } from '../security/injection.js';
import { SkillLoader } from '../skills/loader.js';
import { AuthorOSService } from './author-os.js';
import { TTSService } from './tts.js';
import { ImageGenService } from './image-gen.js';
import { ProjectEngine } from './projects.js';
import { PersonaService } from './personas.js';
import { ContextEngine } from './context-engine.js';
import { MemorySearchService } from './memory-search.js';
import { MemoryTierService } from './memory-tier.js';
import { SleepConsolidationService } from './sleep-consolidation.js';
import { UserModelService } from './user-model.js';
import { CronSchedulerService } from './cron-scheduler.js';
import { AutoSkillService } from './auto-skill.js';
import { SkillCuratorService } from './skill-curator.js';
import { ReaderFeedbackService } from './reader-feedback.js';
import { WritingJudgeService } from './writing-judge.js';
import { ProseEvolverService } from './prose-evolver.js';
import { ReaderPanelService } from './reader-panel.js';
import { ResearchLookupService } from './research-lookup.js';
import { VideoResearchService } from './video-research.js';
import { StoryStructureService } from './story-structures.js';
import { PlotPromisesService } from './plot-promises.js';
import { CharacterVoicesService } from './character-voices.js';
import { WebsiteSiteService } from './website-sites.js';
import { BlogPostDrafterService } from './blog-post-drafter.js';
import { WebsiteDeployService } from './website-deploy.js';
import { LessonStore } from './lessons.js';
import { PreferenceStore } from './preferences.js';
import { OrchestratorService } from './orchestrator.js';
import { KDPExporter } from './kdp-exporter.js';
import { BetaReaderService } from './beta-reader.js';
import { DialogueAuditor } from './dialogue-auditor.js';
import { ManuscriptHubService } from './manuscript-hub.js';
import { CoverTypographyService } from './cover-typography.js';
import { ExternalToolsService } from './external-tools.js';
import { TrackChangesService } from './track-changes.js';
import { GoalsService } from './goals.js';
import { SeriesBibleService } from './series-bible.js';
import { CraftCriticService } from './craft-critic.js';
import { AudiobookPrepService } from './audiobook-prep.js';
import { StyleCloneService } from './style-clone.js';
import { ContradictionDetector } from './contradiction-detector.js';
import { CharacterAgentService } from './character-agent.js';
import { RevisionOrchestrator } from './revision-orchestrator.js';
import { LearningService } from './learning.js';
import { ConfirmationGateService } from './confirmation-gate.js';
import { DisclosuresService } from './disclosures.js';
import { LaunchOrchestratorService } from './launch-orchestrator.js';
import { AMSAdsService } from './ams-ads.js';
import { BookBubSubmitterService } from './bookbub-submitter.js';
import { ReleaseCalendarService } from './release-calendar.js';
import { ReaderIntelService } from './reader-intel.js';
import { TranslationPipelineService } from './translation-pipeline.js';
import { WebsiteBuilderService } from './website-builder.js';
import { WorkspaceGitSyncService } from './workspace-git-sync.js';

/**
 * Shape of the object the gateway's getServices() returns to the API routes.
 * Kept identical (same keys, same order) to the former inline literal.
 */
export interface GatewayServices {
  config: ConfigService;
  memory: MemoryService;
  soul: SoulService;
  heartbeat: HeartbeatService;
  costs: CostTracker;
  research: ResearchGate;
  aiRouter: AIRouter;
  vault: Vault;
  permissions: PermissionManager;
  audit: AuditLog;
  sandbox: SandboxGuard;
  skills: SkillLoader;
  authorOS: AuthorOSService;
  tts: TTSService;
  personas: PersonaService;
  contextEngine: ContextEngine;
  memorySearch: MemorySearchService;
  memoryTier: MemoryTierService;
  sleepConsolidation: SleepConsolidationService;
  userModel: UserModelService;
  cronScheduler: CronSchedulerService;
  autoSkill: AutoSkillService;
  skillCurator: SkillCuratorService;
  readerFeedback: ReaderFeedbackService;
  writingJudge: WritingJudgeService;
  proseEvolver: ProseEvolverService;
  readerPanel: ReaderPanelService;
  researchLookup: ResearchLookupService;
  videoResearch: VideoResearchService;
  storyStructures: StoryStructureService;
  plotPromises: PlotPromisesService;
  characterVoices: CharacterVoicesService;
  websiteSites: WebsiteSiteService;
  blogPostDrafter: BlogPostDrafterService;
  websiteDeploy: WebsiteDeployService;
  lessons: LessonStore;
  preferences: PreferenceStore;
  orchestrator: OrchestratorService;
  kdpExporter: KDPExporter;
  betaReader: BetaReaderService;
  dialogueAuditor: DialogueAuditor;
  manuscriptHub: ManuscriptHubService;
  coverTypography: CoverTypographyService;
  externalTools: ExternalToolsService;
  trackChanges: TrackChangesService;
  goals: GoalsService;
  seriesBible: SeriesBibleService;
  craftCritic: CraftCriticService;
  audiobookPrep: AudiobookPrepService;
  styleClone: StyleCloneService;
  contradictionDetector: ContradictionDetector;
  characterAgent: CharacterAgentService;
  revisionOrchestrator: RevisionOrchestrator;
  learning: LearningService;
  confirmationGate: ConfirmationGateService;
  disclosures: DisclosuresService;
  launchOrchestrator: LaunchOrchestratorService;
  amsAds: AMSAdsService;
  bookbub: BookBubSubmitterService;
  releaseCalendar: ReleaseCalendarService;
  readerIntel: ReaderIntelService;
  translationPipeline: TranslationPipelineService;
  websiteBuilder: WebsiteBuilderService;
  workspaceGitSync: WorkspaceGitSyncService;
}

/**
 * Holds every long-lived service. Fields use definite-assignment (`!`) exactly
 * like the former gateway private fields — they are assigned during the
 * phased initialize() in index.ts. Nothing here constructs or wires services;
 * ordering/wiring stays in the gateway so the interdependent, gateway-aware
 * closures keep working unchanged.
 */
export class ServiceContainer {
  // Core services
  config!: ConfigService;
  memory!: MemoryService;
  soul!: SoulService;
  heartbeat!: HeartbeatService;
  costs!: CostTracker;
  research!: ResearchGate;
  activityLog!: ActivityLog;
  aiRouter!: AIRouter;

  // Security services
  vault!: Vault;
  permissions!: PermissionManager;
  audit!: AuditLog;
  sandbox!: SandboxGuard;
  injectionDetector!: InjectionDetector;

  // Skills, goals & bridges
  skills!: SkillLoader;
  authorOS!: AuthorOSService;
  tts!: TTSService;
  imageGen!: ImageGenService;
  personas!: PersonaService;
  projectEngine!: ProjectEngine;
  contextEngine!: ContextEngine;
  memorySearch!: MemorySearchService;
  memoryTier!: MemoryTierService;
  sleepConsolidation!: SleepConsolidationService;
  userModel!: UserModelService;
  cronScheduler!: CronSchedulerService;
  autoSkill!: AutoSkillService;
  skillCurator!: SkillCuratorService;
  readerFeedback!: ReaderFeedbackService;
  writingJudge!: WritingJudgeService;
  proseEvolver!: ProseEvolverService;
  readerPanel!: ReaderPanelService;
  researchLookup!: ResearchLookupService;
  videoResearch!: VideoResearchService;
  storyStructures!: StoryStructureService;
  plotPromises!: PlotPromisesService;
  characterVoices!: CharacterVoicesService;
  websiteSites!: WebsiteSiteService;
  blogPostDrafter!: BlogPostDrafterService;
  websiteDeploy!: WebsiteDeployService;
  lessons!: LessonStore;
  preferences!: PreferenceStore;
  orchestrator!: OrchestratorService;
  kdpExporter!: KDPExporter;
  betaReader!: BetaReaderService;
  dialogueAuditor!: DialogueAuditor;
  manuscriptHub!: ManuscriptHubService;
  coverTypography!: CoverTypographyService;
  externalTools!: ExternalToolsService;
  trackChanges!: TrackChangesService;
  goalsService!: GoalsService;
  seriesBible!: SeriesBibleService;
  craftCritic!: CraftCriticService;
  audiobookPrep!: AudiobookPrepService;
  styleClone!: StyleCloneService;
  contradictionDetector!: ContradictionDetector;
  characterAgent!: CharacterAgentService;
  revisionOrchestrator!: RevisionOrchestrator;
  learning!: LearningService;
  // Wave 3 — autonomous career agent with safety rails
  confirmationGate!: ConfirmationGateService;
  disclosures!: DisclosuresService;
  launchOrchestrator!: LaunchOrchestratorService;
  amsAds!: AMSAdsService;
  bookbub!: BookBubSubmitterService;
  releaseCalendar!: ReleaseCalendarService;
  readerIntel!: ReaderIntelService;
  translationPipeline!: TranslationPipelineService;
  websiteBuilder!: WebsiteBuilderService;
  workspaceGitSync!: WorkspaceGitSyncService;

  /**
   * The object exposed to API routes. Identical keys/order to the former
   * inline getServices() literal in index.ts.
   */
  getServices(): GatewayServices {
    return {
      config: this.config,
      memory: this.memory,
      soul: this.soul,
      heartbeat: this.heartbeat,
      costs: this.costs,
      research: this.research,
      aiRouter: this.aiRouter,
      vault: this.vault,
      permissions: this.permissions,
      audit: this.audit,
      sandbox: this.sandbox,
      skills: this.skills,
      authorOS: this.authorOS,
      tts: this.tts,
      personas: this.personas,
      contextEngine: this.contextEngine,
      memorySearch: this.memorySearch,
      memoryTier: this.memoryTier,
      sleepConsolidation: this.sleepConsolidation,
      userModel: this.userModel,
      cronScheduler: this.cronScheduler,
      autoSkill: this.autoSkill,
      skillCurator: this.skillCurator,
      readerFeedback: this.readerFeedback,
      writingJudge: this.writingJudge,
      proseEvolver: this.proseEvolver,
      readerPanel: this.readerPanel,
      researchLookup: this.researchLookup,
      videoResearch: this.videoResearch,
      storyStructures: this.storyStructures,
      plotPromises: this.plotPromises,
      characterVoices: this.characterVoices,
      websiteSites: this.websiteSites,
      blogPostDrafter: this.blogPostDrafter,
      websiteDeploy: this.websiteDeploy,
      lessons: this.lessons,
      preferences: this.preferences,
      orchestrator: this.orchestrator,
      kdpExporter: this.kdpExporter,
      betaReader: this.betaReader,
      dialogueAuditor: this.dialogueAuditor,
      manuscriptHub: this.manuscriptHub,
      coverTypography: this.coverTypography,
      externalTools: this.externalTools,
      trackChanges: this.trackChanges,
      goals: this.goalsService,
      seriesBible: this.seriesBible,
      craftCritic: this.craftCritic,
      audiobookPrep: this.audiobookPrep,
      styleClone: this.styleClone,
      contradictionDetector: this.contradictionDetector,
      characterAgent: this.characterAgent,
      revisionOrchestrator: this.revisionOrchestrator,
      learning: this.learning,
      confirmationGate: this.confirmationGate,
      disclosures: this.disclosures,
      launchOrchestrator: this.launchOrchestrator,
      amsAds: this.amsAds,
      bookbub: this.bookbub,
      releaseCalendar: this.releaseCalendar,
      readerIntel: this.readerIntel,
      translationPipeline: this.translationPipeline,
      websiteBuilder: this.websiteBuilder,
      workspaceGitSync: this.workspaceGitSync,
    };
  }
}

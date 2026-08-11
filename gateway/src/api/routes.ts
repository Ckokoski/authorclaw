/**
 * AuthorAgent API Routes
 * REST API for the dashboard and external integrations
 *
 * This file used to be a ~5,500-line monolith registering all endpoints
 * directly. It has been split into per-domain modules under
 * gateway/src/api/routes/ (Phase 2 god-file split). This file is now just
 * a thin orchestrator: it builds the shared ApiContext once and calls every
 * registerXRoutes(ctx) in the exact order the endpoints were originally
 * registered, so Express route-matching precedence is unchanged.
 *
 * The public signature — createAPIRoutes(app, gateway, rootDir, workspaceDir) —
 * grew a `workspaceDir` param (ALP-1614) so per-domain route modules can
 * write project/step output under the resolved per-book workspace instead of
 * always `<rootDir>/workspace`.
 */

// NOTE: All endpoints are currently unauthenticated.
// This is acceptable because the server binds to 127.0.0.1 only (localhost).
// For remote access, implement Bearer token auth using the vault.

import { Application } from 'express';
import { createApiContext } from './context.js';

import { registerSystemRoutes } from './routes/system.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerContextHeartbeatRoutes } from './routes/context-heartbeat.js';
import { registerBookBibleRoutes } from './routes/book-bible.js';
import { registerAuthorOSToolsRoutes } from './routes/authoros-tools.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerResearchWebRoutes } from './routes/research-web.js';
import { registerImageRoutes } from './routes/images.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerSneakersRoutes } from './routes/sneakers.js';
import { registerKdpTrackChangesRoutes } from './routes/kdp-track-changes.js';
import { registerExternalCoversRoutes } from './routes/external-covers.js';
import { registerManuscriptQualityRoutes } from './routes/manuscript-quality.js';
import { registerMemorySearchRoutes } from './routes/memory-search.js';
import { registerUserModelRoutes } from './routes/user-model.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerSkillDraftRoutes } from './routes/skill-drafts.js';
import { registerJudgeCharacterVoiceRoutes } from './routes/judge-character-voices.js';
import { registerResearchLookupRoutes } from './routes/research-lookup.js';
import { registerVideoResearchRoutes } from './routes/video-research.js';
import { registerStructuresPlotRoutes } from './routes/structures-plot.js';
import { registerWave3GatedRoutes } from './routes/wave3-gated.js';
import { registerWebsiteRoutes } from './routes/website.js';
import { registerReaderPanelRoutes } from './routes/reader-panel.js';
import { registerReaderFeedbackRoutes } from './routes/reader-feedback.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerWorkspaceGitRoutes } from './routes/workspace-git.js';

export function createAPIRoutes(app: Application, gateway: any, rootDir?: string, workspaceDir?: string): void {
  const ctx = createApiContext(app, gateway, rootDir, workspaceDir);

  // Registration order matches the original monolithic routes.ts exactly —
  // this matters for Express route-matching precedence (e.g. static routes
  // like /api/personas/generate must be registered before /api/personas/:id).
  registerSystemRoutes(ctx);
  registerProjectRoutes(ctx);
  registerDocumentRoutes(ctx);
  registerContextHeartbeatRoutes(ctx);
  registerBookBibleRoutes(ctx);
  registerAuthorOSToolsRoutes(ctx);
  registerPersonaRoutes(ctx);
  registerResearchWebRoutes(ctx);
  registerImageRoutes(ctx);
  registerAudioRoutes(ctx);
  registerBackupRoutes(ctx);
  registerSneakersRoutes(ctx);
  registerKdpTrackChangesRoutes(ctx);
  registerExternalCoversRoutes(ctx);
  registerManuscriptQualityRoutes(ctx);
  registerMemorySearchRoutes(ctx);
  registerUserModelRoutes(ctx);
  registerCronRoutes(ctx);
  registerSkillDraftRoutes(ctx);
  registerJudgeCharacterVoiceRoutes(ctx);
  registerResearchLookupRoutes(ctx);
  registerVideoResearchRoutes(ctx);
  registerStructuresPlotRoutes(ctx);
  registerWave3GatedRoutes(ctx);
  registerWebsiteRoutes(ctx);
  registerReaderPanelRoutes(ctx);
  registerReaderFeedbackRoutes(ctx);
  registerReviewRoutes(ctx);
  registerWorkspaceGitRoutes(ctx);
}

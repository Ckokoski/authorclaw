/**
 * Shared API context + helpers for the per-domain route modules under
 * gateway/src/api/routes/.
 *
 * This module was extracted from the former monolithic routes.ts as part of
 * a behavior-preserving split (Phase 2 item 1). Every helper below is moved
 * verbatim from routes.ts — no logic was changed.
 */

import { Application, Request, Response } from 'express';
import multer from 'multer';
import { join } from 'path';
import { safeResolveWithin } from '../security/paths.js';

/**
 * Verify a resolved path stays within the allowed base directory.
 * Thin wrapper over the shared path-safety helper (security/paths.ts) — kept
 * as a local alias so existing call sites read unchanged. Returns null on
 * escape so handlers can respond with 403.
 */
export function safePath(base: string, userInput: string): string | null {
  return safeResolveWithin(base, userInput);
}

/**
 * Non-blocking sanity check for vault key/value slot mismatches.
 *
 * Bug this guards against: a Gemini key (`AIzaSy...`) was pasted into the
 * OpenAI vault slot, so gpt-image calls 401'd silently — nothing at save
 * time hinted the value was in the wrong slot. This never blocks the save
 * (the user may know better, e.g. a proxy that re-maps keys); it only
 * returns a warning string for the caller to surface.
 */
export function validateKeyFormat(keyName: string, value: string): { ok: boolean; warning?: string } {
  const looksGoogle = /^AIzaSy/.test(value);
  const looksAnthropic = /^sk-ant-/.test(value);
  const looksOpenAI = /^sk-(?!ant-)/.test(value); // sk-... but not sk-ant-...

  switch (keyName) {
    case 'openai_api_key': {
      if (looksGoogle) {
        return { ok: false, warning: 'This looks like a Google/Gemini API key (starts with "AIzaSy"), not an OpenAI key (usually starts with "sk-" or "sk-proj-").' };
      }
      if (looksAnthropic) {
        return { ok: false, warning: 'This looks like an Anthropic/Claude API key (starts with "sk-ant-"), not an OpenAI key.' };
      }
      if (!looksOpenAI) {
        return { ok: false, warning: 'OpenAI API keys usually start with "sk-" or "sk-proj-". Double-check this is the right key.' };
      }
      return { ok: true };
    }

    case 'anthropic_api_key': {
      if (looksGoogle) {
        return { ok: false, warning: 'This looks like a Google/Gemini API key (starts with "AIzaSy"), not an Anthropic/Claude key (starts with "sk-ant-").' };
      }
      if (value.startsWith('sk-') && !looksAnthropic) {
        return { ok: false, warning: 'This looks like a plain "sk-" key (e.g. OpenAI), not an Anthropic/Claude key (usually starts with "sk-ant-").' };
      }
      if (!looksAnthropic) {
        return { ok: false, warning: 'Anthropic/Claude API keys usually start with "sk-ant-". Double-check this is the right key.' };
      }
      return { ok: true };
    }

    case 'gemini_api_key': {
      if (looksOpenAI || looksAnthropic) {
        return { ok: false, warning: 'This looks like an OpenAI/Anthropic API key ("sk-..."), not a Google/Gemini key (usually starts with "AIzaSy").' };
      }
      if (!looksGoogle) {
        return { ok: false, warning: 'Google/Gemini API keys usually start with "AIzaSy". Double-check this is the right key.' };
      }
      return { ok: true };
    }

    case 'together_api_key':
    case 'openrouter_api_key': {
      if (looksGoogle) {
        return { ok: false, warning: `This looks like a Google/Gemini API key (starts with "AIzaSy"), not a ${keyName.replace(/_/g, ' ')}.` };
      }
      if (looksAnthropic) {
        return { ok: false, warning: `This looks like an Anthropic/Claude API key (starts with "sk-ant-"), not a ${keyName.replace(/_/g, ' ')}.` };
      }
      // together/openrouter keys can legitimately look like "sk-..." (openrouter is "sk-or-v1-...")
      // so a bare OpenAI-style key isn't flagged here, only clear cross-provider mismatches.
      return { ok: true };
    }

    case 'telegram_bot_token': {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(value)) {
        return { ok: false, warning: 'Telegram bot tokens usually look like "123456789:ABC-DEF...". Double-check this is the right value.' };
      }
      return { ok: true };
    }

    case 'git_pat': {
      if (!/^(github_pat_|ghp_)/.test(value)) {
        return { ok: false, warning: 'GitHub personal access tokens usually start with "github_pat_" (fine-grained) or "ghp_" (classic). Double-check this is the right value.' };
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

/**
 * Vault key names that indicate an AI provider is configured. Shared between
 * the onboarding checklist (system.ts) and anywhere else that needs to ask
 * "does the user have at least one paid/free provider key saved?" without
 * going through the AI router (e.g. before it has initialized).
 */
export const PROVIDER_KEY_NAMES = [
  'gemini_api_key', 'deepseek_api_key', 'anthropic_api_key',
  'openai_api_key', 'openrouter_api_key', 'together_api_key',
] as const;

/** True if any of the given vault key names is a known AI provider key. */
export function hasProviderKeyName(keys: string[]): boolean {
  return keys.some(k => (PROVIDER_KEY_NAMES as readonly string[]).includes(k));
}

/**
 * The exact status line present in both the shipped VOICE-PROFILE.template.md
 * and the un-analyzed live VOICE-PROFILE.md (which starts as a copy of the
 * template). SoulService.updateVoiceProfile() overwrites the file with real
 * markers once a manuscript has been analyzed, so this line's absence is a
 * reliable "voice profile is live" signal — see workspace/soul/VOICE-PROFILE.template.md.
 */
const VOICE_PROFILE_TEMPLATE_MARKER = 'Status: Not Yet Analyzed';

/**
 * True if `content` is the un-analyzed template (or a close variant of it) —
 * i.e. the voice profile has NOT been populated by real analysis yet.
 * Empty/whitespace-only content also counts as "not yet analyzed".
 */
export function isVoiceProfileTemplate(content: string): boolean {
  if (!content || !content.trim()) return true;
  return content.includes(VOICE_PROFILE_TEMPLATE_MARKER);
}

/**
 * Shared multer instance for large (up to 50MB) manuscript-style uploads.
 * Used by both /api/projects/:id/upload (documents.ts) and
 * /api/track-changes/parse (kdp-track-changes.ts) — moved here verbatim so
 * both modules reference the same configured instance.
 */
export const upload = multer({
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

/**
 * Universal disclaimer returned with every Wave 3 response header.
 * Used across confirmations, launches, ams, bookbub, translation, and
 * website-builder routes.
 */
export function addWaveDisclaimer(res: Response): void {
  res.setHeader('X-AuthorAgent-Disclaimer', 'Wave 3 actions create confirmation requests but do not execute irreversible actions autonomously. You are responsible for every approved action. See SECURITY.md.');
}

/**
 * Helper: gather completed writing-phase chapters for a project.
 * Used across external-tools, beta-reader/dialogue-auditor, craft critic,
 * audiobook prep, and style-clone routes.
 */
export async function gatherChapters(workspaceDir: string, project: any): Promise<Array<{ id: string; number: number; title: string; text: string }>> {
  const { readFile: rf } = await import('fs/promises');
  const { existsSync: ex } = await import('fs');
  const { resolveStepOutputPath } = await import('../services/project-paths.js');

  const writingSteps = project.steps
    .filter((s: any) => (s.phase === 'writing' || s.label?.toLowerCase().includes('chapter')) && s.status === 'completed')
    .sort((a: any, b: any) => (a.chapterNumber || 0) - (b.chapterNumber || 0));

  const chapters: Array<{ id: string; number: number; title: string; text: string }> = [];
  for (const ws of writingSteps) {
    let text = ws.result || '';
    // If no inline result, try reading from disk. Goes through the shared
    // resolver (ALP-1548) so it finds outputs in the per-phase dir as well as
    // the legacy flat one — this used to re-derive the flat path itself.
    if (!text) {
      const fullPath = resolveStepOutputPath(workspaceDir, project, ws);
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

/**
 * Bundle of everything the original createAPIRoutes() closed over, passed to
 * each registerXRoutes(ctx) function so per-domain modules don't need to
 * duplicate service resolution or helper definitions.
 *
 * `baseDir` is the install checkout root (ROOT_DIR) — use it for install-tree
 * paths like `skills/`. `workspaceDir` is the resolved per-book workspace
 * root (honors AUTHORCLAW_WORKSPACE_DIR / the active-book pointer, see
 * workspace-routing.ts) — use it for project/step output, `.config/`, etc.
 * ALP-1614: these used to collapse to the same value (`join(baseDir,
 * 'workspace')`), which silently ignored per-book workspace routing.
 */
export interface ApiContext {
  app: Application;
  gateway: any;
  services: any;
  baseDir: string;
  workspaceDir: string;
}

export function createApiContext(app: Application, gateway: any, rootDir?: string, workspaceDir?: string): ApiContext {
  const services = gateway.getServices();
  const baseDir = rootDir || process.cwd();
  return { app, gateway, services, baseDir, workspaceDir: workspaceDir || join(baseDir, 'workspace') };
}

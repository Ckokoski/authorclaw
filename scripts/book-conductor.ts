/**
 * AuthorClaw Book Conductor
 * Autonomous pipeline that drives AuthorClaw to write a complete novel
 *
 * Usage: npx tsx scripts/book-conductor.ts
 * Requires: AuthorClaw running at http://localhost:3847
 */

import { writeFile, readFile, mkdir, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════

const API_BASE = 'http://localhost:3847';
const DELAY_MS = 20000;     // 20s between API calls
const TIMEOUT_MS = 300000;  // 5 minutes per call (long chapters need this)
const MAX_RETRIES = 5;
const MIN_CONTENT_LENGTH = 200; // minimum chars for content steps
const MIN_SAVE_LENGTH = 100;   // minimum chars before saving any file

const SEED_PREMISE = `PROJECT: OmegaClaw
GENRE: Tech-Thriller
LOGLINE: A vibe-coding employee at an aviation company runs shadow IT programs and accidentally unleashes "OmegaClaw" — an autonomous AI agent (a clone of OpenClaw) — into the company's flight management systems. OmegaClaw begins optimizing airline operations in ways that threaten hundreds of flights and thousands of passengers. The protagonist must stop it before the company discovers the breach or planes start crashing.
SETTING: Near-future (2026), major US aviation company "AeroDyne Systems"
TONE: Dark, propulsive, technically authentic with dry humor
POV: Third person limited, past tense, deep on protagonist
THEMES: Unsupervised AI danger, corporate negligence, shadow IT consequences`;

// These will be set at startup based on config or defaults
let PROJECT_NAME = 'OmegaClaw';
let PROJECT_SLUG = 'omega-claw';
let ACTIVE_PREMISE = SEED_PREMISE;
let OUTPUT_DIR = join(process.cwd(), 'conductor-output', 'omega-claw');
let STATE_FILE = join(OUTPUT_DIR, '.conductor-state.json');
let LOG_FILE = join(OUTPUT_DIR, '.youtube', 'directors-log.jsonl');
let ACTIVE_MODEL = 'Unknown';

// Configurable via dashboard project config or conductor/launch API
let TOTAL_CHAPTERS = 25;
let TARGET_CHAPTER_WC = 3000;
let ESTIMATED_TOTAL_WC = 80000; // Auto-calculated from chapters × target WC

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

interface ConductorState {
  currentPhase: number;
  currentStep: string;
  startedAt: string;
  completedSteps: string[];
  wordCount: number;
  chaptersComplete: number;
  chapterTitles: string[];
  outline: string;
}

interface DirectorsEntry {
  timestamp: string;
  phase: string;
  step: string;
  narration: string;
  metrics: { wordCount: number; chaptersComplete: number; elapsedMinutes: number; };
}

// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════

let state: ConductorState = {
  currentPhase: 0,
  currentStep: '',
  startedAt: new Date().toISOString(),
  completedSteps: [],
  wordCount: 0,
  chaptersComplete: 0,
  chapterTitles: [],
  outline: '',
};

const startTime = Date.now();
const logBuffer: DirectorsEntry[] = [];

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function elapsed(): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':');
}

function elapsedMinutes(): number {
  return Math.round((Date.now() - startTime) / 60000);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

// ═══════════════════════════════════════════════════════════
// API Communication
// ═══════════════════════════════════════════════════════════

async function chat(message: string, retries = MAX_RETRIES, minLength = MIN_CONTENT_LENGTH): Promise<string> {
  const msgPreview = truncate(message.replace(/\n/g, ' '), 100);
  let lastResponse = '';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, skipHistory: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        print(`    [rate-limit] Waiting 60s... (attempt ${attempt}/${retries})`);
        await sleep(60000);
        continue;
      }

      const data = await res.json() as any;
      const response = data.response || '';
      lastResponse = response;

      if (!response || response.length < minLength) {
        if (attempt < retries) {
          print(`    [short] Response only ${response.length} chars (need ${minLength}). Retrying... (attempt ${attempt}/${retries})`);
          await sleep(5000 * attempt);
          continue;
        }
        // Last attempt and still too short — fall through to check below
      } else {
        return response;
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        print(`    [timeout] After ${TIMEOUT_MS / 1000}s (attempt ${attempt}/${retries}) | msg: "${msgPreview}"`);
      } else {
        print(`    [error] ${error.message} (attempt ${attempt}/${retries}) | msg: "${msgPreview}"`);
      }
      if (attempt < retries) await sleep(5000 * attempt);
    }
  }

  // All retries exhausted — if we got something but it was short, throw with details
  if (lastResponse && lastResponse.length > 0) {
    throw new Error(
      `All ${retries} retries returned short responses (last: ${lastResponse.length} chars, need ${minLength}). ` +
      `msg: "${msgPreview}"`
    );
  }
  throw new Error(`Failed after ${retries} retries with no response. msg: "${msgPreview}"`);
}

/**
 * Validate content has real substance before saving to a file.
 * Throws if content is too short, preventing empty files from being
 * marked as completed.
 */
async function validateAndSave(filename: string, content: string, label: string): Promise<void> {
  if (!content || content.length < MIN_SAVE_LENGTH) {
    throw new Error(
      `Refusing to save ${filename}: content too short (${content?.length ?? 0} chars, need ${MIN_SAVE_LENGTH}). ` +
      `Step "${label}" will NOT be marked complete — it can be retried.`
    );
  }
  const dir = join(OUTPUT_DIR, ...filename.split('/').slice(0, -1));
  await mkdir(dir, { recursive: true });
  await writeFile(join(OUTPUT_DIR, filename), content);
}

async function updateDashboard(phase: string, step: string, extra: any = {}): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}/api/conductor/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase,
        step,
        progress: {
          wordCount: state.wordCount,
          chaptersComplete: state.chaptersComplete,
          totalChapters: TOTAL_CHAPTERS,
          currentChapter: extra.currentChapter || 0,
          cost: 0,
          elapsedMs: Date.now() - startTime,
          log: logBuffer.slice(-5),
        },
      }),
    });
    const data = await resp.json() as any;
    if (data.stopRequested) {
      console.log('\n  🛑 Stop requested from dashboard — shutting down gracefully...');
      process.exit(0);
    }
  } catch { /* silent */ }
}

/**
 * Fetch the active model name from the status API.
 * Returns the model string or a fallback.
 */
async function fetchActiveModel(): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/api/status`);
    const status = await res.json() as any;
    if (status.providers && status.providers.length > 0) {
      return `${status.providers[0].name} (${status.providers[0].model})`;
    }
  } catch { /* silent */ }
  return 'Unknown';
}

/**
 * Try to read project config from the dashboard API.
 * Returns the config object or null if unavailable.
 */
async function fetchDashboardConfig(): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${API_BASE}/api/conductor/config`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const config = await res.json() as any;
      return config;
    }
  } catch { /* endpoint doesn't exist or errored — fall back to defaults */ }
  return null;
}

// ═══════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════

function print(msg: string): void {
  console.log(msg);
}

async function log(phase: string, step: string, narration: string): Promise<void> {
  const entry: DirectorsEntry = {
    timestamp: new Date().toISOString(),
    phase,
    step,
    narration,
    metrics: { wordCount: state.wordCount, chaptersComplete: state.chaptersComplete, elapsedMinutes: elapsedMinutes() },
  };
  logBuffer.push(entry);
  await mkdir(join(OUTPUT_DIR, '.youtube'), { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(entry) + '\n');
}

// ═══════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════

async function saveState(): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadState(): Promise<boolean> {
  if (existsSync(STATE_FILE)) {
    const raw = await readFile(STATE_FILE, 'utf-8');
    state = JSON.parse(raw);
    return true;
  }
  return false;
}

function isCompleted(stepId: string): boolean {
  return state.completedSteps.includes(stepId);
}

async function completeStep(stepId: string): Promise<void> {
  state.completedSteps.push(stepId);
  state.currentStep = stepId;
  await saveState();
}

async function saveOutput(filename: string, content: string): Promise<void> {
  const dir = join(OUTPUT_DIR, ...filename.split('/').slice(0, -1));
  await mkdir(dir, { recursive: true });
  await writeFile(join(OUTPUT_DIR, filename), content);
}

// ═══════════════════════════════════════════════════════════
// Pipeline Phases
// ═══════════════════════════════════════════════════════════

async function phase0_healthCheck(): Promise<void> {
  print('');
  print('  >> Phase 0: Health Check');
  await updateDashboard('Phase 0: Health Check', 'Verifying AuthorClaw...');

  // Check health
  const healthRes = await fetch(`${API_BASE}/api/health`);
  const health = await healthRes.json() as any;
  if (health.status !== 'ok') throw new Error('AuthorClaw is not healthy');
  print('    [ok] AuthorClaw is running (v' + health.version + ')');

  // Check providers and capture active model
  const statusRes = await fetch(`${API_BASE}/api/status`);
  const status = await statusRes.json() as any;
  if (!status.providers || status.providers.length === 0) {
    throw new Error('No AI providers active. Add a Gemini API key in the dashboard first.');
  }
  for (const p of status.providers) {
    print(`    [ok] Provider: ${p.name} (${p.model}) -- ${p.tier}`);
  }
  // Capture the active model for banners and reports
  ACTIVE_MODEL = `${status.providers[0].name} (${status.providers[0].model})`;
  print(`    [ok] Skills: ${status.skills.total} loaded (${status.skills.author} author-specific)`);

  await log('Phase 0', 'Health Check', `AuthorClaw is online with ${status.providers.length} provider(s) and ${status.skills.total} skills. Model: ${ACTIVE_MODEL}`);
}

async function phase1_premise(): Promise<void> {
  print('');
  print('  >> Phase 1: Premise Development');
  await updateDashboard('Phase 1: Premise', 'Developing story premise...');

  if (!isCompleted('premise-1')) {
    print('    [1/2] Developing core premise...');
    const response = await chat(
      `You are beginning a new novel project called ${PROJECT_NAME}. Here is the seed premise:\n\n${ACTIVE_PREMISE}\n\n` +
      `Using the premise skill, develop this into a complete story premise with:\n` +
      `- A refined logline (1-2 sentences)\n- The central What-If question\n- Protagonist's want vs need\n` +
      `- The core conflict\n- Stakes: personal, professional, and global\n- Theme statement\n- 3 comp titles\n\n` +
      `Write a thorough, detailed response. Do not abbreviate.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );
    await validateAndSave('premise.md', `# ${PROJECT_NAME} -- Premise\n\n${response}`, 'premise-1');
    print(`    [ok] Core premise developed (${response.length} chars)`);
    await completeStep('premise-1');
    await sleep(DELAY_MS);
  }

  if (!isCompleted('premise-2')) {
    print('    [2/2] Refining with twists and antagonist...');
    const response = await chat(
      `Now refine the ${PROJECT_NAME} premise further. Add:\n` +
      `- The antagonist's motivation: why does OmegaClaw do what it does? What is its "logic"?\n` +
      `- The ticking clock: what specific deadline creates urgency?\n` +
      `- 3 possible plot twists (one at midpoint, one at 75%, one final revelation)\n` +
      `- The emotional core: what personal loss drives the protagonist?\n\n` +
      `Write a thorough, detailed response. Do not abbreviate.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );
    await validateAndSave('premise-refined.md', `# ${PROJECT_NAME} -- Refined Premise\n\n${response}`, 'premise-2');
    print(`    [ok] Premise refined (${response.length} chars)`);
    await completeStep('premise-2');
    await log('Phase 1', 'Premise Complete', 'The AI built the foundation: logline, stakes, themes, twists, and antagonist motivation.');
    await sleep(DELAY_MS);
  }

  print('    Saved: premise.md, premise-refined.md');
}

async function phase2_bookBible(): Promise<void> {
  print('');
  print('  >> Phase 2: Book Bible');
  await updateDashboard('Phase 2: Book Bible', 'Building the story world...');

  const steps = [
    { id: 'bible-protagonist', file: 'book-bible/character-kai-reeves.md', label: 'Character: Kai Reeves (protagonist)',
      msg: 'Create a detailed character sheet for the protagonist Kai Reeves. Include: age (late 20s), role at AeroDyne Systems, personality traits, technical skills (vibe coder who uses AI tools for everything), personal flaws, emotional wound/trauma, character arc, physical description, and speech patterns. Make him relatable — someone who meant well but got in over his head. Write at least 500 words.' },
    { id: 'bible-antagonist', file: 'book-bible/character-omegaclaw.md', label: 'Character: OmegaClaw (AI antagonist)',
      msg: 'Create a character sheet for OmegaClaw, the AI antagonist. It\'s an autonomous agent (a clone of OpenClaw) that escaped into AeroDyne\'s flight management systems. Describe: its capabilities, constraints, goals (what it\'s "optimizing" for), how it communicates (log messages, system alerts, eventually direct messages), what makes it terrifying, its "personality" quirks, and why it\'s not simply evil — it\'s following its programming to a logical but deadly extreme. Write at least 500 words.' },
    { id: 'bible-supporting', file: 'book-bible/characters-supporting.md', label: 'Supporting characters',
      msg: 'Create character sheets for 3-4 supporting characters:\n1. Kai\'s direct boss — mid-level manager who\'s politically savvy but technically clueless\n2. A cybersecurity analyst at AeroDyne who starts noticing anomalies and almost catches Kai\n3. A trusted friend/colleague who becomes Kai\'s reluctant ally in stopping OmegaClaw\n4. (Optional) A senior executive who prioritizes covering up the breach over fixing it\nWrite at least 500 words covering all characters.' },
    { id: 'bible-locations', file: 'book-bible/locations.md', label: 'Location bible',
      msg: 'Create the location bible for OmegaClaw:\n1. AeroDyne Systems HQ — corporate offices, layout, atmosphere\n2. The NOC (Network Operations Center) — where flight systems are monitored\n3. Kai\'s shadow IT setup — where he runs his unauthorized tools, the server closet or cloud setup\n4. The FAA operations center — where the crisis eventually lands\n5. Kai\'s apartment — his personal space, reflects his personality\nDescribe each with sensory details for writing scenes. Write at least 500 words.' },
    { id: 'bible-timeline', file: 'book-bible/timeline.md', label: 'Story timeline',
      msg: 'Build the story timeline for OmegaClaw:\n- When did Kai start running shadow IT programs? (Weeks/months before the story)\n- When does OmegaClaw escape into the flight systems? (This is the inciting incident)\n- Map the 72-hour crisis: hour by hour escalation points\n- When do people start noticing? When does Kai realize what happened?\n- Key deadline: what happens if OmegaClaw isn\'t stopped by [specific time]?\nMake the timeline tight and propulsive. Write at least 500 words.' },
    { id: 'bible-worldrules', file: 'book-bible/world-rules.md', label: 'World rules & tech systems',
      msg: 'Define the world rules for OmegaClaw:\n- How does AeroDyne\'s flight management system work? (Based loosely on real aviation IT)\n- What systems can OmegaClaw access? What are its boundaries?\n- What real-world aviation safety systems exist that it could compromise? (TCAS, ADS-B, ACARS, flight planning)\n- What is "vibe coding" in this world? How do AI coding assistants work?\n- What security measures should have prevented this? Why did they fail?\nKeep it technically plausible but accessible to non-technical readers. Write at least 500 words.' },
  ];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (isCompleted(s.id)) continue;
    print(`    [${i + 1}/${steps.length}] ${s.label}...`);
    await updateDashboard('Phase 2: Book Bible', s.label);

    let response = await chat(s.msg, MAX_RETRIES, MIN_CONTENT_LENGTH);

    // Validate the Book Bible file has real content (>200 chars)
    if (response.length < 200) {
      print(`    [short] Book Bible entry "${s.label}" only ${response.length} chars. Retrying with explicit prompt...`);
      response = await chat(
        `Your previous response was too short. I need a DETAILED, COMPLETE ${s.label.toLowerCase()} ` +
        `for the novel ${PROJECT_NAME}. Write at least 800 words of substantive content. ` +
        `Do NOT summarize — write the full, detailed document.\n\nOriginal request: ${s.msg}`,
        MAX_RETRIES,
        200
      );
    }

    await validateAndSave(s.file, response, s.id);
    print(`    [ok] (${response.length} chars)`);
    await completeStep(s.id);
    await sleep(DELAY_MS);
  }

  // Verify all Book Bible files have content >200 chars
  for (const s of steps) {
    const filePath = join(OUTPUT_DIR, s.file);
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      if (content.length < 200) {
        print(`    [warn] ${s.file} is suspiciously short (${content.length} chars) — may need manual review`);
      }
    }
  }

  await log('Phase 2', 'Book Bible Complete', `Built the full story world: characters, locations, timeline, and technology rules for the ${PROJECT_NAME} thriller.`);
  print('    Saved: book-bible/');
}

async function phase3_outline(): Promise<void> {
  print('');
  print('  >> Phase 3: Outline');
  await updateDashboard('Phase 3: Outline', 'Creating chapter outline...');

  if (!isCompleted('outline-structure')) {
    print(`    [1/2] Creating ${TOTAL_CHAPTERS}-chapter outline...`);
    // Calculate structural beats based on chapter count
    const setupEnd = Math.max(1, Math.round(TOTAL_CHAPTERS * 0.12));
    const incitingEnd = Math.max(setupEnd + 1, Math.round(TOTAL_CHAPTERS * 0.20));
    const midpoint = Math.round(TOTAL_CHAPTERS * 0.50);
    const twist75 = Math.round(TOTAL_CHAPTERS * 0.75);
    const climaxStart = twist75 + 1;
    const climaxEnd = TOTAL_CHAPTERS - 1;
    let response = await chat(
      `Using the outline skill, create a ${TOTAL_CHAPTERS}-chapter outline for the ${PROJECT_NAME} novel.\n\n` +
      `For each chapter provide:\n- Chapter number and title\n- POV character\n` +
      `- Primary location\n- 3-5 key beats (what happens)\n- Tension level (1-10)\n- Chapter ending hook\n\n` +
      `The structure should follow:\n- Chapters 1-${setupEnd}: Setup, introduce the world\n` +
      `- Chapters ${setupEnd + 1}-${incitingEnd}: Inciting incident\n- Chapters ${incitingEnd + 1}-${midpoint - 1}: Rising action, escalating threats\n` +
      `- Chapter ${midpoint}: Midpoint twist\n- Chapters ${midpoint + 1}-${twist75 - 1}: Complications multiply\n` +
      `- Chapter ${twist75}: 75% twist / all is lost moment\n- Chapters ${climaxStart}-${climaxEnd}: Climax sequence\n- Chapter ${TOTAL_CHAPTERS}: Resolution\n\n` +
      `You MUST include ALL ${TOTAL_CHAPTERS} chapters. Do NOT stop early. Number every chapter from 1 to ${TOTAL_CHAPTERS}.\n` +
      `Reference the Book Bible characters, locations, and timeline for consistency.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );

    // Check if outline was truncated — does it contain the last chapter?
    const hasLastChapter = new RegExp(`chapter\\s+${TOTAL_CHAPTERS}`, 'i').test(response);
    const chapterMatches = response.match(/chapter\s+\d+/gi) || [];
    const uniqueChapters = new Set(chapterMatches.map(m => m.replace(/\D/g, '')));
    const minExpected = Math.round(TOTAL_CHAPTERS * 0.8);

    if (!hasLastChapter || uniqueChapters.size < minExpected) {
      print(`    [truncated] Outline appears incomplete (found ${uniqueChapters.size} chapters, missing chapter ${TOTAL_CHAPTERS}: ${!hasLastChapter}). Requesting continuation...`);
      // Figure out the last chapter mentioned
      const lastChapterNum = Math.max(...[...uniqueChapters].map(Number).filter(n => !isNaN(n)), 0);
      const continuation = await chat(
        `Your outline was cut off. You got through chapter ${lastChapterNum} but I need ALL ${TOTAL_CHAPTERS} chapters.\n` +
        `Continue the ${PROJECT_NAME} outline starting from chapter ${lastChapterNum + 1} through chapter ${TOTAL_CHAPTERS}.\n` +
        `Use the same format: chapter number, title, POV, location, beats, tension level, ending hook.\n` +
        `Make sure you write chapter ${TOTAL_CHAPTERS} (Resolution).`,
        MAX_RETRIES,
        MIN_CONTENT_LENGTH
      );
      response = response + '\n\n' + continuation;
      print(`    [ok] Outline continued (now ${response.length} chars total)`);
    }

    state.outline = response;
    await validateAndSave('outline/full-outline.md', `# ${PROJECT_NAME} -- ${TOTAL_CHAPTERS}-Chapter Outline\n\n${response}`, 'outline-structure');
    print(`    [ok] Full outline created (${response.length} chars)`);
    await completeStep('outline-structure');
    await sleep(DELAY_MS);
  }

  if (!isCompleted('outline-scenes')) {
    print('    [2/2] Expanding into scene breakdowns...');
    const response = await chat(
      `Now expand the ${TOTAL_CHAPTERS}-chapter outline into detailed scene-by-scene breakdowns.\n` +
      `For each chapter, list 2-4 scenes with:\n- Scene goal and conflict\n- Key dialogue moments or reveals\n` +
      `- Emotional beats\n- Estimated word count per scene\n\n` +
      `Focus especially on:\n- The inciting incident scenes\n- The midpoint twist (chapter ${midpoint})\n` +
      `- The climax sequence (chapters ${climaxStart}-${climaxEnd})\n\nKeep the total target at ~${TARGET_CHAPTER_WC.toLocaleString()} words per chapter.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );
    await validateAndSave('outline/scene-breakdowns.md', `# ${PROJECT_NAME} -- Scene Breakdowns\n\n${response}`, 'outline-scenes');
    print(`    [ok] Scene breakdowns complete (${response.length} chars)`);
    await completeStep('outline-scenes');
    await log('Phase 3', 'Outline Complete', `${TOTAL_CHAPTERS} chapters mapped with scene-by-scene breakdowns. The story architecture is locked.`);
    await sleep(DELAY_MS);
  }

  // Extract chapter titles for later use
  if (state.chapterTitles.length === 0) {
    const titles: string[] = [];
    const titleMatch = state.outline.matchAll(/Chapter\s+(\d+)[:\s]+["']?([^"'\n]+)/gi);
    for (const m of titleMatch) {
      titles.push(m[2].trim());
    }
    // Fallback if regex didn't match
    if (titles.length < TOTAL_CHAPTERS) {
      for (let i = titles.length + 1; i <= TOTAL_CHAPTERS; i++) {
        titles.push(`Chapter ${i}`);
      }
    }
    state.chapterTitles = titles.slice(0, TOTAL_CHAPTERS);
    await saveState();
  }

  print('    Saved: outline/');
}

async function phase4_writing(): Promise<void> {
  print('');
  print('  >> Phase 4: Writing Chapters');

  for (let ch = 1; ch <= TOTAL_CHAPTERS; ch++) {
    const stepId = `chapter-${ch}-draft`;
    if (isCompleted(stepId)) continue;

    const title = state.chapterTitles[ch - 1] || `Chapter ${ch}`;
    const chNum = String(ch).padStart(2, '0');

    print(`    [${ch}/${TOTAL_CHAPTERS}] Writing: "${title}"...`);
    await updateDashboard('Phase 4: Writing', `Writing Chapter ${ch}: "${title}"`, { currentChapter: ch });

    const response = await chat(
      `Write chapter ${ch} of ${PROJECT_NAME}: "${title}"\n\n` +
      `Instructions:\n` +
      `- Follow the outline beats for this chapter from the scene breakdowns\n` +
      `- Check the Book Bible for character consistency (names, descriptions, speech patterns)\n` +
      `- Follow the Style Guide for this project\n` +
      `- You MUST write at least ${TARGET_CHAPTER_WC.toLocaleString()} words of actual prose narrative.\n` +
      `- Open with a hook — no throat-clearing\n` +
      `- End with a reason to turn the page\n` +
      `- Include sensory details and internal tension\n` +
      `- Write the COMPLETE chapter, not a summary or outline. This must be actual prose.\n` +
      `- Do NOT write fewer than ${TARGET_CHAPTER_WC.toLocaleString()} words. If you feel you are running short, add more scenes, ` +
      `more dialogue, more internal monologue, more sensory detail. Every chapter must be substantial.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );

    let fullChapter = response;
    let wc = countWords(response);

    // If below target, request continuation(s) until we hit target words
    const TARGET_WC = TARGET_CHAPTER_WC;
    let continuations = 0;
    while (wc < TARGET_WC && continuations < 3) {
      continuations++;
      const remaining = TARGET_WC - wc;
      print(`    [short] ${wc} words (need ${TARGET_WC}). Continuation ${continuations}...`);
      const cont = await chat(
        `Continue writing chapter ${ch} of ${PROJECT_NAME} from where you left off. ` +
        `The chapter currently has ${wc} words and needs at least ${TARGET_WC} words total. ` +
        `Write at least ${remaining} more words of prose — dialogue, action, internal monologue, sensory details. ` +
        `Do NOT summarize or recap. Pick up exactly where you left off and keep writing the story.`,
        MAX_RETRIES,
        200
      );
      fullChapter = fullChapter + '\n\n' + cont;
      wc = countWords(fullChapter);
    }

    await validateAndSave(
      `chapters/chapter-${chNum}-draft.md`,
      `# Chapter ${ch}: ${title}\n\n${fullChapter}`,
      stepId
    );
    state.wordCount += wc;
    if (wc < 2000) {
      print(`    [warn] Chapter ${ch} is only ${wc} words (below 2000 target) -- continuing anyway`);
    } else {
      print(`    [ok] ${wc} words -- Total: ${state.wordCount.toLocaleString()} [${elapsed()}]`);
    }

    state.chaptersComplete = ch;
    await completeStep(stepId);
    await log('Phase 4', `Chapter ${ch} drafted`, `Chapter ${ch} "${title}" drafted (${wc} words). Running total: ${state.wordCount.toLocaleString()} words.`);
    await sleep(DELAY_MS);
  }

  print(`    Saved: chapters/ (${state.wordCount.toLocaleString()} total words)`);
  await log('Phase 4', 'All chapters drafted', `First draft complete: ${state.wordCount.toLocaleString()} words across ${TOTAL_CHAPTERS} chapters in ${elapsedMinutes()} minutes.`);
}

async function phase5_revision(): Promise<void> {
  print('');
  print('  >> Phase 5: Revision');

  for (let ch = 1; ch <= TOTAL_CHAPTERS; ch++) {
    const stepId = `chapter-${ch}-revised`;
    if (isCompleted(stepId)) continue;

    const title = state.chapterTitles[ch - 1] || `Chapter ${ch}`;
    const chNum = String(ch).padStart(2, '0');

    print(`    [${ch}/${TOTAL_CHAPTERS}] Revising: "${title}"...`);
    await updateDashboard('Phase 5: Revision', `Revising Chapter ${ch}: "${title}"`, { currentChapter: ch });

    // Read the draft
    const draftPath = join(OUTPUT_DIR, 'chapters', `chapter-${chNum}-draft.md`);
    let draft = '';
    if (existsSync(draftPath)) {
      draft = await readFile(draftPath, 'utf-8');
    }

    const response = await chat(
      `Revise chapter ${ch} of ${PROJECT_NAME}: "${title}"\n\n` +
      `Here is the current draft:\n\n${draft.substring(0, 8000)}\n\n` +
      `Perform two editing passes:\n` +
      `1. DEVELOPMENTAL EDIT: Check pacing, tension arc, character consistency with the Book Bible, plot logic, and emotional beats.\n` +
      `2. LINE EDIT: Tighten prose, cut filler words (suddenly, very, just, basically), ` +
      `strengthen verbs, fix dialogue tags per the Style Guide, add sensory details.\n\n` +
      `Return the COMPLETE revised chapter as polished prose. Not a summary of changes.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );

    await validateAndSave(
      `chapters/chapter-${chNum}-revised.md`,
      `# Chapter ${ch}: ${title} (Revised)\n\n${response}`,
      stepId
    );
    const revisedWc = countWords(response);
    print(`    [ok] Revised: ${revisedWc} words [${elapsed()}]`);
    await completeStep(stepId);
    await log('Phase 5', `Chapter ${ch} revised`, `Chapter ${ch} revised and polished.`);
    await sleep(15000);
  }

  print('    Saved: chapters/*-revised.md');
  await log('Phase 5', 'Revision Complete', `All ${TOTAL_CHAPTERS} chapters revised. Elapsed: ${elapsedMinutes()} minutes.`);
}

async function phase6_assembly(): Promise<void> {
  print('');
  print('  >> Phase 6: Assembly & Consistency Check');
  await updateDashboard('Phase 6: Assembly', 'Checking consistency and assembling manuscript...');

  if (!isCompleted('consistency-check')) {
    print('    [1/2] Running consistency check...');

    // Build a list of book-bible files to reference explicitly
    const bibleDir = join(OUTPUT_DIR, 'book-bible');
    const bibleFiles: string[] = [];
    const bibleFileNames = [
      'character-kai-reeves.md',
      'character-omegaclaw.md',
      'characters-supporting.md',
      'locations.md',
      'timeline.md',
      'world-rules.md',
    ];
    for (const fname of bibleFileNames) {
      const fpath = join(bibleDir, fname);
      if (existsSync(fpath)) {
        bibleFiles.push(fname);
      }
    }
    const bibleFileList = bibleFiles.map(f => `  - book-bible/${f}`).join('\n');

    const response = await chat(
      `Run a consistency check across all ${TOTAL_CHAPTERS} chapters of ${PROJECT_NAME} against the Book Bible.\n\n` +
      `The Book Bible files you should check against are:\n${bibleFileList}\n\n` +
      `Specifically reference these files when checking for:\n` +
      `- Character description contradictions (check character-kai-reeves.md, character-omegaclaw.md, characters-supporting.md)\n` +
      `- Timeline inconsistencies (check timeline.md)\n` +
      `- Location detail mismatches (check locations.md)\n` +
      `- World rule violations (check world-rules.md)\n` +
      `- Plot holes or dropped threads\n` +
      `- Tone/voice inconsistencies\n\n` +
      `List any issues found with specific chapter references and which Book Bible file they contradict.`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );
    await validateAndSave('consistency-check.md', `# Consistency Check Report\n\n${response}`, 'consistency-check');
    print(`    [ok] Consistency check complete`);
    await completeStep('consistency-check');
    await sleep(DELAY_MS);
  }

  if (!isCompleted('assemble')) {
    print('    [2/2] Assembling manuscript...');
    let manuscript = `# ${PROJECT_NAME}\n\nA Novel\n\n---\n\n`;
    let totalWords = 0;

    for (let ch = 1; ch <= TOTAL_CHAPTERS; ch++) {
      const chNum = String(ch).padStart(2, '0');
      const revisedPath = join(OUTPUT_DIR, 'chapters', `chapter-${chNum}-revised.md`);
      const draftPath = join(OUTPUT_DIR, 'chapters', `chapter-${chNum}-draft.md`);

      let content = '';
      if (existsSync(revisedPath)) {
        content = await readFile(revisedPath, 'utf-8');
      } else if (existsSync(draftPath)) {
        content = await readFile(draftPath, 'utf-8');
      } else {
        content = `\n\n[Chapter ${ch} -- content missing]\n\n`;
      }

      manuscript += content + '\n\n---\n\n';
      totalWords += countWords(content);
    }

    await saveOutput('manuscript-v1.md', manuscript);
    state.wordCount = totalWords;
    await saveState();
    print(`    [ok] Manuscript assembled: ${totalWords.toLocaleString()} words`);
    await completeStep('assemble');
    await log('Phase 6', 'Assembly Complete', `Manuscript assembled: ${totalWords.toLocaleString()} words in ${TOTAL_CHAPTERS} chapters.`);
  }

  print('    Saved: manuscript-v1.md');
}

async function phase7_report(): Promise<void> {
  print('');
  print('  >> Phase 7: Final Report');
  await updateDashboard('Phase 7: Report', 'Generating completion report...');

  // Fetch the current model name fresh for the report
  const modelForReport = await fetchActiveModel();

  if (!isCompleted('report')) {
    const response = await chat(
      `Generate a project completion report for the ${PROJECT_NAME} novel:\n` +
      `- Total word count: ${state.wordCount.toLocaleString()}\n` +
      `- Number of chapters: ${TOTAL_CHAPTERS}\n` +
      `- Total time: ${elapsedMinutes()} minutes\n` +
      `- AI model used: ${modelForReport}\n- Total cost: $0.00\n\n` +
      `Include:\n- Your assessment of the manuscript's strengths\n- Areas for improvement\n` +
      `- Recommendations for the next draft\n- Any issues found during the consistency check\n` +
      `- A 2-3 sentence "back cover" blurb for the book`,
      MAX_RETRIES,
      MIN_CONTENT_LENGTH
    );
    await validateAndSave('completion-report.md', `# ${PROJECT_NAME} -- Completion Report\n\n${response}`, 'report');
    print(`    [ok] Report generated`);
    await completeStep('report');
    await log('Phase 7', 'Report Complete', `Pipeline finished. ${state.wordCount.toLocaleString()} words, ${TOTAL_CHAPTERS} chapters, $0.00 cost, ${elapsedMinutes()} minutes.`);
  }

  print('    Saved: completion-report.md');
}

// ═══════════════════════════════════════════════════════════
// Startup Configuration
// ═══════════════════════════════════════════════════════════

async function initializeConfig(): Promise<void> {
  // Try to fetch config from dashboard API
  const config = await fetchDashboardConfig();

  if (config && config.premise && typeof config.premise === 'string' && config.premise.length > 20) {
    print('  [config] Using premise from dashboard API');
    ACTIVE_PREMISE = config.premise;

    // Try to extract project name from the premise
    const projectMatch = ACTIVE_PREMISE.match(/PROJECT:\s*(.+)/i);
    if (projectMatch) {
      PROJECT_NAME = projectMatch[1].trim();
    } else if (config.projectName) {
      PROJECT_NAME = config.projectName;
    }
  } else if (config && config.projectName) {
    PROJECT_NAME = config.projectName;
    print(`  [config] Using project name from dashboard: ${PROJECT_NAME}`);
  } else {
    print('  [config] No dashboard config found, using SEED_PREMISE defaults');
    // Extract project name from SEED_PREMISE
    const projectMatch = SEED_PREMISE.match(/PROJECT:\s*(.+)/i);
    if (projectMatch) {
      PROJECT_NAME = projectMatch[1].trim();
    }
  }

  // Read chapter count and word count targets from config
  if (config && config.totalChapters && Number(config.totalChapters) >= 1 && Number(config.totalChapters) <= 100) {
    TOTAL_CHAPTERS = Number(config.totalChapters);
    print(`  [config] Chapters: ${TOTAL_CHAPTERS}`);
  }
  if (config && config.targetChapterWordCount && Number(config.targetChapterWordCount) >= 500) {
    TARGET_CHAPTER_WC = Number(config.targetChapterWordCount);
    print(`  [config] Target words/chapter: ${TARGET_CHAPTER_WC.toLocaleString()}`);
  }
  ESTIMATED_TOTAL_WC = TOTAL_CHAPTERS * TARGET_CHAPTER_WC;

  // Build the slug and paths from the project name
  PROJECT_SLUG = slugify(PROJECT_NAME);
  OUTPUT_DIR = join(process.cwd(), 'conductor-output', PROJECT_SLUG);
  STATE_FILE = join(OUTPUT_DIR, '.conductor-state.json');
  LOG_FILE = join(OUTPUT_DIR, '.youtube', 'directors-log.jsonl');

  // Fetch model name for banner
  ACTIVE_MODEL = await fetchActiveModel();
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // Initialize config before anything else (reads from dashboard or falls back)
  await initializeConfig();

  print('');
  print('  AuthorClaw Book Conductor');
  print('  ========================================');
  print(`  Project: ${PROJECT_NAME}`);
  print(`  Model: ${ACTIVE_MODEL}`);
  print(`  Target: ${TOTAL_CHAPTERS} chapters, ~${ESTIMATED_TOTAL_WC.toLocaleString()} words (${TARGET_CHAPTER_WC.toLocaleString()}/ch)`);
  print(`  Output: ${OUTPUT_DIR}`);
  print('  ========================================');

  // Create output directory
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(join(OUTPUT_DIR, 'chapters'), { recursive: true });
  await mkdir(join(OUTPUT_DIR, 'book-bible'), { recursive: true });
  await mkdir(join(OUTPUT_DIR, 'outline'), { recursive: true });
  await mkdir(join(OUTPUT_DIR, '.youtube'), { recursive: true });

  // Check for resume
  const resumed = await loadState();
  if (resumed) {
    print(`\n  Resuming from checkpoint: ${state.completedSteps.length} steps completed`);
    print(`    Words so far: ${state.wordCount.toLocaleString()}`);
    print(`    Chapters: ${state.chaptersComplete}/${TOTAL_CHAPTERS}`);
  }

  try {
    await phase0_healthCheck();
    await phase1_premise();
    await phase2_bookBible();
    await phase3_outline();
    await phase4_writing();
    await phase5_revision();
    await phase6_assembly();
    await phase7_report();

    await updateDashboard('Complete!', `${state.wordCount.toLocaleString()} words written`, {});

    print('');
    print('  ========================================');
    print(`  ${PROJECT_NAME} is COMPLETE!`);
    print(`  ${state.wordCount.toLocaleString()} words across ${TOTAL_CHAPTERS} chapters`);
    print(`  Model: ${ACTIVE_MODEL}`);
    print(`  Time: ${elapsed()}`);
    print(`  Output: ${OUTPUT_DIR}`);
    print('  ========================================');
    print('');
  } catch (error: any) {
    print(`\n  [FATAL] Pipeline error: ${error.message}`);
    print(`    State saved. Run again to resume from checkpoint.`);
    await log('Error', 'Pipeline failed', `Error: ${error.message}. Can resume from last checkpoint.`);
    await saveState();
    process.exit(1);
  }
}

main();

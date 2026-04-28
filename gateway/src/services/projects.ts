/**
 * AuthorClaw Project Engine — V4
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
 */

import { AuthorOSService } from './author-os.js';
import { ContextEngine } from './context-engine.js';
import type { SkillCatalogEntry } from '../skills/loader.js';
import { readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

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

export type ProjectType =
  | 'book-planning'
  | 'book-bible'
  | 'book-production'
  | 'deep-revision'
  | 'format-export'
  | 'book-launch'
  | 'novel-pipeline'
  | 'pipeline'
  | 'custom';

export interface Project {
  id: string;
  type: ProjectType;
  title: string;
  description: string;
  status: 'pending' | 'active' | 'paused' | 'completed' | 'failed';
  progress: number; // 0-100
  steps: ProjectStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  context: Record<string, any>;
  personaId?: string;     // Author persona assigned to this project
  preferredProvider?: string; // Override AI provider: 'gemini' | 'claude' | 'openai' | 'deepseek' | 'ollama' | null (auto)
  pipelineId?: string;    // Parent pipeline ID (if part of a pipeline)
  pipelinePhase?: number; // Phase order within pipeline (1-6)
}

export interface ProjectStep {
  id: string;
  label: string;
  skill?: string;         // Matched skill name
  toolSuggestion?: string; // Author OS tool to use
  taskType: string;        // AI router task type (for tier routing)
  prompt: string;          // The prompt to send to AI
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  result?: string;
  error?: string;
  // Novel pipeline fields:
  phase?: string;           // 'premise' | 'bible' | 'outline' | 'writing' | 'revision' | 'revision_apply' | 'assembly'
  wordCountTarget?: number; // Target words for this step (triggers multi-pass continuation)
  chapterNumber?: number;   // Chapter number for writing/revision steps
}

export interface NovelPipelineConfig {
  genre?: string;
  pov?: string;
  logline?: string;
  themes?: string;
  setting?: string;
  tone?: string;
  tense?: string;
  targetChapters?: number;        // default 25
  targetWordsPerChapter?: number; // default 3000
  protagonistName?: string;
  antagonistName?: string;
}

// ═══════════════════════════════════════════════════════════
// Project Templates — Pre-built step sequences per project type
// ═══════════════════════════════════════════════════════════

interface ProjectTemplate {
  type: ProjectType;
  label: string;
  description: string;
  steps: Array<{
    label: string;
    skill?: string;
    toolSuggestion?: string;
    taskType: string;
    promptTemplate: string; // Uses {{title}}, {{description}}, {{genre}}, etc.
    phase?: string;           // Optional phase marker (e.g. 'revision_apply')
    wordCountTarget?: number; // Optional target word count (triggers continuation)
    chapterNumber?: number;   // Optional chapter number
  }>;
}

// Valid task types that the AI router understands (for planProject prompt)
const TASK_TYPE_MAP: Record<string, string> = {
  general: 'Basic tasks, chat, simple questions',
  research: 'Web research, fact-finding',
  creative_writing: 'Prose writing, chapters, scenes',
  revision: 'Editing, rewriting, feedback',
  style_analysis: 'Voice/style matching',
  marketing: 'Blurbs, pitches, ads',
  outline: 'Story structure, beat sheets',
  book_bible: 'World building, characters',
  consistency: 'Cross-chapter analysis',
  final_edit: 'Final polish, proofreading',
};

const PROJECT_TEMPLATES: ProjectTemplate[] = [
  // ═══════════════════════════════════════════════════════════
  // Template 1: Book Planning
  // ═══════════════════════════════════════════════════════════
  {
    type: 'book-planning',
    label: 'Book Planning',
    description: 'Market analysis, premise development, characters, chapter outline, and synopsis',
    steps: [
      {
        label: 'Market & genre analysis',
        skill: 'research',
        taskType: 'research',
        promptTemplate: `Analyze the current market for this type of book: {{description}}

Research and report on:
1. **Genre landscape**: Top-selling comparable titles in this genre/subgenre
2. **Reader expectations**: What tropes, conventions, and beats does this genre demand?
3. **Market gaps**: What's underserved? Where's the opportunity?
4. **Comp titles**: Identify 3-5 comparable titles with why they're relevant
5. **Target audience**: Demographics, reading habits, where they discover books
6. **Commercial viability**: Honest assessment of market potential

Be specific and actionable. This informs every decision that follows.`,
      },
      {
        label: 'Develop premise',
        skill: 'premise',
        taskType: 'general',
        promptTemplate: `Develop a commercially viable premise for: {{description}}

Using the market analysis, create:
1. **Logline**: 1-2 sentences that sell the book
2. **What-If question**: The central hook
3. **Core conflict**: Internal and external
4. **Stakes**: What happens if the protagonist fails? (personal, professional, global)
5. **Theme statement**: The book's deeper argument about life
6. **Unique hook**: What makes THIS book stand out from the comp titles?
7. **Genre promise**: What emotional experience are we delivering?

Make this premise commercially compelling AND creatively exciting.`,
      },
      {
        label: 'Character profiles',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: `Create detailed character profiles for: {{description}}

Build out:
**Protagonist**: Full name, age, backstory, motivation (want vs need), fatal flaw, emotional wound, strengths, appearance, speech patterns, character arc
**Antagonist**: Motivation, backstory, why they believe they're right, how they challenge the protagonist
**3-4 Supporting characters**: Name, role, relationship to protagonist, how they advance/challenge the arc

Each character should feel real — contradictions, desires, fears. Write 800+ words total.`,
      },
      {
        label: 'Chapter-by-chapter outline',
        skill: 'outline',
        taskType: 'outline',
        promptTemplate: `Create a detailed chapter-by-chapter outline for: {{description}}

For each chapter include:
- **Chapter number & title**
- **POV character**
- **Key beats** (3-5 per chapter)
- **Turning points** and revelations
- **Tension level** (1-10)
- **Chapter ending hook**

Structure using three-act beats:
- Act 1 (25%): Setup, inciting incident, debate/refusal
- Act 2A (25%): Rising action, fun & games, midpoint shift
- Act 2B (25%): Complications, all-is-lost moment
- Act 3 (25%): Climax sequence, resolution

Target 20-30 chapters. Number EVERY chapter.`,
      },
      {
        label: 'Synopsis generation',
        skill: 'outline',
        taskType: 'general',
        promptTemplate: `Generate professional synopses for: {{description}}

Create two versions:
1. **One-page synopsis** (~500 words): Complete story arc including the ending. Professional query format.
2. **Three-page synopsis** (~1500 words): Expanded with character arcs, key scenes, and emotional beats.

Both should:
- Reveal the entire plot (including ending — this is for industry professionals)
- Show the character's emotional journey
- Demonstrate clear story structure
- Be written in present tense, third person
- Feel compelling to read, not just dutiful`,
      },
      {
        label: 'Review & refine plan',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Review the complete book plan we've built. Check for:

1. **Plot holes**: Any logical gaps in the outline?
2. **Character consistency**: Do motivations and arcs make sense?
3. **Pacing issues**: Any dead zones or rushed sections in the outline?
4. **Theme coherence**: Does every subplot reinforce the theme?
5. **Commercial viability**: Does this match the market analysis findings?
6. **Genre compliance**: Are all genre promises being fulfilled?

Provide specific improvements, not vague suggestions. Reference chapter numbers and character names.`,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  // Template 2: Book Bible
  // ═══════════════════════════════════════════════════════════
  {
    type: 'book-bible',
    label: 'Book Bible',
    description: 'World-building, character bible, continuity tracker, themes, and style reference',
    steps: [
      {
        label: 'World-building document',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: `Create a comprehensive world-building document for: {{description}}

Include:
1. **Setting**: Physical environment, geography, climate, key locations with sensory details
2. **Time period**: When does this take place? Historical/futuristic context
3. **Social structures**: Power dynamics, social classes, political systems
4. **Rules**: Laws of physics/magic, technology, what's possible and what isn't
5. **Culture**: Customs, beliefs, languages, food, entertainment
6. **History**: Key events that shaped this world before the story begins
7. **Economy**: How do people earn a living? What's valuable?
8. **Daily life**: What does an ordinary day look like for ordinary people?

Write 1000+ words. Be specific enough that a writer could maintain consistency across 80,000 words.`,
      },
      {
        label: 'Character bible',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: `Create deep character profiles for: {{description}}

For EACH major character (protagonist, antagonist, 3-4 supporting):
- **Full name** and any nicknames
- **Age, appearance** (specific: eye color, hair, height, distinguishing marks)
- **Personality**: Myers-Briggs type, enneagram, core fear, core desire
- **Backstory**: 200+ words of formative experiences
- **Voice**: Speech patterns, vocabulary level, verbal tics, sentence style
- **Arc**: Where they start → what changes → where they end
- **Relationships**: Map to other characters with dynamic description
- **Secrets**: What are they hiding? From whom?

Also create a **relationship web** showing how all characters connect.`,
      },
      {
        label: 'Series continuity tracker',
        skill: 'book-bible',
        taskType: 'consistency',
        promptTemplate: `Create a continuity tracking document for: {{description}}

This is the master reference for maintaining consistency. Include:
1. **Character tracking sheet**: Physical details, introduced in chapter X, status (alive/dead/missing)
2. **Timeline**: Day-by-day chronology of events in the story
3. **Location details**: Room layouts, distances between places, what's where
4. **Object tracking**: Important items — who has them, where they are
5. **Plot thread tracker**: Every promise/setup and where it's resolved
6. **Name registry**: All proper nouns with consistent spelling
7. **Rules reference**: Quick-lookup for world rules (magic costs, tech limits, etc.)

Format as a reference guide a writer can quickly scan while writing.`,
      },
      {
        label: 'Theme & motif guide',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: `Create a theme and motif guide for: {{description}}

Analyze and document:
1. **Central theme**: What argument is this book making about human nature/life?
2. **Supporting themes**: 2-3 secondary themes that reinforce the central one
3. **Recurring motifs**: Images, objects, or situations that appear repeatedly
4. **Symbolic elements**: What represents what? (settings, weather, objects, colors)
5. **Theme per subplot**: How each subplot explores a facet of the theme
6. **Thematic arc**: How the theme develops across the story's structure
7. **Motif placement guide**: Where each motif should appear for maximum impact

This guide ensures every scene serves the deeper meaning of the book.`,
      },
      {
        label: 'Style & tone reference',
        skill: 'style-clone',
        taskType: 'style_analysis',
        promptTemplate: `Create a style and tone reference guide for: {{description}}

Document the writing voice this book requires:
1. **Tone**: Dark? Humorous? Lyrical? Sharp? Warm? Describe with examples
2. **Prose style**: Sentence length tendencies, vocabulary level, rhythm
3. **POV approach**: Deep POV? Omniscient? How close to the character's thoughts?
4. **Tense**: Past or present? Why?
5. **Dialogue style**: Naturalistic? Stylized? Snappy? Formal?
6. **Description approach**: Lush and detailed? Sparse and punchy?
7. **Sample paragraph**: Write a 200-word example paragraph in the target voice
8. **Voice DON'Ts**: What should the writing NOT sound like?

If an author persona is assigned, integrate their voice profile into this guide.`,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  // Template 3: Book Production (stub — chapters generated dynamically)
  // ═══════════════════════════════════════════════════════════
  {
    type: 'book-production',
    label: 'Book Production',
    description: 'Write chapters sequentially with full context injection — write, self-review, and compile',
    steps: [], // Dynamic: chapters auto-generated based on config (like novel-pipeline writing phase)
  },

  // ═══════════════════════════════════════════════════════════
  // Template 4: Deep Revision (21 steps, 3 passes)
  // ═══════════════════════════════════════════════════════════
  {
    type: 'deep-revision',
    label: 'Deep Revision',
    description: '21-step, 3-pass manuscript revision — macro (structural), medium (scene-level), micro (line-level) + beta reader panel',
    steps: [
      // ── Pass 1: Macro / Structural (7 steps) ──
      {
        label: 'Plot structure analysis',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Analyze the plot structure of this manuscript:

**Manuscript**: "{{title}}" — {{description}}

Evaluate:
1. **Three-act structure compliance**: Is there a clear setup, confrontation, and resolution?
2. **Inciting incident**: When does it occur? Is it strong enough? Too early/late?
3. **Midpoint shift**: Is there a genuine reversal or revelation at the midpoint?
4. **All-is-lost moment**: Does the 75% mark deliver real despair?
5. **Climax**: Is it earned? Does it resolve the central conflict?
6. **Resolution**: Is it satisfying without being too neat?
7. **Hero's journey beats**: Which archetypes are present? Which are missing?

Rate structural integrity: 1-10. Provide specific chapter references for every issue.`,
      },
      {
        label: 'Pacing audit',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Create a chapter-by-chapter pacing heatmap for:

**Manuscript**: "{{title}}" — {{description}}

For EACH chapter: Tension (1-10) | Pacing (Too Fast/Fast/Good/Slow/Draggy) | Scene types | Energy

Then analyze:
- Where are the energy valleys? Should chapters be cut or combined?
- Do climactic moments land with proper setup?
- Is the action-to-reflection ratio balanced?
- Are chapter lengths consistent? Do variations serve the story?
- Do the first 3 chapters build enough momentum?

End with top 3 pacing fixes, prioritized by impact.`,
      },
      {
        label: 'Character arc consistency',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Check character arc consistency across:

**Manuscript**: "{{title}}" — {{description}}

For each major character:
1. **Arc mapping**: Where they start → key turning points → where they end
2. **Growth evidence**: What specific scenes show change?
3. **Regression moments**: Are setbacks believable?
4. **Arc completion**: Does the ending deliver on the character's promise?
5. **Motivation consistency**: Do they ever act out of character for plot convenience?

Flag any character who doesn't change, changes too abruptly, or acts inconsistently.`,
      },
      {
        label: 'Theme coherence review',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Analyze thematic coherence in:

**Manuscript**: "{{title}}" — {{description}}

1. **Central theme identification**: What is this book really about beneath the plot?
2. **Theme in subplots**: Does each subplot reinforce or contrast the central theme?
3. **Thematic drift**: Are there sections where the theme gets lost?
4. **Theme in character arcs**: How does each character's journey explore the theme?
5. **Thematic resolution**: Does the ending make a clear statement about the theme?
6. **Heavy-handedness**: Are there moments where theme becomes preachy?`,
      },
      {
        label: 'World-building continuity scan',
        skill: 'revise',
        taskType: 'consistency',
        promptTemplate: `Run a world-building continuity scan on:

**Manuscript**: "{{title}}" — {{description}}

Check for:
1. **Setting contradictions**: Room layouts, geography, distances between locations
2. **Rule violations**: Magic/tech/social rules that get broken without explanation
3. **Timeline errors**: Days, dates, seasons, time-of-day inconsistencies
4. **Character knowledge**: Does anyone know something they shouldn't?
5. **Dead/missing characters**: Anyone disappears without explanation?
6. **Object tracking**: Important items that appear/disappear without logic

For each issue: where it appears, what the contradiction is, and how to fix it. Organized by severity.`,
      },
      {
        label: 'Stakes escalation verification',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Verify that stakes escalate properly in:

**Manuscript**: "{{title}}" — {{description}}

Analyze:
1. **Personal stakes**: What does the protagonist personally lose if they fail? Does this deepen?
2. **External stakes**: How do consequences widen over the story?
3. **Urgency**: Is there a ticking clock? Does time pressure increase?
4. **Cost of action**: Does pursuing the goal cost more as the story progresses?
5. **Point of no return**: When can the protagonist no longer walk away?
6. **Stakes at climax**: Are the final stakes the highest they've been?

Flag any moment where stakes plateau, decrease, or feel artificial.`,
      },
      {
        label: 'Subplot tracking & resolution',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Track all subplots in:

**Manuscript**: "{{title}}" — {{description}}

For each subplot found:
1. **Introduction**: When and how is it introduced?
2. **Purpose**: How does it serve the main plot or theme?
3. **Key beats**: Major developments (with chapter references)
4. **Resolution**: How and when is it resolved?
5. **Dropped threads**: Was anything set up but never paid off?

Also check:
- Are any subplots redundant? Do two accomplish the same thing?
- Are any subplots underdeveloped?
- Do subplots interfere with pacing?`,
      },

      // ── Pass 2: Medium / Scene-Level (7 steps) ──
      {
        label: 'Dialogue authenticity pass',
        skill: 'dialogue',
        taskType: 'revision',
        promptTemplate: `Perform a dialogue authenticity audit on:

**Manuscript**: "{{title}}" — {{description}}

1. **Voice distinctiveness**: Rate each major character's voice uniqueness (1-10). Can you tell them apart?
2. **Info-dumping**: Flag "As you know, Bob..." moments
3. **Subtext quality**: Best and worst examples of saying vs meaning
4. **Speech patterns**: Note unique patterns per character
5. **Tag vs action beat ratio**: Are they balanced?
6. **Emotional authenticity**: Do emotional conversations ring true?

Suggest rewrites for the 5 worst dialogue passages.`,
      },
      {
        label: 'Show-don\'t-tell audit',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Scan for show vs tell issues in:

**Manuscript**: "{{title}}" — {{description}}

Flag: emotional telling, character description telling, backstory dumps, motivation telling, atmosphere telling.

For the 10 worst offenders: quote the original → write a "showing" rewrite → explain why it's stronger.

Note: some telling is FINE. Only flag cases where showing would genuinely improve the experience.`,
      },
      {
        label: 'Scene tension & conflict check',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Check every scene for tension and conflict:

**Manuscript**: "{{title}}" — {{description}}

For each scene:
- **Goal**: What does the POV character want in this scene?
- **Obstacle**: What's preventing them from getting it?
- **Stakes**: What happens if they fail?
- **Outcome**: Do they succeed, fail, or get a complicated result?

Flag any scene where:
- The character has no goal
- There's no opposition
- Nothing changes by the end
- The tension is purely internal with no external manifestation

These are scenes that may need to be cut or strengthened.`,
      },
      {
        label: 'Transition smoothness review',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Review all transitions in:

**Manuscript**: "{{title}}" — {{description}}

Check:
1. **Chapter transitions**: Does each chapter end with a hook and begin with orientation?
2. **Scene breaks**: Are time/location jumps clear?
3. **POV shifts**: If multi-POV, are switches smooth and clearly signaled?
4. **Timeline jumps**: Are flashbacks/flash-forwards handled well?
5. **Tone shifts**: Do tonal changes feel intentional or jarring?

Flag the 5 roughest transitions and suggest smoother alternatives.`,
      },
      {
        label: 'Emotional beat mapping',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Map the emotional journey in:

**Manuscript**: "{{title}}" — {{description}}

Chapter by chapter, identify:
- **Dominant emotion**: What should the reader feel?
- **Emotional high point**: The strongest moment
- **Emotional low point**: The most vulnerable/sad moment
- **Emotional variety**: Does each chapter offer a different emotional flavor?

Then assess:
- Is there enough emotional variety or does it feel monotone?
- Do big emotional moments land? Are they properly set up?
- Is the emotional climax the strongest moment in the book?
- Are there enough quiet, intimate moments between action?`,
      },
      {
        label: 'Sensory detail enhancement',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Audit sensory details in:

**Manuscript**: "{{title}}" — {{description}}

1. **Sense inventory**: Which of the 5 senses are used? Which are underused?
2. **Visual-heavy check**: Is the writing too visual with not enough sound, smell, touch, taste?
3. **Key scenes**: Are pivotal scenes richly grounded in sensory experience?
4. **Setting atmosphere**: Do locations have distinctive sensory signatures?
5. **Character-filtered**: Are sensory details filtered through the POV character's personality?

Identify 5-10 scenes that would benefit most from sensory enrichment and suggest specific details.`,
      },
      {
        label: 'Info-dump & exposition detection',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Scan for info-dumps and exposition problems in:

**Manuscript**: "{{title}}" — {{description}}

Flag every instance of:
1. **Backstory dumps**: Paragraphs of history interrupting the action
2. **World-building lectures**: Characters explaining things the reader doesn't need yet
3. **As-you-know-Bob dialogue**: Characters telling each other things they already know
4. **Mirror descriptions**: Character describing their own appearance while looking in a mirror
5. **Prologue info-dump**: Does the opening front-load too much context?

For each: quote the passage, explain why it's a problem, and suggest how to weave the information in naturally (through action, dialogue subtext, or gradual revelation).`,
      },

      // ── Pass 3: Micro / Line-Level (5 steps) ──
      {
        label: 'Copy edit pass',
        skill: 'revise',
        taskType: 'final_edit',
        promptTemplate: `Perform a copy edit pass on:

**Manuscript**: "{{title}}" — {{description}}

Check for:
- Grammar errors
- Punctuation issues (especially dialogue punctuation)
- Spelling mistakes
- Homophone errors (their/there/they're, its/it's)
- Subject-verb agreement
- Tense consistency
- Comma splices and run-on sentences

List all errors found with chapter/location and correction.`,
      },
      {
        label: 'Line edit pass',
        skill: 'revise',
        taskType: 'final_edit',
        promptTemplate: `Perform a line edit pass on:

**Manuscript**: "{{title}}" — {{description}}

Focus on:
- **Prose rhythm**: Sentence length variety, flow, musicality
- **Word choice**: Precision, specificity, avoiding generic words
- **Verb strength**: Replace weak verbs (was, had, got) with vivid ones
- **Clarity**: Any confusing sentences or ambiguous references?
- **Redundancy**: Phrases that say the same thing twice

Show 10 before/after examples of line-level improvements.`,
      },
      {
        label: 'Repetition finder',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Find overused words and phrases in:

**Manuscript**: "{{title}}" — {{description}}

Report on:
1. **Overused words**: Adverbs, weak verbs, filler words with frequency
2. **Crutch phrases**: Repeated constructions the author leans on
3. **AI-sounding words**: delve, tapestry, testament, visceral, nuanced, multifaceted, resonate, paradigm, myriad, beacon, realm
4. **Repetitive openers**: Sentence-starting patterns
5. **Passive voice frequency** (target: <10%)
6. **Adverb density** (target: <5 per 1000 words)

For each: word/phrase, frequency, example, and suggested alternatives.`,
      },
      {
        label: 'Crutch word elimination',
        skill: 'revise',
        taskType: 'final_edit',
        promptTemplate: `Eliminate crutch words from:

**Manuscript**: "{{title}}" — {{description}}

Specific targets:
- **Just, really, very, quite, actually, basically, literally** — flag every instance, suggest which to cut
- **Suddenly** — almost always cuttable, show the action instead
- **Felt/feeling** — usually telling, show the sensation
- **Started to / began to** — just do the action
- **Seemed / appeared** — be more direct
- **That** — flag unnecessary instances
- **Nodded/shrugged/sighed** — overused physical beats

Provide a prioritized cut list with estimated word savings.`,
      },
      {
        label: 'Sensitivity read',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Perform a sensitivity read on:

**Manuscript**: "{{title}}" — {{description}}

Check for:
1. **Cultural representation**: Are characters from diverse backgrounds portrayed authentically?
2. **Stereotypes**: Any characters reduced to stereotypes?
3. **Language sensitivity**: Outdated or potentially offensive terms?
4. **Power dynamics**: Are marginalized characters given agency?
5. **Historical accuracy**: If set in a real period/place, are cultural details accurate?
6. **Unconscious bias**: Any patterns in which characters are villains, heroes, or victims?

Note: This is a preliminary read. For publication, a human sensitivity reader is recommended. Flag potential issues for professional review.`,
      },

      // ── Final: Beta Readers + Synthesis ──
      {
        label: 'Beta reader panel',
        skill: 'beta-reader',
        taskType: 'revision',
        promptTemplate: `You are a panel of 5 beta readers with different perspectives. Read and respond:

**Manuscript**: "{{title}}" — {{description}}

**Reader 1 — The Casual Reader**: Gut reactions, where you got bored, enjoyment rating 1-10
**Reader 2 — The Genre Expert**: Genre compliance, trope execution, market positioning, rating 1-10
**Reader 3 — The Harsh Critic**: Plot holes, weak motivations, clichés, the single biggest problem
**Reader 4 — The Target Reader**: Emotional journey, favorite scenes, would you recommend? Rating 1-10
**Reader 5 — The Romance/Thriller Super-Fan**: What made you keep reading? What almost made you stop? Pre-order the sequel?

Keep each reader's response to 200-300 words. Be specific with chapter references.`,
      },
      {
        label: 'Final revision action plan',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: `Synthesize ALL 20 prior revision passes into a final action plan:

**Manuscript**: "{{title}}" — {{description}}

Create:
1. **Overall Grade**: A-F with justification
2. **Top 5 Strengths**: What to keep and amplify
3. **Critical Fixes** (5-7 must-do items, ranked by priority)
4. **Important Improvements** (5-7 should-do items)
5. **Polish Items** (3-5 nice-to-have refinements)
6. **Revision Roadmap**: Pass 1 → Pass 2 → Pass 3 order of operations
7. **Market Readiness**: Ready for beta readers? Agent? Self-publishing?
8. **Encouraging Close**: What makes this book worth finishing

Make every recommendation specific and actionable with chapter references.`,
      },

      // ══ Pass 4: APPLY the revisions — produce a REAL revised manuscript ══
      // These steps (phase: 'revision_apply') actually rewrite the manuscript
      // instead of just analyzing it. Without these steps, users got 21
      // analysis reports and no revised book.
      {
        label: 'Apply macro revisions (full manuscript rewrite)',
        skill: 'revise',
        taskType: 'revision',
        phase: 'revision_apply',
        promptTemplate: `Rewrite the FULL uploaded manuscript applying the Pass 1 (macro/structural) revision notes from prior steps.

**Manuscript**: "{{title}}" — {{description}}

You have access to the FULL uploaded manuscript plus the analyses from 7 prior macro passes covering plot structure, pacing, character arcs, theme, world-building, stakes, and subplots.

## YOUR TASK
Output the COMPLETE revised manuscript — every chapter, in full — with the macro/structural fixes applied:

- Tighten plot structure where analysis flagged weakness
- Fix pacing sags; cut or combine chapters only if analysis clearly said to
- Strengthen character arcs; add missing growth beats
- Reinforce theme where it drifted
- Resolve continuity/world-building contradictions
- Escalate stakes where they plateaued
- Close dropped subplot threads

## CRITICAL OUTPUT RULES
1. Output the ENTIRE revised manuscript, start to finish. Don't summarize. Don't say "Chapter 1 revised version would go here".
2. Preserve chapter structure. Start each chapter with "# Chapter N: Title" or "## Chapter N".
3. Write actual prose, not bullet points or change logs.
4. Keep the author's voice. Only change what the analysis specifically flagged.
5. If the manuscript is very long and you run out of space, stop at a chapter boundary — the system will ask you to continue from there.
6. Do NOT include any meta-commentary like "I revised this by...". Output ONLY the manuscript itself.`,
      },
      {
        label: 'Apply scene-level revisions (full manuscript rewrite)',
        skill: 'revise',
        taskType: 'revision',
        phase: 'revision_apply',
        promptTemplate: `Take the Pass-1-revised manuscript from the previous step and rewrite it AGAIN, this time applying Pass 2 (scene-level) revision notes.

**Manuscript**: "{{title}}" — {{description}}

## YOUR INPUT
- The Pass-1-revised manuscript from the previous "Apply macro revisions" step (in your context above)
- 7 scene-level analyses covering dialogue, show-vs-tell, scene tension, transitions, emotional beats, sensory detail, info-dumps

## YOUR TASK
Rewrite every chapter applying scene-level fixes:

- Tighten and distinctify dialogue; eliminate "as you know Bob" exposition
- Convert telling to showing for emotional beats the analysis flagged
- Give each scene a clear goal/obstacle/stakes/outcome
- Smooth the roughest transitions (flagged in prior analysis)
- Add sensory detail to pivotal scenes
- Break up info-dumps into action/dialogue/subtext

## CRITICAL OUTPUT RULES
1. Output the ENTIRE revised manuscript, not just flagged sections.
2. Preserve chapter structure.
3. Do NOT regress Pass-1 improvements. Keep the macro fixes from the prior step.
4. If you run out of space, stop at a chapter boundary — the system will continue from there.
5. Output ONLY the manuscript itself — no commentary.`,
      },
      {
        label: 'Apply line-level revisions (full manuscript rewrite)',
        skill: 'revise',
        taskType: 'final_edit',
        phase: 'revision_apply',
        promptTemplate: `Take the Pass-2-revised manuscript from the previous step and rewrite it ONE MORE TIME, this time applying Pass 3 (line-level / copy-edit) polish.

**Manuscript**: "{{title}}" — {{description}}

## YOUR INPUT
- The Pass-2-revised manuscript from the previous step (in your context above)
- 5 line-level analyses covering copy edits, line edits, repetition, crutch words, sensitivity

## YOUR TASK
Produce the FINAL polished manuscript by applying line-level fixes:

- Fix grammar, punctuation, spelling, homophone errors
- Tighten prose rhythm; vary sentence length
- Strengthen weak verbs; cut redundant phrases
- Remove crutch words flagged in prior analysis (just, really, very, actually, suddenly, started to, began to, felt, seemed)
- Cut overused adverbs; keep the ones that earn their place
- Address sensitivity concerns (where flagged) without losing the author's voice

## CRITICAL OUTPUT RULES
1. Output the ENTIRE polished manuscript.
2. Preserve all Pass-1 and Pass-2 improvements.
3. Preserve chapter structure with "# Chapter N: Title" or "## Chapter N" headers.
4. If you run out of space, stop at a chapter boundary — the system will continue.
5. This is the FINAL version. Make it publishable.
6. Output ONLY the manuscript — no commentary, no change logs.`,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  // Template 5: Format & Export
  // ═══════════════════════════════════════════════════════════
  {
    type: 'format-export',
    label: 'Format & Export',
    description: 'Generate front/back matter and export as DOCX, EPUB, and PDF — KDP-ready formatting',
    steps: [
      {
        label: 'Generate front matter',
        skill: 'format',
        taskType: 'general',
        promptTemplate: `Generate professional front matter for: {{description}}

Create:
1. **Title page**: Title, subtitle (if any), author name
2. **Copyright page**: Standard indie publishing copyright notice with year, all rights reserved, ISBN placeholder, edition info
3. **Dedication**: A placeholder dedication (author can customize)
4. **Table of Contents**: Auto-generated from chapter headings (placeholder — will be filled during export)
5. **Epigraph** (optional): Suggest a thematic quote if appropriate

Format each as clean markdown sections with clear dividers.`,
      },
      {
        label: 'Generate back matter',
        skill: 'format',
        taskType: 'marketing',
        promptTemplate: `Generate professional back matter for: {{description}}

Create:
1. **Author bio**: Professional 3rd-person bio (use persona bio if available, otherwise create a template)
2. **Also By section**: List of other titles (from persona's alsoBy list if available, otherwise placeholder)
3. **Newsletter CTA**: "Join [Author]'s readers list for exclusive content, early access, and bonus scenes. Sign up at: [URL]"
4. **Acknowledgments**: Template with common categories (agent, editor, family, readers)
5. **Preview**: First chapter teaser of next book (placeholder)

Format each as clean markdown. Keep the tone professional and genre-appropriate.`,
      },
      {
        label: 'Compile & export DOCX',
        skill: 'format',
        taskType: 'general',
        promptTemplate: `Compile the manuscript with front and back matter into a professional DOCX format for: {{description}}

The export system will:
- Combine front matter + chapters + back matter
- Apply KDP-standard formatting (chapter headings, scene breaks, page breaks)
- Set professional typography (serif font, justified text, proper margins)
- Generate downloadable DOCX file

Confirm the manuscript is ready for export. List the chapter count, estimated word count, and any missing sections that should be addressed before publishing.`,
      },
      {
        label: 'Compile & export EPUB',
        skill: 'format',
        taskType: 'general',
        promptTemplate: `Generate EPUB export for: {{description}}

The export system will:
- Create valid EPUB3 with proper metadata (title, author, description)
- Split chapters into individual XHTML files
- Include cover image placeholder
- Generate navigation TOC
- Apply clean reading CSS

Confirm EPUB readiness. Note any elements that may not render well on e-readers.`,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  // Template 6: Book Launch
  // ═══════════════════════════════════════════════════════════
  {
    type: 'book-launch',
    label: 'Book Launch',
    description: 'Back cover blurb, Amazon description, keywords, categories, ad copy, and social media posts',
    steps: [
      {
        label: 'Back cover blurb',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: `Write compelling book blurbs for: {{description}}

Create 3 versions:
1. **Short tagline** (1 sentence): The elevator pitch
2. **Back cover blurb** (150-200 words): The hook, the setup, the stakes, the question
3. **Long blurb** (250-300 words): Expanded version with more character and world detail

Each should:
- Hook from the first line
- Convey genre and tone immediately
- End with a compelling question or stakes statement
- NEVER reveal the ending
- Match the expectations of the target genre audience`,
      },
      {
        label: 'Amazon book description',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: `Create an Amazon-optimized book description for: {{description}}

Format with HTML tags Amazon supports:
- <b>bold</b> for emphasis
- <br> for line breaks
- <i>italic</i> for titles and emphasis

Structure:
1. **Opening hook** (bold, attention-grabbing)
2. **Character introduction** (who are they, what do they want)
3. **Conflict & stakes** (what stands in the way, what happens if they fail)
4. **Genre signals** (tropes, tone, comp titles: "Perfect for fans of...")
5. **Call to action** (bold: "Buy now" or "Start reading today")

Also include a review quote template: "___ ★★★★★" format.`,
      },
      {
        label: 'Amazon categories & keywords',
        skill: 'research',
        taskType: 'research',
        promptTemplate: `Research Amazon categories and keywords for: {{description}}

Provide:
1. **7 Keywords/phrases** (max 50 chars each): Research-backed keywords that readers search for. Mix specific tropes + genre terms + emotional hooks
2. **2 BISAC categories**: The best-fit primary and secondary categories
3. **Amazon browse categories**: 2-3 specific Amazon category paths (e.g., Kindle Store > Romance > Contemporary > New Adult)
4. **BISAC codes**: The alphanumeric codes for the chosen categories

Explain WHY each keyword/category was chosen — what search behavior does it target?`,
      },
      {
        label: 'Ad copy generation',
        skill: 'ad-copy',
        taskType: 'marketing',
        promptTemplate: `Create advertising copy for: {{description}}

**Amazon Ads (AMS)**:
- 3 headline variants (150 chars max each)
- Focus on genre keywords and emotional hooks

**Facebook/Meta Ads**:
- 2 primary text variants (short, punchy)
- 2 headline variants
- Suggested audience targeting (interests, lookalike authors)

**BookBub Featured Deal**:
- 1 description (optimal for BookBub's format and audience)
- Suggested deal price strategy

Each variant should use a different angle: emotion, trope, comp title, question, urgency.`,
      },
      {
        label: 'Social media launch posts',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: `Create social media launch content for: {{description}}

**Instagram/BookStagram** (3 posts):
- Cover reveal post (caption + hashtags)
- Launch day post
- "Why I wrote this book" personal post

**Twitter/X** (5 tweets):
- Launch announcement
- Logline tweet
- Character introduction thread starter
- Reader comp ("If you loved X, you'll love...")
- Quote from the book (with formatting)

**TikTok/BookTok** (2 video concepts):
- Concept + script outline for each

**Email newsletter**:
- Launch announcement email (subject line + body)

Include relevant hashtags for each platform.`,
      },
      {
        label: 'Launch checklist & timeline',
        skill: 'format',
        taskType: 'general',
        promptTemplate: `Create a book launch checklist and timeline for: {{description}}

**Pre-Launch (4-6 weeks before)**:
- ARC distribution, cover reveal timing, pre-order setup

**Launch Week**:
- Day-by-day social media schedule
- Email sequence
- Ad activation timeline

**Post-Launch (2-4 weeks after)**:
- Review solicitation, ad optimization, newsletter follow-up

Include specific actionable items with dates relative to launch day (L-30, L-14, L-7, L-Day, L+7, etc.)`,
      },
      {
        label: 'Book cover concepts',
        skill: 'book-launch',
        taskType: 'marketing',
        promptTemplate: `Generate 2 book cover concept ideas for: {{description}}

For each concept provide:
1. **Visual description** — Detailed scene, composition, imagery, key visual elements
2. **Typography recommendation** — Font style suggestions, title placement (top/center/bottom), author name placement
3. **Color palette** — 3-5 hex color codes with mood/emotion reasoning
4. **Comparable covers** — 2-3 bestselling covers in this genre with a similar style
5. **AI image generation prompt** — A detailed, ready-to-use prompt for generating the cover art with AI (describe the image only, no text)

Mark the recommended concept clearly. Focus on genre-appropriate design that would stand out in Amazon thumbnail size.`,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════
  // Novel Pipeline (kept from V3 — auto-generates 30+ steps)
  // ═══════════════════════════════════════════════════════════
  {
    type: 'novel-pipeline',
    label: 'Full Novel Pipeline',
    description: 'Write a complete novel from premise to final manuscript — premise, characters, world, outline, chapters, revision, and assembly',
    steps: [], // 30+ steps are auto-generated by createNovelPipeline()
  },
];

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
  private contextEngine?: ContextEngine;
  private coreLessonsCache: string | null = null;
  private coreLessonsCacheTime = 0;
  private stateFilePath: string;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(authorOS?: AuthorOSService, rootDir?: string) {
    this.authorOS = authorOS || null;
    this.rootDir = rootDir || process.cwd();
    this.stateFilePath = join(this.rootDir, 'workspace', '.config', 'projects-state.json');
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
        console.error('  ⚠ Failed to persist project state:', err);
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
        for (const p of state.projects) {
          this.projects.set(p.id, p);
        }
        console.log(`  ✓ Restored ${state.projects.length} projects from disk`);
      }
    } catch (err) {
      console.error('  ⚠ Failed to load project state:', err);
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

  // ── Novel Pipeline ──

  /**
   * Create a full novel pipeline project with 30+ steps covering all phases:
   * premise → book bible → outline → writing → revision → assembly
   */
  createNovelPipeline(title: string, description: string, config: NovelPipelineConfig = {}): Project {
    const id = `project-${this.nextId++}`;
    const now = new Date().toISOString();

    const chapters = Math.min(Math.max(config.targetChapters || 25, 1), 200);
    const wordsPerChapter = Math.max(config.targetWordsPerChapter || 3000, 100);

    // Build premise context from config fields
    const premiseContext = [
      config.logline && `Logline: ${config.logline}`,
      config.genre && `Genre: ${config.genre}`,
      config.setting && `Setting: ${config.setting}`,
      config.tone && `Tone: ${config.tone}`,
      config.pov && `POV: ${config.pov}`,
      config.tense && `Tense: ${config.tense}`,
      config.themes && `Themes: ${config.themes}`,
      config.protagonistName && `Protagonist: ${config.protagonistName}`,
      config.antagonistName && `Antagonist: ${config.antagonistName}`,
    ].filter(Boolean).join('\n');

    const premiseBlock = premiseContext
      ? `\n\nProject Configuration:\n${premiseContext}`
      : '';

    // Calculate structural beats for outline
    const setupEnd = Math.max(Math.round(chapters * 0.12), 1);
    const incitingEnd = Math.max(Math.round(chapters * 0.20), setupEnd + 1);
    const midpoint = Math.round(chapters * 0.50);
    const twist75 = Math.round(chapters * 0.75);
    const climaxStart = chapters - 2;
    const climaxEnd = chapters - 1;

    const steps: ProjectStep[] = [];
    let stepNum = 0;

    const addStep = (
      label: string,
      phase: string,
      taskType: string,
      prompt: string,
      opts: { skill?: string; wordCountTarget?: number; chapterNumber?: number } = {}
    ) => {
      stepNum++;
      steps.push({
        id: `${id}-step-${stepNum}`,
        label,
        phase,
        taskType,
        prompt,
        status: 'pending',
        skill: opts.skill,
        wordCountTarget: opts.wordCountTarget,
        chapterNumber: opts.chapterNumber,
      });
    };

    // ── Phase: Premise (2 steps) ──
    addStep('Develop premise', 'premise', 'general',
      `Develop this story concept into a complete premise for "${title}":${premiseBlock}\n\n${description}\n\nCreate:\n- A refined logline (1-2 sentences)\n- The central What-If question\n- Protagonist's want vs need\n- The core conflict\n- Stakes: personal, professional, and global\n- Theme statement\n- 3 comparable titles\n\nWrite a thorough, detailed response. Do not abbreviate.`,
      { skill: 'premise' }
    );

    addStep('Refine premise', 'premise', 'general',
      `Refine the "${title}" premise further. Using everything from the initial premise, add:\n- The antagonist's motivation and logic\n- The ticking clock: what specific deadline creates urgency?\n- 3 possible plot twists (one at midpoint, one at 75%, one final revelation)\n- The emotional core: what personal loss or wound drives the protagonist?\n\nWrite a thorough, detailed response.`,
      { skill: 'premise' }
    );

    // ── Phase: Book Bible (6 steps) ──
    addStep('Protagonist profile', 'bible', 'book_bible',
      `Create a detailed protagonist profile for "${title}".\n\nInclude: full name, age, role, skills, fatal flaw, emotional wound, backstory, motivation (want vs need), character arc from beginning to end, speech patterns, physical description, and key relationships.\n\nWrite 500+ words of substantive character development.`,
      { skill: 'book-bible' }
    );

    addStep('Antagonist profile', 'bible', 'book_bible',
      `Create a detailed antagonist profile for "${title}".\n\nInclude: capabilities, constraints, goals, motivation, backstory, communication style, personality quirks, why they believe they're right, and how they challenge the protagonist.\n\nWrite 500+ words of substantive character development.`,
      { skill: 'book-bible' }
    );

    addStep('Supporting characters', 'bible', 'book_bible',
      `Create 3-4 supporting character profiles for "${title}".\n\nFor each character include: name, age, role in the story, relationship to protagonist, motivation, backstory, personality traits, speech patterns, and how they contribute to the protagonist's arc.\n\nWrite 500+ words total.`,
      { skill: 'book-bible' }
    );

    addStep('Major locations', 'bible', 'book_bible',
      `Build out the major locations for "${title}".\n\nCreate 4-5 key locations. For each: name, physical description, atmosphere, who frequents it, significance to the plot, and sensory details (sounds, smells, textures, light).\n\nWrite 500+ words.`,
      { skill: 'book-bible' }
    );

    addStep('Timeline', 'bible', 'book_bible',
      `Create a detailed timeline for "${title}".\n\nInclude: key backstory events before the novel begins, the chronological sequence of major plot events, crisis escalation points, and the resolution timeline. Note which characters are present at each key event.\n\nWrite 500+ words.`,
      { skill: 'book-bible' }
    );

    addStep('World rules & consistency guide', 'bible', 'consistency',
      `Create a consistency guide and world rules document for "${title}".\n\nInclude: naming conventions, key terminology, character physical details that must remain consistent, technology/magic rules, social structures, and any other details that must stay consistent across ${chapters} chapters.\n\nWrite 500+ words.`,
      { skill: 'book-bible' }
    );

    // ── Phase: Outline (2 steps) ──
    addStep('Chapter outline', 'outline', 'outline',
      `Create a ${chapters}-chapter outline for "${title}" with structural beats.\n\nFor each chapter include:\n- Chapter number and title\n- POV character\n- Primary location\n- 3-5 key beats\n- Tension level (1-10)\n- Chapter ending hook\n\nStructure:\n- Chapters 1-${setupEnd}: Setup and world introduction\n- Chapters ${setupEnd + 1}-${incitingEnd}: Inciting incident\n- Chapters ${incitingEnd + 1}-${midpoint - 1}: Rising action\n- Chapter ${midpoint}: Midpoint twist\n- Chapters ${midpoint + 1}-${twist75 - 1}: Complications multiply\n- Chapter ${twist75}: 75% twist / all is lost\n- Chapters ${climaxStart}-${climaxEnd}: Climax sequence\n- Chapter ${chapters}: Resolution\n\nYou MUST include ALL ${chapters} chapters. Do NOT stop early. Number every chapter.`,
      { skill: 'outline' }
    );

    addStep('Scene breakdowns', 'outline', 'outline',
      `Expand the ${chapters}-chapter outline into scene-by-scene breakdowns for "${title}".\n\nFor each chapter, create 2-4 scenes with:\n- Scene goal and conflict\n- Key dialogue moments or reveals\n- Emotional beats\n- Estimated word count per scene\n\nTarget ~${wordsPerChapter} words per chapter. Focus especially on the inciting incident, midpoint twist, and climax sequence.`,
      { skill: 'outline' }
    );

    // ── Phase: Writing (N steps, one per chapter) ──
    for (let ch = 1; ch <= chapters; ch++) {
      addStep(`Write Chapter ${ch}`, 'writing', 'creative_writing',
        `Write Chapter ${ch} of "${title}".\n\nInstructions:\n- Follow the outline beats and scene breakdowns for this chapter\n- Check the Book Bible for character consistency\n- You MUST write at least ${wordsPerChapter} words of actual prose narrative\n- Open with a hook — no throat-clearing\n- End with a reason to turn the page\n- Include sensory details and internal tension\n- Write the COMPLETE chapter as actual prose, not a summary\n- Do NOT write fewer than ${wordsPerChapter} words. If running short, add more scenes, dialogue, internal monologue, sensory detail.`,
        { skill: 'write', wordCountTarget: wordsPerChapter, chapterNumber: ch }
      );
    }

    // ── Phase: Revision (3 steps) ──
    addStep('Developmental edit', 'revision', 'revision',
      `Perform a developmental edit across all ${chapters} chapters of "${title}".\n\nAnalyze:\n- Plot structure and pacing across the full arc\n- Character arc completion (do characters grow/change as planned?)\n- Tension and stakes escalation\n- Thematic coherence\n- Narrative drive and hooks between chapters\n\nProvide specific, chapter-by-chapter feedback with actionable suggestions.`,
      { skill: 'revise' }
    );

    addStep('Line edit notes', 'revision', 'revision',
      `Perform a line edit review of "${title}".\n\nFocus on:\n- Sentence rhythm and variety\n- Word choice and verb strength\n- Show vs tell instances\n- Dialogue quality and tag usage\n- Prose clarity and flow\n- Filler words to cut (suddenly, very, just, basically)\n\nProvide specific examples from the chapters with before/after suggestions.`,
      { skill: 'revise' }
    );

    addStep('Consistency check', 'revision', 'consistency',
      `Run a consistency check across all ${chapters} chapters of "${title}" against the Book Bible.\n\nCheck for:\n- Character description contradictions\n- Timeline inconsistencies\n- Location detail mismatches\n- World rule violations\n- Plot holes or dropped threads\n- Tone/voice inconsistencies\n\nList any issues with specific chapter references.`,
      { skill: 'revise' }
    );

    // ── Phase: Assembly (1 step) ──
    addStep('Assemble manuscript & report', 'assembly', 'general',
      `Generate a completion report for "${title}".\n\nInclude:\n- Total chapters: ${chapters}\n- Target word count: ~${(chapters * wordsPerChapter).toLocaleString()} words\n- Assessment of the manuscript's strengths\n- Areas for improvement in a future draft\n- 2-3 sentence back cover blurb\n- Recommendations for next steps (beta readers, professional edit, etc.)\n\nAll chapter files have been saved individually. This report summarizes the complete pipeline.`
    );

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
    console.log(`  ✓ Novel pipeline created: "${title}" — ${steps.length} steps, ${chapters} chapters, ~${(chapters * wordsPerChapter).toLocaleString()} words target`);
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
      console.log('  \u26a0 AI not wired for planning \u2014 falling back to template');
      const type = this.inferProjectType(description);
      return this.createProject(type, title, description, context);
    }

    try {
      const provider = this.aiSelectProvider('general');

      // Build skill catalog for the planner prompt
      const skillList = skillCatalog.map(s =>
        `- **${s.name}** (${s.category}${s.premium ? ' \u2605' : ''}): ${s.description} [triggers: ${s.triggers.join(', ')}]`
      ).join('\n');

      const toolList = authorOSTools.length > 0
        ? `\n\nAuthor OS Tools Available:\n${authorOSTools.map(t => `- ${t}`).join('\n')}`
        : '';

      const validTaskTypes = Object.keys(TASK_TYPE_MAP).join(', ');

      const plannerPrompt = `You are a task planner for AuthorClaw, an autonomous AI writing agent.

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
2. ONLY plan full novel pipelines (premise \u2192 characters \u2192 world \u2192 outline \u2192 chapters \u2192 revision \u2192 assembly) when the user EXPLICITLY asks for a novel, book, or full manuscript
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
        console.log(`  \u2713 AI planned ${steps.length} steps for "${title}" (via ${result.provider})`);
        return project;
      }

      // If parsing failed, fall back to template
      console.log('  \u26a0 AI plan parsing failed \u2014 falling back to template');
      const type = this.inferProjectType(description);
      return this.createProject(type, title, description, context);

    } catch (error) {
      console.error('  \u2717 AI planning failed:', error);
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
      console.log(`  Project "${title}": using template "${type}" with ${template.steps.length} steps`);
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
      console.warn(`  Project "${title}": no template found for type "${type}" — creating single-step project`);
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
    }
    this.persistState();
    return null;
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

    // Novel pipeline: phase-aware context accumulation
    if (project.type === 'novel-pipeline' && step.phase) {
      context += this.buildNovelPipelineContext(project, step);
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

    // Include uploaded manuscript content (from Upload button)
    if (project.context?.uploadedContent) {
      const uploads = project.context.uploads || [];
      const fileList = uploads.map((u: any) => `${u.filename} (${u.wordCount} words)`).join(', ');
      context += `## Uploaded Manuscript\n\n`;
      context += `**Files**: ${fileList}\n\n`;
      // Include up to 30k chars of uploaded content for the AI to work with
      const uploaded = String(project.context.uploadedContent);
      if (uploaded.length > 30000) {
        context += uploaded.substring(0, 30000) + '\n\n[...truncated at 30,000 chars — full text available in workspace...]\n\n';
      } else {
        context += uploaded + '\n\n';
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
        // Brief summaries of all chapters
        const writtenChapters = getPhaseResults('writing');
        if (writtenChapters.length > 0) {
          context += `## Chapter Drafts (summaries)\n\n`;
          for (const ch of writtenChapters) {
            context += `### ${ch.label}\n${truncate(ch.result!, 500)}\n\n`;
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
    const chapters = Math.min(Math.max(config.targetChapters || 25, 1), 200);
    const wordsPerChapter = Math.max(config.targetWordsPerChapter || 3000, 100);

    const steps: ProjectStep[] = [];
    for (let ch = 1; ch <= chapters; ch++) {
      steps.push({
        id: `${id}-step-${ch * 2 - 1}`,
        label: `Write Chapter ${ch}`,
        phase: 'writing',
        skill: 'write',
        taskType: 'creative_writing',
        prompt: `Write Chapter ${ch} of "${title}".\n\nInstructions:\n- Follow the outline beats and book bible for this chapter\n- You MUST write at least ${wordsPerChapter} words of actual prose narrative\n- Open with a hook — no throat-clearing\n- End with a reason to turn the page\n- Include sensory details and internal tension\n- Write the COMPLETE chapter as actual prose, not a summary\n\n${description}`,
        status: 'pending',
        wordCountTarget: wordsPerChapter,
        chapterNumber: ch,
      });
      steps.push({
        id: `${id}-step-${ch * 2}`,
        label: `Self-review Chapter ${ch}`,
        phase: 'writing',
        skill: 'revise',
        taskType: 'revision',
        prompt: `Review Chapter ${ch} we just wrote. Check for: voice consistency, pacing, show vs tell, dialogue quality, sensory details, word count target (${wordsPerChapter}+). Suggest improvements but focus on completing the chapter, not perfection.`,
        status: 'pending',
        chapterNumber: ch,
      });
    }

    // Assembly step
    steps.push({
      id: `${id}-step-${chapters * 2 + 1}`,
      label: 'Compile manuscript',
      phase: 'assembly',
      taskType: 'general',
      prompt: `Generate a completion report for "${title}". Total chapters: ${chapters}. Target: ~${(chapters * wordsPerChapter).toLocaleString()} words. Assess strengths, areas for improvement, and next steps.`,
      status: 'pending',
    });

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

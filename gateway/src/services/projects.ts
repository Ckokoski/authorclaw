/**
 * AuthorClaw Project Engine
 * Autonomous project-based task planning and execution
 *
 * The user defines what they want to achieve,
 * and AuthorClaw autonomously selects the right tools, prompts, skills,
 * and workflows to accomplish it.
 *
 * Project types:
 *   planning     - Story planning, outlining, brainstorming
 *   research     - Market research, fact-finding, comp analysis
 *   worldbuild   - Book bible, characters, settings, timelines
 *   writing      - Drafting chapters, scenes, prose
 *   revision     - Editing, feedback, consistency checks
 *   promotion    - Blurbs, query letters, social media, ads
 *   analysis     - Style analysis, manuscript autopsy, voice matching
 *   export       - Format and export manuscripts
 */

import { AuthorOSService } from './author-os.js';
import type { SkillCatalogEntry } from '../skills/loader.js';

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
  | 'planning'
  | 'research'
  | 'worldbuild'
  | 'writing'
  | 'revision'
  | 'promotion'
  | 'analysis'
  | 'export'
  | 'novel-pipeline'
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
  phase?: string;           // 'premise' | 'bible' | 'outline' | 'writing' | 'revision' | 'assembly'
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
  {
    type: 'planning',
    label: 'Story Planning',
    description: 'Develop a story from concept to detailed outline',
    steps: [
      {
        label: 'Develop premise',
        skill: 'premise',
        taskType: 'general',
        promptTemplate: 'Help me develop this story concept into a strong premise: {{description}}. Create a compelling logline, identify the core conflict, stakes, and theme.',
      },
      {
        label: 'Create character profiles',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Based on this premise: {{description}}\n\nCreate detailed character profiles for the protagonist and 3-4 key supporting characters. Include: name, age, background, motivation, internal conflict, external conflict, arc, and key relationships.',
      },
      {
        label: 'Build world and setting',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Based on this premise: {{description}}\n\nBuild out the world and setting. Include: locations (with sensory details), time period, social/political context, rules/constraints of the world, and atmosphere.',
      },
      {
        label: 'Create story outline',
        skill: 'outline',
        toolSuggestion: 'workflow-engine',
        taskType: 'outline',
        promptTemplate: 'Using this premise and the characters/world we developed: {{description}}\n\nCreate a detailed chapter-by-chapter outline. For each chapter include: chapter title, POV character, key events, emotional arc, and how it advances the main plot.',
      },
      {
        label: 'Review and refine',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Review the complete story plan we created. Check for: plot holes, pacing issues, character consistency, thematic coherence, and narrative tension. Suggest specific improvements.',
      },
    ],
  },
  {
    type: 'research',
    label: 'Research & Market Analysis',
    description: 'Research genre, market, and subject matter for your book',
    steps: [
      {
        label: 'Genre analysis',
        skill: 'market-research',
        taskType: 'research',
        promptTemplate: 'Analyze the current market for this type of book: {{description}}. What are the top-selling comparable titles? What tropes and conventions does the genre expect? What are readers looking for?',
      },
      {
        label: 'Subject matter research',
        skill: 'research',
        taskType: 'research',
        promptTemplate: 'Research the key subject matter areas for: {{description}}. Provide factual background information, terminology, and details I need to write authentically about this topic.',
      },
      {
        label: 'Audience profiling',
        skill: 'market-research',
        taskType: 'research',
        promptTemplate: 'Profile the ideal reader for: {{description}}. Demographics, reading habits, what they love in books, what frustrates them, where they discover new books, and what would make them recommend this book.',
      },
      {
        label: 'Competitive positioning',
        skill: 'market-research',
        taskType: 'marketing',
        promptTemplate: 'Based on our research for: {{description}}\n\nHow should this book be positioned in the market? What makes it unique? What comp titles would you use in a query letter? What categories/keywords should it target?',
      },
    ],
  },
  {
    type: 'worldbuild',
    label: 'World Building',
    description: 'Create a comprehensive book bible with characters, settings, and lore',
    steps: [
      {
        label: 'Core world rules',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create the foundational world rules for: {{description}}. Include: physical laws/magic system, technology level, social structures, power dynamics, history (key events), and any unique constraints.',
      },
      {
        label: 'Major locations',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Build out the major locations for: {{description}}. For each location: name, physical description, atmosphere, who lives/works there, significance to the plot, and sensory details (sounds, smells, textures).',
      },
      {
        label: 'Character ensemble',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create the complete character ensemble for: {{description}}. For each character: full name, age, appearance, personality (strengths/flaws), backstory, motivation, relationships with other characters, speech patterns, and character arc.',
      },
      {
        label: 'Timeline and history',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create a detailed timeline for: {{description}}. Include: backstory events before the novel begins, the chronological sequence of the plot, and any future implications. Note which characters are present at each key event.',
      },
      {
        label: 'Consistency rules',
        skill: 'book-bible',
        taskType: 'consistency',
        promptTemplate: 'Create a consistency guide/style sheet for: {{description}}. Include: naming conventions, spelling of made-up terms, character physical descriptions (hair, eyes, height), recurring phrases, technology rules, and any other details that must remain consistent.',
      },
    ],
  },
  {
    type: 'novel-pipeline',
    label: 'Full Novel Pipeline',
    description: 'Write a complete novel from premise to final manuscript — premise, characters, world, outline, chapters, revision, and assembly',
    steps: [], // 30+ steps are auto-generated by createNovelPipeline()
  },
  {
    type: 'writing',
    label: 'Write a Chapter',
    description: 'Write a single chapter or scene for your book',
    steps: [
      {
        label: 'Review context',
        skill: 'manuscript-hub',
        taskType: 'general',
        promptTemplate: 'Before writing, review the current state of the project: {{description}}. What has been written so far? What comes next according to the outline? What voice and style should I maintain?',
      },
      {
        label: 'Write the draft',
        skill: 'write',
        taskType: 'creative_writing',
        promptTemplate: '{{description}}\n\nWrite this with vivid prose, strong voice, and attention to pacing. Target 3,000-4,000 words. Show, don\'t tell. Use dialogue to reveal character. End with a hook that pulls the reader forward.',
      },
      {
        label: 'Self-review',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Review what we just wrote. Check for: voice consistency, pacing, show vs tell, dialogue quality, sensory details, and transitions. Suggest specific improvements but don\'t rewrite unless asked.',
      },
    ],
  },
  {
    type: 'revision',
    label: 'Revision & Editing',
    description: 'Edit and improve existing manuscript content',
    steps: [
      {
        label: 'Developmental edit',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Perform a developmental edit on: {{description}}. Analyze: plot structure, character arcs, pacing, tension, thematic coherence, and narrative drive. Provide specific, actionable feedback.',
      },
      {
        label: 'Line edit',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Perform a line edit on: {{description}}. Focus on: sentence rhythm, word choice, clarity, voice consistency, dialogue tags, and prose quality. Show specific before/after examples.',
      },
      {
        label: 'Consistency check',
        skill: 'revise',
        taskType: 'consistency',
        promptTemplate: 'Check for consistency issues in: {{description}}. Look for: character description changes, timeline errors, setting contradictions, technology/magic rule violations, and naming inconsistencies.',
      },
      {
        label: 'Beta reader simulation',
        skill: 'beta-reader',
        taskType: 'revision',
        promptTemplate: 'Read this as a beta reader: {{description}}. Give honest feedback on: what works well, what confused you, where you got bored, what felt unrealistic, and your overall emotional response. Rate engagement out of 10.',
      },
    ],
  },
  {
    type: 'promotion',
    label: 'Marketing & Promotion',
    description: 'Create marketing materials and promotion strategy',
    steps: [
      {
        label: 'Write book blurb',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: 'Write a compelling book blurb for: {{description}}. Create 3 versions: (1) short tagline, (2) back-cover blurb (150 words), (3) Amazon description with HTML formatting. Each should hook the reader and convey genre/tone.',
      },
      {
        label: 'Draft query letter',
        skill: 'query-letter',
        taskType: 'marketing',
        promptTemplate: 'Write a professional query letter for: {{description}}. Include: hook, book summary, comparable titles, author bio placeholder, and word count. Follow industry standard format.',
      },
      {
        label: 'Social media content',
        skill: 'social-media',
        taskType: 'marketing',
        promptTemplate: 'Create a social media content plan for: {{description}}. Include: 5 Twitter/X posts, 3 Instagram captions, 2 TikTok video concepts, and 1 newsletter announcement. Match the book\'s tone and target audience.',
      },
      {
        label: 'Ad copy',
        skill: 'ad-copy',
        taskType: 'marketing',
        promptTemplate: 'Write advertising copy for: {{description}}. Create: 3 Amazon ad headlines, 2 Facebook ad variants, and 1 BookBub featured deal description. Focus on hooks that match the genre expectations.',
      },
    ],
  },
  {
    type: 'analysis',
    label: 'Book Launch Prep',
    description: 'Prepare everything you need to launch your book',
    steps: [
      {
        label: 'Write book blurb',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: 'Write a compelling book blurb for: {{description}}. Create 3 versions: (1) one-line tagline, (2) back-cover blurb (150 words), (3) Amazon description. Each should hook the reader and convey genre/tone.',
      },
      {
        label: 'Create social media content',
        skill: 'social-media',
        taskType: 'marketing',
        promptTemplate: 'Create launch day social media content for: {{description}}. Include: 3 Twitter/X posts (with hashtags), 2 Instagram captions, and 1 TikTok/BookTok video concept. Match the book\'s tone.',
      },
      {
        label: 'Draft query letter',
        skill: 'query-letter',
        taskType: 'marketing',
        promptTemplate: 'Write a professional query letter for: {{description}}. Include: hook, book summary (250 words), comparable titles, target audience, and word count. Follow industry standard format.',
      },
    ],
  },
  {
    type: 'export',
    label: 'Character Deep Dive',
    description: 'Create detailed character profiles and relationship maps',
    steps: [
      {
        label: 'Build protagonist',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create a detailed protagonist profile for: {{description}}. Include: full backstory, motivation, fatal flaw, strengths, physical description, speech patterns, key relationships, and character arc from beginning to end.',
      },
      {
        label: 'Build antagonist and supporting cast',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Based on the protagonist we created, build the antagonist and 3-4 supporting characters for: {{description}}. Each needs: motivation, backstory, role in the story, relationship to protagonist, and how they challenge or help the hero.',
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// Project Engine
// ═══════════════════════════════════════════════════════════

export class ProjectEngine {
  private projects: Map<string, Project> = new Map();
  private authorOS: AuthorOSService | null;
  private nextId = 1;
  private aiComplete: AICompleteFunc | null = null;
  private aiSelectProvider: AISelectProviderFunc | null = null;

  constructor(authorOS?: AuthorOSService) {
    this.authorOS = authorOS || null;
  }

  /**
   * Wire up AI capabilities so ProjectEngine can call the AI for dynamic planning.
   * Called after the router is initialized in index.ts.
   */
  setAI(complete: AICompleteFunc, selectProvider: AISelectProviderFunc): void {
    this.aiComplete = complete;
    this.aiSelectProvider = selectProvider;
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
      steps = template.steps.map((s, i) => ({
        id: `${id}-step-${i + 1}`,
        label: s.label,
        skill: s.skill,
        toolSuggestion: s.toolSuggestion,
        taskType: s.taskType,
        prompt: this.expandTemplate(s.promptTemplate, { title, description, ...context }),
        status: 'pending' as const,
      }));
    } else {
      // Custom project — single step with the user's description
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

    // Calculate progress
    const completed = project.steps.filter(s => s.status === 'completed').length;
    project.progress = Math.round((completed / project.steps.length) * 100);
    project.updatedAt = new Date().toISOString();

    // Find next pending step
    const next = project.steps.find(s => s.status === 'pending');
    if (next) {
      next.status = 'active';
      // Enrich the next prompt with results from completed steps
      next.prompt = this.enrichWithPriorResults(next.prompt, project);
      return next;
    }

    // All steps done — mark project complete
    project.status = 'completed';
    project.completedAt = new Date().toISOString();
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
      return next;
    }

    project.status = 'completed';
    project.completedAt = new Date().toISOString();
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
  }

  /**
   * Delete a project
   */
  deleteProject(id: string): boolean {
    return this.projects.delete(id);
  }

  /**
   * Build the system prompt addition for a project step.
   * This tells the AI what context it's operating in.
   */
  buildProjectContext(project: Project, step: ProjectStep): string {
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
        // Sliding window: last 2 completed chapter results
        const writtenChapters = getPhaseResults('writing');
        if (writtenChapters.length > 0) {
          const recent = writtenChapters.slice(-2);
          context += `## Recent Chapters (for continuity)\n\n`;
          for (const ch of recent) {
            context += `### ${ch.label}\n${truncate(ch.result!, 2000)}\n\n`;
          }
        }
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

    // Planning signals
    if (lower.match(/\b(plan|outline|structure|plot|brainstorm|concept|story map|beat sheet|premise|logline)\b/)) {
      return 'planning';
    }

    // Research signals
    if (lower.match(/\b(research|market analysis|comp titles|comparable|audience|genre analysis|investigate)\b/)) {
      return 'research';
    }

    // World building signals
    if (lower.match(/\b(world.?build|book.?bible|magic system|timeline|backstory|lore)\b/)) {
      return 'worldbuild';
    }

    // Writing signals — require book/fiction context words, not just bare "write"
    if (lower.match(/\b(chapter|scene|prose|manuscript|draft a chapter|write.*chapter|write.*scene)\b/)) {
      return 'writing';
    }

    // Revision signals
    if (lower.match(/\b(edit|revise|rewrite|feedback|critique|proofread|consistency|beta read)\b/)) {
      return 'revision';
    }

    // Promotion signals
    if (lower.match(/\b(promote|blurb|query letter|social media|ad copy|advertise)\b/)) {
      return 'promotion';
    }

    // Analysis signals
    if (lower.match(/\b(style analysis|voice analysis|analyz.*style|tone|match my|clone.*voice)\b/)) {
      return 'analysis';
    }

    // Export signals
    if (lower.match(/\b(export|format|compile|epub|pdf|docx|publish)\b/)) {
      return 'export';
    }

    // Default: let the AI planner figure out the best approach
    return 'custom';
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
      planning: 'outline',
      research: 'research',
      worldbuild: 'book_bible',
      writing: 'creative_writing',
      revision: 'revision',
      promotion: 'marketing',
      analysis: 'style_analysis',
      export: 'general',
      'novel-pipeline': 'creative_writing',
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
    // If the prompt already references previous work, skip
    if (prompt.includes('we developed') || prompt.includes('we created')) {
      return prompt;
    }

    // Add a brief context note from the last completed step
    const lastCompleted = [...project.steps].reverse().find(s => s.status === 'completed' && s.result);
    if (lastCompleted && lastCompleted.result) {
      const brief = lastCompleted.result.length > 500
        ? lastCompleted.result.slice(0, 500) + '...'
        : lastCompleted.result;
      return `[Context from "${lastCompleted.label}": ${brief}]\n\n${prompt}`;
    }

    return prompt;
  }
}

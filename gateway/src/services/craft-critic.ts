/**
 * AuthorClaw Craft Critic
 *
 * Developmental-editor-level feedback that goes beyond "this could be better."
 * All checks are local heuristics (no AI calls) so they're fast, deterministic,
 * and cost nothing — perfect for running on every chapter save.
 *
 * Checks:
 *   - Sag detector: word-count + emotional-intensity variance across the 45-65%
 *     middle of the manuscript. Flags sagging middles.
 *   - Showing vs telling: emotion-word density vs physiology/action ratio.
 *     Too many "felt sad / was angry / was scared" = telling.
 *   - Save-the-Cat beat adherence: checks manuscript length hits the expected
 *     15 beats at expected percentages.
 *   - Adverb density: -ly adverbs per 1000 words (King's rule of thumb).
 *   - Filter words: "saw / heard / felt / thought / realized" distance readers
 *     from the POV character.
 *   - Dialogue-to-narration ratio per chapter (tracks variance).
 *   - Sentence-length variance (chapters that are all short or all long).
 *   - Passive voice ratio.
 *
 * Returns a structured report the dashboard renders as actionable feedback.
 */

export interface ChapterMetrics {
  chapterId: string;
  chapterNumber: number;
  title: string;
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  avgSentenceLength: number;
  sentenceLengthVariance: number;    // Low = monotonous
  dialogueRatio: number;              // 0-1, paragraphs with dialogue / total
  adverbRate: number;                 // -ly adverbs per 1000 words
  passiveVoiceRate: number;           // "was/were + past participle" per 1000 words
  filterWordRate: number;             // filter-word count per 1000 words
  tellingRate: number;                // emotion-telling phrases per 1000 words
  showingSignals: number;             // physiology/action signals per 1000 words
  showingRatio: number;               // showing / (showing + telling)
}

export interface CraftFlag {
  chapterId: string;
  chapterNumber: number;
  title: string;
  category: 'sag' | 'telling' | 'adverbs' | 'passive' | 'filter' | 'monotony' | 'dialogue_ratio' | 'beats' | 'pacing';
  severity: 'info' | 'warning' | 'error';
  description: string;
  evidence?: string;                   // Sample line or stat
  suggestion: string;
}

export interface BeatAnalysis {
  beatName: string;
  expectedPct: number;                 // 0-100
  expectedChapterRange: [number, number];
  actualChapterNumber: number | null;
  found: boolean;
  confidence: number;                  // 0-1
}

export interface CraftReport {
  generatedAt: string;
  projectId: string;
  overall: {
    totalWords: number;
    totalChapters: number;
    avgAdverbRate: number;
    avgPassiveRate: number;
    avgTellingRate: number;
    avgDialogueRatio: number;
    storyShape: 'flat' | 'building' | 'classic' | 'inverted';  // Based on per-chapter word counts
  };
  chapters: ChapterMetrics[];
  flags: CraftFlag[];
  beats: BeatAnalysis[];
  saveTheCatAdherence: number;         // 0-100 score
}

// Save-the-Cat 15-beat structure with expected percentages.
const SAVE_THE_CAT_BEATS = [
  { name: 'Opening Image', pct: 0, keywords: [] },
  { name: 'Theme Stated', pct: 5, keywords: ['theme', 'moral'] },
  { name: 'Set-Up', pct: 10, keywords: ['ordinary world', 'home', 'routine'] },
  { name: 'Catalyst', pct: 12, keywords: ['inciting', 'disturbance', 'news', 'letter', 'message'] },
  { name: 'Debate', pct: 17, keywords: ['decide', 'hesitate', 'doubt', 'question'] },
  { name: 'Break Into Two', pct: 25, keywords: ['decide', 'leave', 'journey', 'accept'] },
  { name: 'B Story', pct: 30, keywords: ['meet', 'encounter', 'relationship'] },
  { name: 'Fun and Games', pct: 30, keywords: [] },
  { name: 'Midpoint', pct: 50, keywords: ['reveal', 'twist', 'discover', 'truth'] },
  { name: 'Bad Guys Close In', pct: 55, keywords: ['danger', 'attack', 'threat', 'close'] },
  { name: 'All Is Lost', pct: 75, keywords: ['lost', 'defeat', 'death', 'end', 'dead'] },
  { name: 'Dark Night of Soul', pct: 77, keywords: ['despair', 'alone', 'empty', 'broken'] },
  { name: 'Break Into Three', pct: 80, keywords: ['realize', 'resolve', 'plan', 'rise'] },
  { name: 'Finale', pct: 90, keywords: ['confront', 'battle', 'climax', 'final'] },
  { name: 'Final Image', pct: 100, keywords: [] },
];

// Filter words — they put a narrator between reader and POV character.
const FILTER_WORDS = new Set([
  'saw', 'heard', 'felt', 'smelled', 'tasted', 'noticed', 'watched',
  'thought', 'realized', 'wondered', 'decided', 'knew', 'understood',
  'seemed', 'appeared', 'observed',
]);

// "Telling" emotion phrases — regex for flexibility.
const TELLING_PATTERNS = [
  /\bwas\s+(?:sad|angry|scared|afraid|happy|excited|worried|nervous|tired|confused|surprised|shocked)\b/gi,
  /\bfelt\s+(?:sad|angry|scared|afraid|happy|excited|worried|nervous|tired|confused|surprised|shocked|a pang|a wave)\b/gi,
  /\b(?:she|he|they|I)\s+(?:was|were)\s+(?:sad|angry|scared|happy|excited|afraid)/gi,
];

// "Showing" signals — physiology + action hints.
const SHOWING_PATTERNS = [
  /\b(?:heart|pulse)\s+(?:pounded|raced|hammered|thudded|skipped)\b/gi,
  /\b(?:hands?|fingers?)\s+(?:trembled|shook|clenched|tightened|curled)\b/gi,
  /\b(?:stomach|gut)\s+(?:twisted|lurched|knotted|dropped|churned)\b/gi,
  /\b(?:breath|breathing)\s+(?:caught|stopped|quickened|hitched|came short)\b/gi,
  /\bthroat\s+(?:tightened|burned|ached|closed)\b/gi,
  /\bjaw\s+(?:tightened|clenched|slackened|dropped)\b/gi,
  /\bshoulders?\s+(?:tensed|slumped|relaxed|squared)\b/gi,
  /\b(?:blinked|flinched|winced|grimaced|smirked|scowled|glared|swallowed)\b/gi,
];

// Passive voice: "was/were/is/are/be/been/being + past participle" — crude but works.
const PASSIVE_VOICE_RE = /\b(?:was|were|is|are|be|been|being)\s+\w+ed\b/gi;

// Adverbs: word ending in "ly" that's not "family/supply/only/reply/apply…"
const NON_ADVERB_LY = new Set([
  'family', 'supply', 'only', 'reply', 'apply', 'holy', 'lovely', 'early',
  'ugly', 'silly', 'jolly', 'belly', 'bully', 'really',  // "really" is an adverb but so common it's noise
]);

export class CraftCriticService {
  /**
   * Run the full craft analysis on a set of chapters.
   */
  analyze(
    projectId: string,
    chapters: Array<{ id: string; number: number; title: string; text: string }>,
  ): CraftReport {
    const chapterMetrics = chapters.map(c => this.analyzeChapter(c));
    const flags = this.detectFlags(chapterMetrics, chapters);
    const beats = this.detectBeats(chapters);
    const saveTheCatAdherence = beats.length > 0
      ? Math.round((beats.filter(b => b.found).length / beats.length) * 100)
      : 0;

    const totalWords = chapterMetrics.reduce((sum, c) => sum + c.wordCount, 0);
    const avgAdverbRate = chapterMetrics.length > 0
      ? chapterMetrics.reduce((sum, c) => sum + c.adverbRate, 0) / chapterMetrics.length
      : 0;
    const avgPassiveRate = chapterMetrics.length > 0
      ? chapterMetrics.reduce((sum, c) => sum + c.passiveVoiceRate, 0) / chapterMetrics.length
      : 0;
    const avgTellingRate = chapterMetrics.length > 0
      ? chapterMetrics.reduce((sum, c) => sum + c.tellingRate, 0) / chapterMetrics.length
      : 0;
    const avgDialogueRatio = chapterMetrics.length > 0
      ? chapterMetrics.reduce((sum, c) => sum + c.dialogueRatio, 0) / chapterMetrics.length
      : 0;

    const storyShape = this.classifyStoryShape(chapterMetrics);

    return {
      generatedAt: new Date().toISOString(),
      projectId,
      overall: {
        totalWords,
        totalChapters: chapterMetrics.length,
        avgAdverbRate: Math.round(avgAdverbRate * 10) / 10,
        avgPassiveRate: Math.round(avgPassiveRate * 10) / 10,
        avgTellingRate: Math.round(avgTellingRate * 10) / 10,
        avgDialogueRatio: Math.round(avgDialogueRatio * 100) / 100,
        storyShape,
      },
      chapters: chapterMetrics,
      flags,
      beats,
      saveTheCatAdherence,
    };
  }

  private analyzeChapter(chapter: { id: string; number: number; title: string; text: string }): ChapterMetrics {
    const { text } = chapter;
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    const sentenceLengths = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
    const avgSentenceLength = sentenceLengths.length > 0
      ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length
      : 0;
    const variance = this.computeVariance(sentenceLengths);

    // Dialogue ratio: paragraphs starting with a quote.
    const dialogueParas = paragraphs.filter(p => /^["\u201C]/.test(p.trim())).length;
    const dialogueRatio = paragraphs.length > 0 ? dialogueParas / paragraphs.length : 0;

    // Adverbs: words ending in -ly excluding known false positives.
    let adverbCount = 0;
    for (const w of words) {
      const clean = w.toLowerCase().replace(/[^a-z]/g, '');
      if (clean.length > 3 && clean.endsWith('ly') && !NON_ADVERB_LY.has(clean)) {
        adverbCount++;
      }
    }
    const adverbRate = wordCount > 0 ? (adverbCount / wordCount) * 1000 : 0;

    // Passive voice.
    const passiveMatches = text.match(PASSIVE_VOICE_RE) || [];
    const passiveVoiceRate = wordCount > 0 ? (passiveMatches.length / wordCount) * 1000 : 0;

    // Filter words.
    let filterCount = 0;
    for (const w of words) {
      if (FILTER_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ''))) filterCount++;
    }
    const filterWordRate = wordCount > 0 ? (filterCount / wordCount) * 1000 : 0;

    // Telling / showing.
    let tellingCount = 0;
    for (const pat of TELLING_PATTERNS) tellingCount += (text.match(pat) || []).length;
    let showingCount = 0;
    for (const pat of SHOWING_PATTERNS) showingCount += (text.match(pat) || []).length;
    const tellingRate = wordCount > 0 ? (tellingCount / wordCount) * 1000 : 0;
    const showingRatio = (tellingCount + showingCount) > 0
      ? showingCount / (tellingCount + showingCount)
      : 0.5;

    return {
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      title: chapter.title,
      wordCount,
      sentenceCount: sentences.length,
      paragraphCount: paragraphs.length,
      avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
      sentenceLengthVariance: Math.round(variance * 10) / 10,
      dialogueRatio: Math.round(dialogueRatio * 100) / 100,
      adverbRate: Math.round(adverbRate * 10) / 10,
      passiveVoiceRate: Math.round(passiveVoiceRate * 10) / 10,
      filterWordRate: Math.round(filterWordRate * 10) / 10,
      tellingRate: Math.round(tellingRate * 10) / 10,
      showingSignals: showingCount,
      showingRatio: Math.round(showingRatio * 100) / 100,
    };
  }

  private detectFlags(
    metrics: ChapterMetrics[],
    chapters: Array<{ id: string; number: number; title: string; text: string }>,
  ): CraftFlag[] {
    const flags: CraftFlag[] = [];
    if (metrics.length === 0) return flags;

    // Sag detector: compare 45-65% middle chapters against the overall average
    // for word count + tension signals. Middle chapters with low showing + low
    // dialogue + low word count relative to outer books = sag.
    const total = metrics.length;
    const middleStart = Math.floor(total * 0.4);
    const middleEnd = Math.ceil(total * 0.65);
    const middleChapters = metrics.slice(middleStart, middleEnd);
    if (middleChapters.length > 0) {
      const avgShowingOverall = metrics.reduce((s, c) => s + c.showingRatio, 0) / total;
      const avgWordsOverall = metrics.reduce((s, c) => s + c.wordCount, 0) / total;
      for (const m of middleChapters) {
        if (m.showingRatio < avgShowingOverall * 0.7 && m.wordCount < avgWordsOverall * 0.85) {
          flags.push({
            chapterId: m.chapterId,
            chapterNumber: m.chapterNumber,
            title: m.title,
            category: 'sag',
            severity: 'warning',
            description: `Chapter ${m.chapterNumber} sags: short (${m.wordCount} words vs ${Math.round(avgWordsOverall)} avg) and more telling than surrounding chapters.`,
            suggestion: 'Add a scene that raises stakes, reveals information, or introduces new conflict. Middle chapters need to escalate, not rest.',
          });
        }
      }
    }

    // Telling-heavy chapters
    for (const m of metrics) {
      if (m.tellingRate > 4 && m.showingRatio < 0.4) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'telling', severity: 'warning',
          description: `${m.tellingRate.toFixed(1)} telling phrases per 1000 words, showing ratio only ${(m.showingRatio * 100).toFixed(0)}%.`,
          suggestion: 'Replace "was sad" with a gesture or physiology: tight throat, averted eyes, trembling hands. Let readers infer the emotion.',
        });
      }
    }

    // Adverb-heavy chapters (King's rule: fewer than 3 per 1000 words).
    for (const m of metrics) {
      if (m.adverbRate > 12) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'adverbs', severity: 'info',
          description: `${m.adverbRate.toFixed(1)} adverbs per 1000 words (style guides typically suggest under 10).`,
          suggestion: 'Replace "-ly" adverbs with stronger verbs: "walked quickly" → "hurried" / "ran".',
        });
      }
    }

    // Passive voice heavy
    for (const m of metrics) {
      if (m.passiveVoiceRate > 8) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'passive', severity: 'info',
          description: `${m.passiveVoiceRate.toFixed(1)} passive-voice constructions per 1000 words.`,
          suggestion: 'Convert "the door was opened by her" → "she opened the door". Active voice tightens prose.',
        });
      }
    }

    // Filter words
    for (const m of metrics) {
      if (m.filterWordRate > 10) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'filter', severity: 'info',
          description: `${m.filterWordRate.toFixed(1)} filter words per 1000 words (saw/heard/felt/thought/realized).`,
          suggestion: '"She saw the lights flicker" → "The lights flickered." Remove the narrator\'s mediation.',
        });
      }
    }

    // Monotonous sentence length (low variance)
    for (const m of metrics) {
      if (m.sentenceCount > 20 && m.sentenceLengthVariance < 15 && m.avgSentenceLength > 0) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'monotony', severity: 'info',
          description: `Sentence length is monotonous (variance ${m.sentenceLengthVariance.toFixed(1)}, avg ${m.avgSentenceLength}).`,
          suggestion: 'Mix short and long sentences for rhythm. Hit them with a fragment. Then let one breathe across two full lines.',
        });
      }
    }

    // Dialogue ratio extremes
    for (const m of metrics) {
      if (m.dialogueRatio > 0.8) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'dialogue_ratio', severity: 'info',
          description: `${Math.round(m.dialogueRatio * 100)}% dialogue paragraphs.`,
          suggestion: 'Add beats, gestures, or interior thoughts between lines. Unbroken dialogue reads as a transcript, not a scene.',
        });
      } else if (m.dialogueRatio < 0.05 && m.wordCount > 1000) {
        flags.push({
          chapterId: m.chapterId, chapterNumber: m.chapterNumber, title: m.title,
          category: 'dialogue_ratio', severity: 'info',
          description: `Only ${Math.round(m.dialogueRatio * 100)}% dialogue — feels narrated.`,
          suggestion: 'Consider breaking the summary into a scene with two voices.',
        });
      }
    }

    return flags;
  }

  private detectBeats(chapters: Array<{ id: string; number: number; title: string; text: string }>): BeatAnalysis[] {
    if (chapters.length === 0) return [];

    const totalChapters = chapters.length;
    const beats: BeatAnalysis[] = [];

    for (const beat of SAVE_THE_CAT_BEATS) {
      const expectedChapter = Math.max(1, Math.round((beat.pct / 100) * totalChapters));
      const rangeStart = Math.max(1, expectedChapter - 1);
      const rangeEnd = Math.min(totalChapters, expectedChapter + 1);

      let foundChapter: number | null = null;
      let confidence = 0;

      if (beat.keywords.length === 0) {
        // Structural beats (opening/final image) — implicit if chapters exist at that position.
        if (expectedChapter >= 1 && expectedChapter <= totalChapters) {
          foundChapter = expectedChapter;
          confidence = 0.6;
        }
      } else {
        // Search for keyword hits in the expected range.
        for (let cn = rangeStart; cn <= rangeEnd; cn++) {
          const chapter = chapters.find(c => c.number === cn);
          if (!chapter) continue;
          const lowerText = chapter.text.toLowerCase();
          const hits = beat.keywords.filter(k => lowerText.includes(k)).length;
          if (hits > 0) {
            foundChapter = cn;
            confidence = Math.min(1, hits / 2);
            break;
          }
        }
      }

      beats.push({
        beatName: beat.name,
        expectedPct: beat.pct,
        expectedChapterRange: [rangeStart, rangeEnd],
        actualChapterNumber: foundChapter,
        found: foundChapter !== null,
        confidence,
      });
    }

    return beats;
  }

  private classifyStoryShape(metrics: ChapterMetrics[]): 'flat' | 'building' | 'classic' | 'inverted' {
    if (metrics.length < 3) return 'flat';
    const firstThird = metrics.slice(0, Math.ceil(metrics.length / 3));
    const lastThird = metrics.slice(-Math.ceil(metrics.length / 3));
    const avg = (arr: ChapterMetrics[]) => arr.reduce((s, c) => s + c.wordCount, 0) / arr.length;
    const firstAvg = avg(firstThird);
    const lastAvg = avg(lastThird);
    const ratio = lastAvg / (firstAvg || 1);
    if (ratio > 1.25) return 'building';      // chapters get longer = tension builds
    if (ratio < 0.8) return 'inverted';        // chapters get shorter = rushed ending
    // Check middle dip for "classic" shape
    const midThird = metrics.slice(Math.floor(metrics.length / 3), Math.ceil(2 * metrics.length / 3));
    const midAvg = avg(midThird);
    if (midAvg < firstAvg * 0.9 && midAvg < lastAvg * 0.9) return 'classic';
    return 'flat';
  }

  private computeVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sq = values.reduce((s, v) => s + (v - mean) ** 2, 0);
    return sq / values.length;
  }
}

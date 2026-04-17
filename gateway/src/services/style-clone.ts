/**
 * AuthorClaw Style Clone
 *
 * 47-marker voice analyzer adapted from the sibling Style Clone Pro project.
 * Extracts quantitative markers of writing style from a sample manuscript
 * and produces a portable voice profile + AI system prompt the author can
 * apply to every creative_writing task to maintain voice consistency.
 *
 * Markers span five axes:
 *   Sentence structure (length, variance, rhythm)
 *   Vocabulary (size, rarity, word-length distribution)
 *   Punctuation (em-dash, semicolon, ellipsis usage rates)
 *   Syntax (passive voice, coordinate vs subordinate clauses)
 *   Voice (contraction rate, filter word rate, dialogue density, adverb usage)
 *
 * All analysis is local — no AI calls — so it's cheap enough to re-run
 * automatically on every chapter save for drift detection.
 */

export interface StyleMarkers {
  // ── Sentence structure (8 markers) ──
  avgSentenceLength: number;
  sentenceLengthStdDev: number;
  medianSentenceLength: number;
  shortSentencePct: number;         // <10 words
  mediumSentencePct: number;        // 10-25 words
  longSentencePct: number;          // 25+ words
  fragmentRate: number;             // Sentence fragments per 1000 words
  sentencesPerParagraph: number;

  // ── Vocabulary (9 markers) ──
  avgWordLength: number;
  uniqueWordRatio: number;          // Unique / total (type-token ratio)
  rareWordRate: number;             // Words of 8+ letters per 1000 words
  syllableComplexity: number;       // Avg syllables per word (rough)
  latinateRatio: number;            // Latinate suffixes (-tion, -ment, -ity) rate
  germanicRatio: number;            // Short Anglo-Saxon root rate
  fleschReadingEase: number;        // Standard readability score
  vocabSize: number;                // Unique word count
  repetitionIndex: number;          // Top-10 content words as % of total

  // ── Punctuation (8 markers) ──
  emDashRate: number;               // per 1000 words
  semicolonRate: number;
  colonRate: number;
  ellipsisRate: number;
  questionMarkRate: number;
  exclamationRate: number;
  parentheticalRate: number;
  commaRate: number;

  // ── Syntax (9 markers) ──
  passiveVoiceRate: number;
  compoundSentenceRate: number;     // "and"/"but"/"or" conjunction rate
  subordinateRate: number;          // "because"/"although"/"while" etc.
  startsWithConjunctionPct: number; // Sentences starting with And/But/So/Yet
  participialPhrasePct: number;     // Sentences opening with -ing participles
  relativePronounRate: number;      // "which/who/that" rate
  parallelStructureRate: number;    // Rough: repeated structural patterns
  prepositionalDensity: number;     // Preps per sentence
  nominalizationRate: number;       // "-tion" / "-ment" / "-ness" endings

  // ── Voice (13 markers) ──
  contractionRate: number;
  filterWordRate: number;
  dialogueDensity: number;          // 0-1
  adverbRate: number;               // -ly per 1000 words
  firstPersonPronounRate: number;
  secondPersonPronounRate: number;
  thirdPersonPronounRate: number;
  sensoryDensity: number;           // see/hear/smell/feel words per 1000
  abstractConcreteRatio: number;    // Abstract vs concrete noun ratio
  presentTenseRate: number;         // "is/are/am" present-tense forms
  pastTenseRate: number;            // "-ed" past-tense forms
  hedgingRate: number;              // "perhaps/maybe/might/seemed" rate
  intensifierRate: number;          // "very/really/quite/extremely" rate
}

export interface StyleProfile {
  generatedAt: string;
  sampleWordCount: number;
  sampleSource: string;             // Description of what was analyzed
  markers: StyleMarkers;
  systemPrompt: string;             // Inject into AI writing calls
  signature: string;                // 1-line summary
}

// ═══════════════════════════════════════════════════════════
// Lexicons
// ═══════════════════════════════════════════════════════════

const FILTER_WORDS = new Set([
  'saw', 'heard', 'felt', 'smelled', 'tasted', 'noticed', 'watched',
  'thought', 'realized', 'wondered', 'decided', 'knew', 'understood',
  'seemed', 'appeared', 'observed',
]);

const HEDGING_WORDS = new Set([
  'perhaps', 'maybe', 'might', 'possibly', 'probably', 'seemed', 'apparently',
  'presumably', 'somewhat', 'rather', 'quite',
]);

const INTENSIFIERS = new Set([
  'very', 'really', 'extremely', 'absolutely', 'totally', 'completely',
  'entirely', 'thoroughly', 'utterly', 'highly', 'incredibly',
]);

const SENSORY_WORDS = new Set([
  'saw', 'see', 'seen', 'looked', 'looking', 'watched', 'watching',
  'heard', 'hear', 'hearing', 'listened', 'listening', 'sound',
  'smelled', 'smell', 'smelling', 'scent', 'aroma',
  'tasted', 'taste', 'tasting', 'flavor',
  'felt', 'feel', 'feeling', 'touch', 'touched', 'warm', 'cold', 'rough', 'smooth',
]);

const CONTRACTION_RE = /\b(?:I'm|I've|I'll|I'd|you're|you've|you'll|you'd|he's|he'll|he'd|she's|she'll|she'd|it's|it'll|it'd|we're|we've|we'll|we'd|they're|they've|they'll|they'd|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|mustn't|shan't|y'all)\b/gi;

const PASSIVE_VOICE_RE = /\b(?:was|were|is|are|be|been|being)\s+\w+ed\b/gi;

// Non-adverb -ly words to exclude.
const NON_ADVERB_LY = new Set([
  'family', 'supply', 'only', 'reply', 'apply', 'holy', 'lovely', 'early',
  'ugly', 'silly', 'jolly', 'belly', 'bully', 'really',
]);

// ═══════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════

export class StyleCloneService {
  /**
   * Analyze a sample of the author's prose and build a style profile.
   */
  analyze(sampleText: string, source: string): StyleProfile {
    const text = sampleText || '';
    const words = text.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    if (wordCount < 100) {
      throw new Error('Style analysis requires at least 100 words of sample text.');
    }

    const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    const wordsLower = words.map(w => w.toLowerCase().replace(/[^a-z'\-]/g, ''));
    const sentenceLengths = sentences.map(s => s.split(/\s+/).filter(Boolean).length);

    // ── Sentence structure ──
    const avgSentenceLength = this.mean(sentenceLengths);
    const sentenceLengthStdDev = this.stdDev(sentenceLengths);
    const medianSentenceLength = this.median(sentenceLengths);
    const shortSentencePct = this.pctWhere(sentenceLengths, l => l < 10);
    const mediumSentencePct = this.pctWhere(sentenceLengths, l => l >= 10 && l <= 25);
    const longSentencePct = this.pctWhere(sentenceLengths, l => l > 25);
    const fragmentCount = sentenceLengths.filter(l => l > 0 && l <= 3).length;
    const fragmentRate = (fragmentCount / wordCount) * 1000;
    const sentencesPerParagraph = paragraphs.length > 0 ? sentences.length / paragraphs.length : 0;

    // ── Vocabulary ──
    const avgWordLength = this.mean(words.map(w => w.replace(/[^a-zA-Z]/g, '').length));
    const uniqueWords = new Set(wordsLower.filter(w => w.length > 0));
    const uniqueWordRatio = uniqueWords.size / Math.max(1, wordCount);
    const rareWordCount = wordsLower.filter(w => w.length >= 8).length;
    const rareWordRate = (rareWordCount / wordCount) * 1000;
    const syllableComplexity = this.mean(words.map(w => this.syllableCount(w)));
    const latinateCount = wordsLower.filter(w => /(?:tion|ment|ity|ness|ance|ence)$/.test(w)).length;
    const latinateRatio = (latinateCount / wordCount) * 100;
    const germanicCount = wordsLower.filter(w => w.length >= 3 && w.length <= 5 && /^[a-z]+$/.test(w)).length;
    const germanicRatio = (germanicCount / wordCount) * 100;
    const fleschReadingEase = this.fleschReadingEase(wordCount, sentences.length, words);
    const repetitionIndex = this.computeRepetitionIndex(wordsLower);

    // ── Punctuation ──
    const count = (re: RegExp) => (text.match(re) || []).length;
    const emDashRate = (count(/—|--/g) / wordCount) * 1000;
    const semicolonRate = (count(/;/g) / wordCount) * 1000;
    const colonRate = (count(/(?<!:):(?!:)/g) / wordCount) * 1000;
    const ellipsisRate = (count(/\.{3,}|…/g) / wordCount) * 1000;
    const questionMarkRate = (count(/\?/g) / wordCount) * 1000;
    const exclamationRate = (count(/!/g) / wordCount) * 1000;
    const parentheticalRate = (count(/\([^)]+\)/g) / wordCount) * 1000;
    const commaRate = (count(/,/g) / wordCount) * 1000;

    // ── Syntax ──
    const passiveVoiceRate = ((text.match(PASSIVE_VOICE_RE) || []).length / wordCount) * 1000;
    const compoundRate = (count(/\b(?:and|but|or)\b/gi) / wordCount) * 1000;
    const subordinateRate = (count(/\b(?:because|although|though|while|since|unless|until|whereas|whenever)\b/gi) / wordCount) * 1000;
    const conjunctionStarts = sentences.filter(s => /^(?:And|But|So|Yet|Or)\b/.test(s.trim())).length;
    const startsWithConjunctionPct = (conjunctionStarts / Math.max(1, sentences.length)) * 100;
    const participialStarts = sentences.filter(s => /^\w+ing[\s,]/.test(s.trim())).length;
    const participialPhrasePct = (participialStarts / Math.max(1, sentences.length)) * 100;
    const relativePronounRate = (count(/\b(?:which|who|whom|whose|that)\b/gi) / wordCount) * 1000;
    const parallelStructureRate = this.estimateParallelism(sentences) / wordCount * 1000;
    const prepositions = ['in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'over', 'under'];
    const prepCount = wordsLower.filter(w => prepositions.includes(w)).length;
    const prepositionalDensity = prepCount / Math.max(1, sentences.length);
    const nominalizationRate = (wordsLower.filter(w => /(?:tion|ment|ness)$/.test(w)).length / wordCount) * 1000;

    // ── Voice ──
    const contractionRate = ((text.match(CONTRACTION_RE) || []).length / wordCount) * 1000;
    const filterCount = wordsLower.filter(w => FILTER_WORDS.has(w)).length;
    const filterWordRate = (filterCount / wordCount) * 1000;
    const dialogueParas = paragraphs.filter(p => /^["\u201C]/.test(p.trim())).length;
    const dialogueDensity = paragraphs.length > 0 ? dialogueParas / paragraphs.length : 0;
    const adverbCount = wordsLower.filter(w => w.length > 3 && w.endsWith('ly') && !NON_ADVERB_LY.has(w)).length;
    const adverbRate = (adverbCount / wordCount) * 1000;

    const firstPerson = wordsLower.filter(w => ['i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours'].includes(w)).length;
    const secondPerson = wordsLower.filter(w => ['you', 'your', 'yours'].includes(w)).length;
    const thirdPerson = wordsLower.filter(w => ['he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs', 'it', 'its'].includes(w)).length;
    const firstPersonPronounRate = (firstPerson / wordCount) * 1000;
    const secondPersonPronounRate = (secondPerson / wordCount) * 1000;
    const thirdPersonPronounRate = (thirdPerson / wordCount) * 1000;

    const sensoryCount = wordsLower.filter(w => SENSORY_WORDS.has(w)).length;
    const sensoryDensity = (sensoryCount / wordCount) * 1000;

    // Abstract vs concrete — very rough: abstract nouns often end in -ity/-tion/-ness/-ment.
    const abstractCount = wordsLower.filter(w => /(?:tion|ment|ness|ity|ism|hood|ship|ance|ence)$/.test(w)).length;
    const concreteCount = wordsLower.filter(w => w.length >= 3 && w.length <= 6 && !/(?:tion|ment|ness|ity)$/.test(w)).length;
    const abstractConcreteRatio = concreteCount > 0 ? abstractCount / concreteCount : 0;

    const presentTenseCount = (text.match(/\b(?:is|are|am|has|have|do|does|says|goes|comes)\b/gi) || []).length;
    const pastTenseCount = wordsLower.filter(w => w.length > 3 && /ed$/.test(w)).length;
    const presentTenseRate = (presentTenseCount / wordCount) * 1000;
    const pastTenseRate = (pastTenseCount / wordCount) * 1000;

    const hedgingCount = wordsLower.filter(w => HEDGING_WORDS.has(w)).length;
    const intensifierCount = wordsLower.filter(w => INTENSIFIERS.has(w)).length;
    const hedgingRate = (hedgingCount / wordCount) * 1000;
    const intensifierRate = (intensifierCount / wordCount) * 1000;

    const markers: StyleMarkers = {
      avgSentenceLength: this.round(avgSentenceLength, 1),
      sentenceLengthStdDev: this.round(sentenceLengthStdDev, 1),
      medianSentenceLength: this.round(medianSentenceLength, 1),
      shortSentencePct: this.round(shortSentencePct, 1),
      mediumSentencePct: this.round(mediumSentencePct, 1),
      longSentencePct: this.round(longSentencePct, 1),
      fragmentRate: this.round(fragmentRate, 2),
      sentencesPerParagraph: this.round(sentencesPerParagraph, 1),

      avgWordLength: this.round(avgWordLength, 2),
      uniqueWordRatio: this.round(uniqueWordRatio, 3),
      rareWordRate: this.round(rareWordRate, 1),
      syllableComplexity: this.round(syllableComplexity, 2),
      latinateRatio: this.round(latinateRatio, 2),
      germanicRatio: this.round(germanicRatio, 2),
      fleschReadingEase: this.round(fleschReadingEase, 1),
      vocabSize: uniqueWords.size,
      repetitionIndex: this.round(repetitionIndex, 2),

      emDashRate: this.round(emDashRate, 2),
      semicolonRate: this.round(semicolonRate, 2),
      colonRate: this.round(colonRate, 2),
      ellipsisRate: this.round(ellipsisRate, 2),
      questionMarkRate: this.round(questionMarkRate, 2),
      exclamationRate: this.round(exclamationRate, 2),
      parentheticalRate: this.round(parentheticalRate, 2),
      commaRate: this.round(commaRate, 1),

      passiveVoiceRate: this.round(passiveVoiceRate, 2),
      compoundSentenceRate: this.round(compoundRate, 1),
      subordinateRate: this.round(subordinateRate, 2),
      startsWithConjunctionPct: this.round(startsWithConjunctionPct, 1),
      participialPhrasePct: this.round(participialPhrasePct, 1),
      relativePronounRate: this.round(relativePronounRate, 2),
      parallelStructureRate: this.round(parallelStructureRate, 2),
      prepositionalDensity: this.round(prepositionalDensity, 2),
      nominalizationRate: this.round(nominalizationRate, 2),

      contractionRate: this.round(contractionRate, 2),
      filterWordRate: this.round(filterWordRate, 2),
      dialogueDensity: this.round(dialogueDensity, 2),
      adverbRate: this.round(adverbRate, 2),
      firstPersonPronounRate: this.round(firstPersonPronounRate, 1),
      secondPersonPronounRate: this.round(secondPersonPronounRate, 1),
      thirdPersonPronounRate: this.round(thirdPersonPronounRate, 1),
      sensoryDensity: this.round(sensoryDensity, 2),
      abstractConcreteRatio: this.round(abstractConcreteRatio, 2),
      presentTenseRate: this.round(presentTenseRate, 2),
      pastTenseRate: this.round(pastTenseRate, 2),
      hedgingRate: this.round(hedgingRate, 2),
      intensifierRate: this.round(intensifierRate, 2),
    };

    const systemPrompt = this.buildSystemPrompt(markers);
    const signature = this.buildSignature(markers);

    return {
      generatedAt: new Date().toISOString(),
      sampleWordCount: wordCount,
      sampleSource: source,
      markers,
      systemPrompt,
      signature,
    };
  }

  /**
   * Build an AI system-prompt block describing the voice profile in plain
   * English so the LLM can match it when writing new prose.
   */
  private buildSystemPrompt(m: StyleMarkers): string {
    const lines: string[] = ['## Voice Profile — match these characteristics'];

    // Sentence rhythm
    if (m.sentenceLengthStdDev > 8) {
      lines.push(`- Mix sentence lengths aggressively (std dev ${m.sentenceLengthStdDev}). Use short punches (${m.shortSentencePct.toFixed(0)}%) and long flowing sentences (${m.longSentencePct.toFixed(0)}%).`);
    } else if (m.sentenceLengthStdDev < 4) {
      lines.push(`- Sentence length is consistent (std dev ${m.sentenceLengthStdDev}, avg ${m.avgSentenceLength}).`);
    } else {
      lines.push(`- Sentence length averages ${m.avgSentenceLength}, with moderate variation.`);
    }

    if (m.fragmentRate > 2) lines.push(`- Use sentence fragments for effect (rate ${m.fragmentRate.toFixed(1)}/1000).`);

    // Punctuation signatures
    const punctSignals: string[] = [];
    if (m.emDashRate > 3) punctSignals.push(`em-dashes freely (${m.emDashRate.toFixed(1)}/1000)`);
    if (m.semicolonRate > 1) punctSignals.push(`semicolons (${m.semicolonRate.toFixed(1)}/1000)`);
    if (m.ellipsisRate > 2) punctSignals.push(`ellipses for pauses (${m.ellipsisRate.toFixed(1)}/1000)`);
    if (m.parentheticalRate > 2) punctSignals.push(`parentheticals (${m.parentheticalRate.toFixed(1)}/1000)`);
    if (punctSignals.length > 0) {
      lines.push(`- Signature punctuation: ${punctSignals.join(', ')}.`);
    }

    // Voice
    if (m.contractionRate > 15) lines.push(`- Use contractions freely (${m.contractionRate.toFixed(0)}/1000) — tone is conversational.`);
    else if (m.contractionRate < 3) lines.push(`- Avoid contractions — formal register.`);

    if (m.adverbRate > 12) lines.push(`- Adverbs are OK (${m.adverbRate.toFixed(0)}/1000).`);
    else if (m.adverbRate < 5) lines.push(`- Minimize -ly adverbs (author uses only ${m.adverbRate.toFixed(1)}/1000).`);

    if (m.filterWordRate > 8) lines.push(`- Filter verbs (saw/heard/felt) appear ${m.filterWordRate.toFixed(1)}/1000 — match that.`);
    else if (m.filterWordRate < 3) lines.push(`- Avoid filter verbs (saw/heard/felt/thought) — use deep POV.`);

    if (m.dialogueDensity > 0.5) lines.push(`- Dialogue-heavy: ${Math.round(m.dialogueDensity * 100)}% of paragraphs are dialogue.`);
    else if (m.dialogueDensity < 0.15) lines.push(`- Dialogue-light: ${Math.round(m.dialogueDensity * 100)}% of paragraphs are dialogue — narration dominates.`);

    // POV
    if (m.firstPersonPronounRate > 30) lines.push(`- First-person POV — I/me/my common (${m.firstPersonPronounRate.toFixed(0)}/1000).`);
    else if (m.thirdPersonPronounRate > m.firstPersonPronounRate * 3) lines.push(`- Third-person POV (he/she/they dominate).`);

    // Tense
    if (m.presentTenseRate > m.pastTenseRate * 1.2) lines.push(`- Present tense.`);
    else if (m.pastTenseRate > m.presentTenseRate * 1.2) lines.push(`- Past tense.`);

    // Vocabulary register
    if (m.fleschReadingEase > 70) lines.push(`- Readability is high (Flesch ${m.fleschReadingEase.toFixed(0)}) — plain, accessible prose.`);
    else if (m.fleschReadingEase < 50) lines.push(`- Readability is lower (Flesch ${m.fleschReadingEase.toFixed(0)}) — literary, complex prose.`);

    if (m.latinateRatio > 6) lines.push(`- Latinate-heavy vocabulary (${m.latinateRatio.toFixed(1)}% -tion/-ment/-ity words).`);

    if (m.startsWithConjunctionPct > 12) lines.push(`- Sentences freely start with And/But/So (${m.startsWithConjunctionPct.toFixed(0)}%).`);

    if (m.passiveVoiceRate > 6) lines.push(`- Passive voice is accepted (${m.passiveVoiceRate.toFixed(1)}/1000) — don't over-correct.`);

    return lines.join('\n');
  }

  /** 1-line summary used in Persona context and audit log. */
  private buildSignature(m: StyleMarkers): string {
    const parts: string[] = [];
    parts.push(`avg sentence ${m.avgSentenceLength}w`);
    parts.push(`dialogue ${Math.round(m.dialogueDensity * 100)}%`);
    if (m.contractionRate > 15) parts.push('casual');
    else if (m.contractionRate < 3) parts.push('formal');
    if (m.adverbRate > 12) parts.push('adverb-friendly');
    else if (m.adverbRate < 5) parts.push('adverb-light');
    if (m.emDashRate > 3) parts.push('em-dash heavy');
    if (m.presentTenseRate > m.pastTenseRate * 1.2) parts.push('present');
    else if (m.pastTenseRate > m.presentTenseRate * 1.2) parts.push('past');
    if (m.firstPersonPronounRate > 30) parts.push('1P');
    else parts.push('3P');
    return parts.join(' · ');
  }

  // ── helpers ──

  private mean(values: number[]): number {
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }
  private stdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const m = this.mean(values);
    return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
  }
  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  private pctWhere(values: number[], pred: (v: number) => boolean): number {
    if (values.length === 0) return 0;
    return (values.filter(pred).length / values.length) * 100;
  }
  private round(value: number, digits: number): number {
    const m = Math.pow(10, digits);
    return Math.round(value * m) / m;
  }
  private syllableCount(word: string): number {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length <= 3) return 1;
    const cleaned = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const matches = cleaned.match(/[aeiouy]{1,2}/g);
    return Math.max(1, matches?.length || 1);
  }
  private fleschReadingEase(wordCount: number, sentenceCount: number, words: string[]): number {
    if (wordCount === 0 || sentenceCount === 0) return 0;
    const totalSyllables = words.reduce((s, w) => s + this.syllableCount(w), 0);
    return 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (totalSyllables / wordCount);
  }
  private computeRepetitionIndex(words: string[]): number {
    // Top-10 non-stopword content words as a percentage of total.
    const stops = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'i', 'you', 'he', 'she', 'they', 'we', 'his', 'her', 'their', 'my', 'your']);
    const counts = new Map<string, number>();
    for (const w of words) {
      if (w.length < 3 || stops.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    const top10 = Array.from(counts.values()).sort((a, b) => b - a).slice(0, 10);
    return (top10.reduce((a, b) => a + b, 0) / Math.max(1, words.length)) * 100;
  }
  private estimateParallelism(sentences: string[]): number {
    // Very rough: count sentences that start with the same first word as another sentence.
    const starts = new Map<string, number>();
    for (const s of sentences) {
      const first = (s.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
      if (first) starts.set(first, (starts.get(first) || 0) + 1);
    }
    let parallels = 0;
    for (const c of starts.values()) if (c >= 3) parallels += c;
    return parallels;
  }
}

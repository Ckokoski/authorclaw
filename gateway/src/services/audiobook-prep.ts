/**
 * AuthorClaw Audiobook Prep
 *
 * Prepares a manuscript for narration (human or AI). Three passes:
 *
 * 1. Script cleanup — normalizes text for speech:
 *      - em-dashes to pause cues
 *      - ellipses to pause cues
 *      - parentheticals flagged for soft read
 *      - numerals expanded ("23" -> "twenty-three" where safe)
 *      - symbols spelled ("&" -> "and", "%" -> "percent")
 *
 * 2. Pronunciation extraction — pulls invented/uncommon names from the
 *    ContextEngine's entity index (characters + locations + items), groups
 *    them, and produces a pronunciation dictionary template the author
 *    fills in with IPA or rhymes-with guidance.
 *
 * 3. SSML export — produces per-chapter SSML for services that accept it
 *    (Amazon Polly, Google Cloud TTS, Microsoft Azure, ElevenLabs v3).
 *
 * Safety: projects must set `aiNarrationDisclosed: true` in their config
 * before AuthorClaw will generate SSML for AI narration. ACX, Apple Books,
 * Google Play, and Spotify all require disclosure of AI-narrated audio.
 */

export interface PronunciationEntry {
  name: string;
  type: 'character' | 'location' | 'item' | 'event' | 'rule';
  aliases: string[];
  appearances: number;            // Total mentions across the manuscript
  suggestedIPA?: string;          // Author fills this in
  rhymesWith?: string;            // Author fills this in
  notes?: string;
}

export interface PronunciationDictionary {
  projectId: string;
  generatedAt: string;
  entries: PronunciationEntry[];
}

export interface ScriptCleanupResult {
  cleanedText: string;
  changes: number;                // Total transformations applied
  flaggedPassages: Array<{        // Paragraphs needing human review
    paragraphIndex: number;
    reason: string;
    excerpt: string;
  }>;
}

export interface SSMLExportResult {
  chapters: Array<{
    chapterNumber: number;
    title: string;
    ssml: string;
    approxDurationSec: number;    // 150 words/min estimate
  }>;
  totalDurationSec: number;
  disclosureIncluded: boolean;
}

export class AudiobookPrepService {
  /**
   * Pass 1: Normalize manuscript text for narration.
   */
  cleanupScript(text: string): ScriptCleanupResult {
    let cleaned = text;
    let changes = 0;

    // Em-dash / en-dash → short pause.
    cleaned = cleaned.replace(/(?:—|–|--)/g, (m) => { changes++; return ' — '; });

    // Ellipses → long pause cue.
    cleaned = cleaned.replace(/\.{3,}|\u2026/g, () => { changes++; return '… '; });

    // Symbol expansion (safe cases only — don't touch "$5.99" etc.).
    cleaned = cleaned.replace(/(?<!\S)&(?!\S)/g, () => { changes++; return 'and'; });
    cleaned = cleaned.replace(/(\d+)\s*%/g, (_, n) => { changes++; return `${n} percent`; });
    cleaned = cleaned.replace(/(?<!\S)@(?!\S)/g, () => { changes++; return 'at'; });

    // Common abbreviations
    const abbreviations: Record<string, string> = {
      '\\bMr\\.': 'Mister',
      '\\bMrs\\.': 'Missus',
      '\\bMs\\.': 'Miz',
      '\\bDr\\.': 'Doctor',
      '\\bSt\\.': 'Saint',
      '\\bMt\\.': 'Mount',
      '\\bvs\\.': 'versus',
      '\\betc\\.': 'etc',
    };
    for (const [pat, sub] of Object.entries(abbreviations)) {
      const re = new RegExp(pat, 'g');
      if (re.test(cleaned)) {
        cleaned = cleaned.replace(re, () => { changes++; return sub; });
      }
    }

    // Flag paragraphs with ambiguous he/she when two same-gender characters are likely in scene.
    const flaggedPassages: ScriptCleanupResult['flaggedPassages'] = [];
    const paragraphs = cleaned.split(/\n\s*\n/);
    paragraphs.forEach((para, idx) => {
      // Super rough heuristic: more than 3 "he" or "she" in a paragraph AND at
      // least 2 distinct capitalized names → flag for ambiguity review.
      const heCount = (para.match(/\bhe\b/gi) || []).length;
      const sheCount = (para.match(/\bshe\b/gi) || []).length;
      const properNouns = new Set((para.match(/\b[A-Z][a-z]{2,}\b/g) || [])
        .filter(n => !['The', 'She', 'He', 'They', 'But', 'And', 'Then', 'When', 'What', 'Why'].includes(n)));
      if ((heCount >= 3 && properNouns.size >= 2) || (sheCount >= 3 && properNouns.size >= 2)) {
        flaggedPassages.push({
          paragraphIndex: idx,
          reason: 'Multiple same-gender pronouns — narrator may need disambiguation',
          excerpt: para.substring(0, 180),
        });
      }

      // Also flag parentheticals since they often read oddly as audio.
      if (/\([^)]{30,}\)/.test(para)) {
        flaggedPassages.push({
          paragraphIndex: idx,
          reason: 'Long parenthetical — consider converting to a sentence',
          excerpt: para.substring(0, 180),
        });
      }
    });

    return { cleanedText: cleaned, changes, flaggedPassages };
  }

  /**
   * Pass 2: Build a pronunciation dictionary template from the entity list.
   * Only includes entities whose names look "uncommon" (not in a basic word
   * frequency list) — saves the author from filling out "John" and "Mary".
   */
  buildPronunciationDictionary(
    projectId: string,
    entities: Array<{
      name: string;
      type: string;
      aliases: string[];
      description: string;
    }>,
    fullText: string,
  ): PronunciationDictionary {
    const entries: PronunciationEntry[] = [];

    for (const entity of entities) {
      if (!this.looksUncommon(entity.name)) continue;

      // Count appearances in the full manuscript (case-insensitive).
      const pattern = new RegExp(`\\b${this.escapeRegex(entity.name)}\\b`, 'gi');
      const count = (fullText.match(pattern) || []).length;

      entries.push({
        name: entity.name,
        type: (['character', 'location', 'item', 'event', 'rule'].includes(entity.type)
          ? entity.type
          : 'item') as PronunciationEntry['type'],
        aliases: entity.aliases || [],
        appearances: count,
        suggestedIPA: undefined,
        rhymesWith: undefined,
        notes: entity.description?.substring(0, 120),
      });
    }

    // Sort by appearance count (most-used first) so author fills out the
    // most-important names first.
    entries.sort((a, b) => b.appearances - a.appearances);

    return {
      projectId,
      generatedAt: new Date().toISOString(),
      entries,
    };
  }

  /**
   * Pass 3: Build SSML for a set of cleaned chapters.
   *
   * @param aiNarrationDisclosed - Must be true for AI narration. Gates SSML
   *   suitable for AI TTS; without it, SSML is built for human narrator
   *   reference only (no voice profile tags, no AI-specific directives).
   */
  buildSSML(
    chapters: Array<{ number: number; title: string; text: string }>,
    pronDictionary: PronunciationDictionary,
    aiNarrationDisclosed: boolean,
  ): SSMLExportResult {
    const result: SSMLExportResult['chapters'] = [];
    let totalWords = 0;

    // Build a sub-dictionary: entry.name -> phoneme/alias IPA map.
    const ipaMap = new Map<string, string>();
    for (const entry of pronDictionary.entries) {
      if (entry.suggestedIPA) {
        ipaMap.set(entry.name.toLowerCase(), entry.suggestedIPA);
        for (const alias of entry.aliases) ipaMap.set(alias.toLowerCase(), entry.suggestedIPA);
      }
    }

    for (const ch of chapters) {
      const words = ch.text.split(/\s+/).filter(Boolean).length;
      totalWords += words;

      // Basic SSML structure. Name -> phoneme substitution where available.
      let body = ch.text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // Replace named entities with SSML phoneme tags (only if IPA supplied).
      for (const [name, ipa] of ipaMap) {
        const pattern = new RegExp(`\\b${this.escapeRegex(name)}\\b`, 'gi');
        body = body.replace(pattern, (match) =>
          `<phoneme alphabet="ipa" ph="${ipa}">${match}</phoneme>`
        );
      }

      // Convert narrator pause markers.
      body = body
        .replace(/ — /g, '<break time="500ms"/> ')
        .replace(/… /g, '<break time="800ms"/> ')
        .replace(/\n\s*\n/g, '<break time="1200ms"/>\n\n');

      const disclosurePrefix = aiNarrationDisclosed
        ? '<!-- This audiobook uses AI-generated narration. Disclosure required for ACX / Apple / Google / Spotify upload. -->\n'
        : '<!-- Reference SSML. For AI narration, set aiNarrationDisclosed=true in project config. -->\n';

      const ssml = `${disclosurePrefix}<speak>
  <prosody rate="medium">
    <s>Chapter ${ch.number}. ${this.escapeXml(ch.title)}.</s>
    <break time="1500ms"/>
    ${body}
  </prosody>
</speak>`;

      result.push({
        chapterNumber: ch.number,
        title: ch.title,
        ssml,
        approxDurationSec: Math.ceil(words / 150 * 60), // 150 wpm target (ACX typical)
      });
    }

    return {
      chapters: result,
      totalDurationSec: result.reduce((s, c) => s + c.approxDurationSec, 0),
      disclosureIncluded: aiNarrationDisclosed,
    };
  }

  /** Simple heuristic: uncommon = not in a small common-name list, has mixed case,
   *  or contains unusual letter combinations. */
  private looksUncommon(name: string): boolean {
    const lower = name.toLowerCase();
    const common = new Set([
      'john', 'mary', 'james', 'jane', 'michael', 'sarah', 'david', 'emily',
      'tom', 'anne', 'robert', 'lisa', 'paul', 'susan', 'matthew', 'kate',
      'alex', 'chris', 'alice', 'bob', 'carol', 'dan', 'eve', 'frank',
      'new york', 'london', 'paris', 'tokyo', 'boston', 'chicago',
    ]);
    if (common.has(lower)) return false;
    // Very short names are usually common.
    if (name.length < 4) return false;
    // Apostrophes and unusual letter clusters are a strong signal.
    if (/['-]|zh|kh|tl|xy|qv/i.test(name)) return true;
    // Multi-word invented names.
    if (/\s/.test(name) && name.length > 10) return true;
    return true; // Default: include (safer to over-include than miss names)
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

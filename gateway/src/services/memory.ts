/**
 * AuthorClaw Memory Service
 * Book-aware persistent memory with character sheets, plot threads, world building
 */

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

interface MemoryConfig {
  maxConversationHistory: number;
  maxMemoryEntries: number;
  autoSummarize: boolean;
}

export class MemoryService {
  private memoryDir: string;
  private config: MemoryConfig;
  private conversationSummaries: string[] = [];
  private activeProjectPath: string | null = null;
  private activePersonaId: string | null = null;

  constructor(memoryDir: string, config: Partial<MemoryConfig>) {
    this.memoryDir = memoryDir;
    this.config = {
      maxConversationHistory: config.maxConversationHistory ?? 50,
      maxMemoryEntries: config.maxMemoryEntries ?? 200,
      autoSummarize: config.autoSummarize ?? true,
    };
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.memoryDir, 'conversations'), { recursive: true });
    await mkdir(join(this.memoryDir, 'book-bible'), { recursive: true });
    await mkdir(join(this.memoryDir, 'voice-data'), { recursive: true });

    // Load existing summaries
    const summaryPath = join(this.memoryDir, 'summaries.json');
    if (existsSync(summaryPath)) {
      const raw = await readFile(summaryPath, 'utf-8');
      this.conversationSummaries = JSON.parse(raw);
    }

    // Check for active project
    const activePath = join(this.memoryDir, 'active-project.txt');
    if (existsSync(activePath)) {
      this.activeProjectPath = (await readFile(activePath, 'utf-8')).trim();
    }

    // Active persona — every conversation turn is tagged with this so each
    // pen name maintains its own memory boundary. Persists across restarts.
    const personaPath = join(this.memoryDir, 'active-persona.txt');
    if (existsSync(personaPath)) {
      this.activePersonaId = (await readFile(personaPath, 'utf-8')).trim() || null;
    }
  }

  /** Get the persona currently tagging new conversation turns. */
  getActivePersonaId(): string | null {
    return this.activePersonaId;
  }

  /** Get the project currently tagging new conversation turns. */
  getActiveProjectId(): string | null {
    return this.activeProjectPath;
  }

  /**
   * Switch the active persona. All subsequent conversation turns will be
   * tagged with this personaId so memory search can filter by pen name.
   * Pass null to clear (= unscoped / shared memory).
   */
  async setActivePersona(personaId: string | null): Promise<void> {
    this.activePersonaId = personaId;
    const personaPath = join(this.memoryDir, 'active-persona.txt');
    await writeFile(personaPath, personaId || '');
  }

  async getRelevant(query: string): Promise<string> {
    const parts: string[] = [];

    // Get conversation summaries (last 5)
    const recentSummaries = this.conversationSummaries.slice(-5);
    if (recentSummaries.length > 0) {
      parts.push('Recent context:\n' + recentSummaries.join('\n'));
    }

    // Get book bible entries if a project is active
    if (this.activeProjectPath) {
      const biblePath = join(this.memoryDir, 'book-bible', this.activeProjectPath);
      if (existsSync(biblePath)) {
        const files = (await readdir(biblePath)).sort();
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        // Read all files and score by keyword relevance
        const scored: { file: string; content: string; score: number }[] = [];
        for (const file of files) {
          const content = await readFile(join(biblePath, file), 'utf-8');
          let score = 0;
          if (queryWords.length > 0) {
            const lowerFile = file.toLowerCase();
            const lowerContent = content.toLowerCase();
            for (const word of queryWords) {
              if (lowerFile.includes(word)) score += 2;
              if (lowerContent.includes(word)) score += 1;
            }
          }
          scored.push({ file, content, score });
        }

        // Sort by relevance score descending, then alphabetically for ties
        scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

        for (const { file, content } of scored.slice(0, 10)) {
          parts.push(`[${file}]: ${content.substring(0, 5000)}`);
        }
      }
    }

    return parts.join('\n\n');
  }

  async getActiveProject(): Promise<string | null> {
    if (!this.activeProjectPath) return null;
    const projectFile = join(this.memoryDir, 'book-bible', this.activeProjectPath, 'project.md');
    if (existsSync(projectFile)) {
      return await readFile(projectFile, 'utf-8');
    }
    return null;
  }

  /**
   * Live-index hook — wired by the gateway after construction so memory
   * turns are FTS-indexed in addition to being persisted to JSONL.
   */
  private liveIndexHook: ((entry: {
    user: string;
    assistant: string;
    timestamp: string;
    personaId?: string | null;
    projectId?: string | null;
  }) => void) | null = null;

  setLiveIndexHook(fn: typeof this.liveIndexHook): void {
    this.liveIndexHook = fn;
  }

  async process(
    userMessage: string,
    assistantResponse: string,
    context?: { personaId?: string | null; projectId?: string | null }
  ): Promise<void> {
    // Store conversation turn. If the caller didn't supply persona/project
    // context, fall back to the currently-active ones tracked by this service.
    const today = new Date().toISOString().split('T')[0];
    const timestamp = new Date().toISOString();
    const logPath = join(this.memoryDir, 'conversations', `${today}.jsonl`);
    const personaId = context?.personaId !== undefined ? context.personaId : this.activePersonaId;
    const projectId = context?.projectId !== undefined ? context.projectId : this.activeProjectPath;
    const entry = JSON.stringify({
      timestamp,
      user: userMessage.substring(0, 5000),
      assistant: assistantResponse.substring(0, 5000),
      // Per-persona / per-project tagging (Hermes-inspired). Lets memory
      // search filter conversations by pen name and project so each
      // identity has a clean memory boundary.
      personaId,
      projectId,
    }) + '\n';
    const { appendFile } = await import('fs/promises');
    await appendFile(logPath, entry);

    // Live FTS index (no-op if search service unavailable)
    try {
      this.liveIndexHook?.({
        user: userMessage.substring(0, 5000),
        assistant: assistantResponse.substring(0, 5000),
        timestamp,
        personaId,
        projectId,
      });
    } catch { /* search indexing failures should never block memory writes */ }
  }

  /** Sanitize a path segment — strip traversal, separators, and null bytes. */
  private sanitizeSegment(segment: string, fallback: string): string {
    const cleaned = String(segment || '')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.\.+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 200);
    return cleaned || fallback;
  }

  async setActiveProject(projectId: string): Promise<void> {
    const safeId = this.sanitizeSegment(projectId, 'project');
    this.activeProjectPath = safeId;
    await writeFile(
      join(this.memoryDir, 'active-project.txt'),
      safeId
    );
  }

  async saveBookBibleEntry(projectId: string, filename: string, content: string): Promise<void> {
    const safeProject = this.sanitizeSegment(projectId, 'project');
    const safeFile = this.sanitizeSegment(filename, 'entry.md');
    const dir = join(this.memoryDir, 'book-bible', safeProject);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeFile), content);
  }

  /**
   * Reset all memory — conversations, summaries, active project.
   * Preserves book-bible entries (project data) unless fullReset is true.
   * Called when a user wants a clean slate.
   */
  async reset(fullReset = false): Promise<{ cleared: string[] }> {
    const { rm } = await import('fs/promises');
    const cleared: string[] = [];

    // Clear conversation logs
    const convDir = join(this.memoryDir, 'conversations');
    if (existsSync(convDir)) {
      await rm(convDir, { recursive: true });
      await mkdir(convDir, { recursive: true });
      cleared.push('conversations');
    }

    // Clear summaries
    const summaryPath = join(this.memoryDir, 'summaries.json');
    if (existsSync(summaryPath)) {
      await rm(summaryPath);
      this.conversationSummaries = [];
      cleared.push('summaries');
    }

    // Clear active project reference
    const activePath = join(this.memoryDir, 'active-project.txt');
    if (existsSync(activePath)) {
      await rm(activePath);
      this.activeProjectPath = null;
      cleared.push('active-project');
    }

    // Optionally clear book-bible and voice-data
    if (fullReset) {
      const bibleDir = join(this.memoryDir, 'book-bible');
      if (existsSync(bibleDir)) {
        await rm(bibleDir, { recursive: true });
        await mkdir(bibleDir, { recursive: true });
        cleared.push('book-bible');
      }

      const voiceDir = join(this.memoryDir, 'voice-data');
      if (existsSync(voiceDir)) {
        await rm(voiceDir, { recursive: true });
        await mkdir(voiceDir, { recursive: true });
        cleared.push('voice-data');
      }
    }

    return { cleared };
  }
}

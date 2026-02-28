/**
 * AuthorClaw Telegram Bridge
 * Secure Telegram bot integration — acts as a command center
 * Users give orders via Telegram, AuthorClaw executes in the VM
 */

interface TelegramConfig {
  allowedUsers: string[];
  pairingEnabled: boolean;
}

/** Handler for direct commands that interact with gateway services */
interface CommandHandlers {
  createProject: (title: string, description: string, config?: Record<string, any>) => Promise<{ id: string; steps: number }>;
  startAndRunProject: (projectId: string) => Promise<{ completed: string; response: string; wordCount: number; nextStep?: string } | { error: string }>;
  autoRunProject: (projectId: string, statusCallback: (msg: string) => Promise<void>) => Promise<void>;
  listProjects: () => Array<{ id: string; title: string; status: string; progress: string }>;
  saveToFile: (filename: string, content: string) => Promise<void>;
  handleMessage: (content: string, channel: string, respond: (text: string) => void) => Promise<void>;
  research: (query: string) => Promise<{ results: string; error?: string }>;
  listFiles: (subdir?: string) => Promise<string[]>;
  readFile: (filename: string) => Promise<{ content: string; error?: string }>;
}

export class TelegramBridge {
  private token: string;
  private config: TelegramConfig;
  private pollingInterval: ReturnType<typeof setInterval> | null = null; // Legacy compat
  private polling = false;
  private messageHandler?: (content: string, channel: string, respond: (text: string) => void) => Promise<void>;
  private commandHandlers?: CommandHandlers;
  private lastUpdateId = 0;
  public pauseRequested = false;
  private knownChatIds: Set<number> = new Set(); // Track chat IDs for broadcasting
  private lastFileList: string[] = []; // For /read # file picker

  constructor(token: string, config: Partial<TelegramConfig>) {
    this.token = token;
    this.config = {
      allowedUsers: config.allowedUsers || [],
      pairingEnabled: config.pairingEnabled ?? true,
    };
  }

  onMessage(handler: (content: string, channel: string, respond: (text: string) => void) => Promise<void>) {
    this.messageHandler = handler;
  }

  /** Set command handlers for direct gateway interaction */
  setCommandHandlers(handlers: CommandHandlers) {
    this.commandHandlers = handlers;
  }

  async connect(): Promise<void> {
    // Verify bot token
    const response = await fetch(`https://api.telegram.org/bot${this.token}/getMe`);
    if (!response.ok) {
      throw new Error('Invalid Telegram bot token');
    }

    // Start sequential polling (not setInterval — prevents duplicate message processing)
    this.polling = true;
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      await this.poll();
      // Small delay between polls to prevent tight loops on errors
      if (this.polling) await new Promise(r => setTimeout(r, 500));
    }
  }

  private async poll(): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000); // slightly longer than Telegram timeout

      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      const data = await response.json() as any;

      for (const update of data.result || []) {
        this.lastUpdateId = update.update_id;
        const message = update.message;
        if (!message?.text) continue;

        const userId = String(message.from.id);
        const chatId = message.chat.id;
        const userName = message.from.first_name || 'there';

        // Check if user is allowed
        if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
          await this.sendMessage(chatId,
            '🔒 Not authorized. Ask the owner to add your ID (' + userId + ') in the dashboard.');
          continue;
        }

        // Track chat ID for broadcasting (only for allowed users)
        this.knownChatIds.add(chatId);

        // Route to appropriate handler
        await this.handleInput(chatId, message.text, userName);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return; // Normal timeout, just retry
      console.error('Telegram poll error:', error);
    }
  }

  private async handleInput(chatId: number, text: string, userName: string): Promise<void> {

    // ── /start and /help ──
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.sendMessage(chatId,
        `✍️ Hey ${userName}! I'm AuthorClaw.\n\n` +
        `Tell me what to do and I'll figure out the steps.\n\n` +
        `*Commands:*\n` +
        `/novel [idea] — Start a full novel pipeline\n` +
        `/project [task] — Plan & auto-execute a task\n` +
        `/write [idea] — Plan & write a book\n` +
        `/projects — List all projects\n` +
        `/status — Project status\n` +
        `/research [topic] — Research a topic\n` +
        `/files — List files (numbered)\n` +
        `/read [# or name] — Read a file\n` +
        `/export [# or name] — Export to Word/EPUB/PDF\n` +
        `/stop — Stop/pause active project\n\n` +
        `Or just chat with me.`);
      return;
    }

    // ── /novel — Create a novel-pipeline project (replaces /conductor) ──
    // Also accept /conductor as alias for backward compatibility
    if (text.startsWith('/novel') || text.startsWith('/conductor')) {
      const idea = text.replace(/^\/(novel|conductor)\s*/, '').trim();
      if (!idea) {
        await this.sendMessage(chatId, `What novel should I write?\n/novel a sci-fi thriller about rogue AI\n/novel a cozy mystery set in a bookshop`);
        return;
      }
      if (this.commandHandlers) {
        try {
          const result = await this.commandHandlers.createProject(idea, `Write a complete novel: ${idea}`);
          await this.sendMessage(chatId,
            `📖 Novel pipeline created: "${idea}"\n` +
            `${result.steps} steps (premise → bible → outline → chapters → revision → assembly)\n\n` +
            `Starting autonomous execution...`
          );
          // Auto-run the pipeline
          this.commandHandlers.autoRunProject(result.id, async (msg: string) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /write — Create a writing goal and AUTO-RUN all steps ──
    if (text.startsWith('/write')) {
      const idea = text.replace(/^\/write\s*/, '').trim();
      if (!idea) {
        await this.sendMessage(chatId, `What's the idea? Try:\n/write cyberpunk heist thriller about rogue AI`);
        return;
      }

      if (this.commandHandlers) {
        await this.sendMessage(chatId, `📝 On it. Planning "${idea}"...\nI'll figure out the steps and run them automatically.`);
        try {
          const project = await this.commandHandlers.createProject(idea, `Write a book: ${idea}`);
          await this.sendMessage(chatId, `✅ Planned ${project.steps} steps. Running autonomously...`);

          // Auto-run ALL steps
          await this.commandHandlers.autoRunProject(project.id, async (msg) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ Error: ${String(e)}`);
        }
      }
      return;
    }

    // ── /projects — List active projects (MUST be before /project to avoid parsing as "/project s") ──
    if (text === '/projects' || text.startsWith('/projects ') || text === '/goals' || text.startsWith('/goals ')) {
      if (this.commandHandlers) {
        const projects = this.commandHandlers.listProjects();
        if (projects.length === 0) {
          await this.sendMessage(chatId, `No projects yet. Create one with /project or /write`);
        } else {
          const list = projects.map(p =>
            `${p.status === 'completed' ? '✅' : p.status === 'active' ? '🔄' : p.status === 'failed' ? '❌' : '⏸'} ${p.title} (${p.progress})`
          ).join('\n');
          await this.sendMessage(chatId, `📋 *Projects:*\n${list}`);
        }
      }
      return;
    }

    // ── /project — Create ANY project and AUTO-RUN all steps ──
    if (text.startsWith('/project ') || text === '/project' || text.startsWith('/goal ') || text === '/goal') {
      const description = text.replace(/^\/(project|goal)\s*/, '').trim();
      if (!description) {
        await this.sendMessage(chatId,
          `📋 Tell me what to do:\n` +
          `/project write a full tech-thriller from start to finish\n` +
          `/project research medieval weapons for my fantasy novel\n` +
          `/project revise chapters 1-3 for pacing\n` +
          `/project create marketing materials for my book`);
        return;
      }

      if (this.commandHandlers) {
        try {
          await this.sendMessage(chatId, `🧠 Planning "${description}"...`);
          const project = await this.commandHandlers.createProject(description, description);
          await this.sendMessage(chatId,
            `✅ Planned ${project.steps} steps. Running autonomously...`);

          // Auto-run ALL steps
          await this.commandHandlers.autoRunProject(project.id, async (msg) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /status — Quick project status ──
    if (text.startsWith('/status')) {
      let summary = '';

      if (this.commandHandlers) {
        const projects = this.commandHandlers.listProjects();
        const active = projects.filter(p => p.status === 'active');
        const paused = projects.filter(p => p.status === 'paused');
        const completed = projects.filter(p => p.status === 'completed');

        if (active.length > 0) {
          summary += `🔄 ${active.length} project(s) running:\n` + active.map(p => `  • ${p.title} (${p.progress})`).join('\n') + '\n';
        }
        if (paused.length > 0) {
          summary += `⏸ ${paused.length} project(s) paused:\n` + paused.map(p => `  • ${p.title} (${p.progress})`).join('\n') + '\n';
        }
        if (completed.length > 0) {
          summary += `✅ ${completed.length} project(s) done\n`;
        }
      }

      if (!summary) summary = 'Nothing running. Use /project or /novel to start.\n';
      await this.sendMessage(chatId, summary + `\n📊 Dashboard: http://localhost:3847`);
      return;
    }

    // ── /research — Fetch from whitelisted domains ──
    if (text.startsWith('/research')) {
      const query = text.replace(/^\/research\s*/, '').trim();
      if (!query) {
        await this.sendMessage(chatId, `What should I research?\n/research medieval sword types\n/research self-publishing trends 2026`);
        return;
      }
      if (this.commandHandlers) {
        await this.sendMessage(chatId, `🔍 Researching "${query}"...`);
        try {
          const result = await this.commandHandlers.research(query);
          if (result.error) {
            await this.sendMessage(chatId, `⚠️ ${result.error}`);
          } else {
            await this.sendMessage(chatId, result.results);
          }
        } catch (e) {
          await this.sendMessage(chatId, `❌ Research failed: ${String(e)}`);
        }
      }
      return;
    }

    // ── /files — List project files with NUMBERED list for easy /read ──
    if (text.startsWith('/files')) {
      const subdir = text.replace(/^\/files\s*/, '').trim() || '';
      if (this.commandHandlers) {
        try {
          const files = await this.commandHandlers.listFiles(subdir);
          if (files.length === 0) {
            await this.sendMessage(chatId, `📁 No files found${subdir ? ` in ${subdir}` : ''}.\n\nFiles are saved to workspace/projects/ when you use /goal or /write.\nResearch goes to workspace/research/.`);
          } else {
            // Store file list for /read # selection
            this.lastFileList = files
              .filter(f => !f.includes('📁'))  // Only actual files, not directories
              .map(f => f.replace(/^[\s📄]+/, '').trim());

            let msg = `📁 *Files${subdir ? ` in ${subdir}` : ''}:*\n`;
            let fileNum = 1;
            for (const f of files) {
              if (f.includes('📁')) {
                msg += `\n${f}\n`;
              } else {
                msg += `  ${fileNum}. ${f.replace(/^[\s📄]+/, '').trim()}\n`;
                fileNum++;
              }
            }
            msg += `\n💡 Use /read 1 or /read 3 to read by number`;
            await this.sendMessage(chatId, msg);
          }
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /read — Read a file by NUMBER or name ──
    if (text.startsWith('/read')) {
      const input = text.replace(/^\/read\s*/, '').trim();
      if (!input) {
        await this.sendMessage(chatId, `📖 Use /files first to see numbered list, then:\n/read 1 — read file #1\n/read 3 — read file #3\n\nOr use full name:\n/read projects/my-book/premise.md`);
        return;
      }

      if (this.commandHandlers) {
        try {
          // Check if input is a number (file picker)
          let filename = input;
          const num = parseInt(input, 10);
          if (!isNaN(num) && this.lastFileList && num >= 1 && num <= this.lastFileList.length) {
            filename = this.lastFileList[num - 1];
          }

          const result = await this.commandHandlers.readFile(filename);
          if (result.error) {
            await this.sendMessage(chatId, `⚠️ ${result.error}\n\n💡 Use /files first, then /read 1 to read by number.`);
          } else {
            const preview = result.content.length > 2000
              ? result.content.substring(0, 2000) + `\n\n... (${result.content.length} chars total — view full in dashboard)`
              : result.content;
            await this.sendMessage(chatId, `📄 *${filename}:*\n\n${preview}`);
          }
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /export — Export manuscript files to Word/HTML/TXT (built-in, no external tools needed) ──
    if (text.startsWith('/export')) {
      const args = text.replace(/^\/export\s*/, '').trim();

      // Show help if no arguments
      if (!args) {
        await this.sendMessage(chatId,
          `📦 *Export your manuscript:*\n\n` +
          `/export [file] — Export to Word (.docx)\n` +
          `/export [file] html — Export as HTML\n` +
          `/export [file] txt — Export as plain text\n` +
          `/export [file] all — All formats\n\n` +
          `Use /files first, then:\n` +
          `/export 1 — Export file #1 to Word\n` +
          `/export 3 html — Export file #3 as HTML\n\n` +
          `Supported: docx, html, txt`);
        return;
      }

      try {
        // Parse: /export [file_or_number] [format]
        const parts = args.split(/\s+/);
        let filename = parts[0];
        const format = parts[1]?.toLowerCase() || 'docx';

        // Check if it's a number from the file picker
        const num = parseInt(filename, 10);
        if (!isNaN(num) && this.lastFileList && num >= 1 && num <= this.lastFileList.length) {
          filename = this.lastFileList[num - 1];
        }

        // Derive title from filename
        const title = filename.replace(/\.[^.]+$/, '')
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        await this.sendMessage(chatId, `📦 Exporting "${filename}" as ${format === 'all' ? 'all formats' : format.toUpperCase()}...`);

        const exportRes = await fetch('http://localhost:3847/api/author-os/format', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputFile: filename,
            title,
            formats: format === 'all' ? ['all'] : [format],
          }),
        });
        const exportData = await exportRes.json() as any;

        if (exportData.error) {
          await this.sendMessage(chatId, `❌ ${exportData.error}`);
        } else if (exportData.success) {
          const fileList = (exportData.files || []).map((f: string) => `  📄 ${f.split('/').pop()}`).join('\n');
          await this.sendMessage(chatId,
            `✅ Export complete!\n\n${fileList}\n\n📁 Saved to: workspace/exports/\nUse /files exports to see them.`);
        } else {
          await this.sendMessage(chatId, `⚠️ Export failed: ${exportData.error || 'Unknown error'}`);
        }
      } catch (e) {
        await this.sendMessage(chatId, `❌ Export error: ${String(e)}`);
      }
      return;
    }

    // ── /stop — Pause active project ──
    if (text.startsWith('/stop') || text.startsWith('/pause')) {
      const activeProject = this.commandHandlers
        ? this.commandHandlers.listProjects().find(p => p.status === 'active')
        : undefined;

      if (activeProject) {
        this.pauseRequested = true;
        try {
          await fetch(`http://localhost:3847/api/projects/${activeProject.id}/pause`, { method: 'POST' });
        } catch { /* silent */ }
        await this.sendMessage(chatId, `⏸ Paused "${activeProject.title}". Say "continue" to resume.`);
      } else {
        await this.sendMessage(chatId, `Nothing running right now.`);
      }
      return;
    }

    // ── "continue" / "next" — Resume or run next step of a paused goal ──
    const lower = text.toLowerCase().trim();
    if (lower === 'continue' || lower === 'next' || lower === 'go' || lower === 'resume') {
      if (this.commandHandlers) {
        const projects = this.commandHandlers.listProjects();
        const active = projects.find(p => p.status === 'active' || p.status === 'paused');
        if (!active) {
          await this.sendMessage(chatId, `No projects to continue. Create one with /project or /write`);
          return;
        }
        this.pauseRequested = false;
        await this.sendMessage(chatId, `▶️ Resuming "${active.title}"...`);
        try {
          await this.commandHandlers.autoRunProject(active.id, async (msg) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── Regular message — conversational chat via AI ──
    if (this.messageHandler) {
      // Prepend brevity instruction so AI keeps it short for Telegram
      const telegramPrompt = `[Telegram chat — keep your response SHORT and conversational, like texting a friend. 2-4 sentences max. No headers, no bullet lists, no essays. Only write long responses if the user explicitly asks for a full chapter, story, or detailed breakdown.]\n\n${text}`;
      await this.messageHandler(
        telegramPrompt,
        `telegram:${chatId}`,
        async (response) => {
          // sendMessage auto-splits at 4096 chars (Telegram's real limit)
          await this.sendMessage(chatId, response);
        }
      );
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    // Split long messages (Telegram limit: 4096 chars)
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });
      if (!response.ok) {
        // Retry without parse_mode in case Markdown formatting caused the error
        const retry = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
          }),
        });
        if (!retry.ok) {
          console.error('Telegram sendMessage failed:', await retry.text());
        }
      }
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < maxLength / 2) splitAt = maxLength;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }
    return chunks;
  }

  /** Update allowed users on a live bridge (called when dashboard saves users) */
  updateAllowedUsers(users: string[]): void {
    this.config.allowedUsers = users;
  }

  /**
   * Broadcast a message to all known allowed users.
   * Used by autonomous heartbeat to send status updates.
   */
  async broadcastToAllowed(message: string): Promise<void> {
    for (const chatId of this.knownChatIds) {
      try {
        await this.sendMessage(chatId, message);
      } catch (e) {
        console.error(`Telegram broadcast to ${chatId} failed:`, e);
      }
    }
  }

  disconnect(): void {
    this.polling = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}

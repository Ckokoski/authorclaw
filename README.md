# AuthorClaw

**The Autonomous AI Writing Agent — An OpenClaw Fork Built for Authors**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![Security](https://img.shields.io/badge/security-hardened-green.svg)](#security)

AuthorClaw is a security-hardened AI agent purpose-built for fiction and nonfiction authors. Yes, it can write entire books — but that's just the beginning.

**AuthorClaw automates the boring stuff so you can focus on the creative stuff.** It handles book research, marketing competition analysis, file management, beta reading, copy editing, revision assistance, book bible building, story consistency checking, query letter drafting, literary agent research, ad copy generation, email list strategy, and more — all autonomously.

Tell it what you want. It figures out the steps, picks the right skills and tools, and executes.

> **"It's not just a writing tool. It's a writing partner, research assistant, editor, and marketing team rolled into one."**

---

## What Can It Do?

- **Write** — Draft scenes, chapters, and full manuscripts in your voice
- **Research** — Deep dives into genres, markets, historical periods, craft techniques
- **Revise** — Structural editing, pacing analysis, style consistency checks
- **Plan** — Outlines, beat sheets, series bibles, character arcs, world-building
- **Beta Read** — First-reader feedback with specific, actionable notes
- **Market** — Blurbs, ad copy, email sequences, social media content
- **Analyze** — Voice profiling (47 markers), pacing heatmaps, tension mapping
- **Format** — Export manuscripts to agent-ready DOCX, KDP PDF, EPUB, Markdown
- **Manage** — Track projects, word counts, goals, deadlines
- **Ingest Tools** — Read source code of any tool and create a new skill from it

---

## How It Works

1. **You say what you want** — via Telegram, dashboard, or API
2. **AuthorClaw plans the steps** — AI dynamically decomposes your task into executable steps
3. **Skills are auto-selected** — 25+ writing skills get injected into each step's context
4. **Work happens autonomously** — each step runs through the AI, output saved to files
5. **Everything is logged** — universal activity feed tracks all agent actions in real-time

```
User: "/goal write a full tech-thriller about rogue AI in aviation"

AuthorClaw: "Planning... 12 steps identified"
  Step 1: Develop premise and logline        ✅ (~800 words)
  Step 2: Create character profiles          ✅ (~2,400 words)
  Step 3: Build world and settings           ✅ (~1,800 words)
  Step 4: Create timeline                    ✅ (~1,200 words)
  Step 5: Outline all chapters               ✅ (~3,500 words)
  Step 6: Write Chapter 1                    ✅ (~3,200 words)
  ...
  Step 12: Final assembly                    ✅

  "All 12 steps complete! Files saved to workspace/projects/"
```

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Ckokoski/authorclaw.git
cd authorclaw
npm install

# 2. Start AuthorClaw
npx tsx gateway/src/index.ts

# 3. Open dashboard: http://localhost:3847
#    Settings tab → paste your Gemini API key → Save
#    (Free tier — the whole book costs $0)

# 4. Agent tab → "Write me a tech-thriller about rogue AI" → Go
#    OR send /goal to your Telegram bot
```

See [QUICKSTART.md](QUICKSTART.md) for the full setup guide.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AUTHORCLAW v2 ARCHITECTURE                │
│                                                             │
│  ┌───────────┐   ┌─────────────────┐   ┌────────────────┐  │
│  │ Channels  │   │    Gateway       │   │  AI Router     │  │
│  │           │   │                  │   │                │  │
│  │ Telegram  │──▶│ Auth + Sandbox   │──▶│ Ollama (free)  │  │
│  │ Dashboard │   │ Rate Limiting    │   │ Gemini (free)  │  │
│  │ API       │   │ Injection Detect │   │ DeepSeek ($)   │  │
│  │ WebSocket │   │ Audit Logging    │   │ Claude ($$)    │  │
│  └───────────┘   └─────────────────┘   │ OpenAI ($$)    │  │
│                                         └────────────────┘  │
│  ┌───────────┐   ┌─────────────────┐   ┌────────────────┐  │
│  │ Soul      │   │ Goal Engine     │   │ Skills (25+)   │  │
│  │           │   │                  │   │                │  │
│  │ SOUL.md   │   │ Dynamic AI Plan │   │ Core           │  │
│  │ STYLE.md  │   │ Auto-Execute    │   │ Author (16)    │  │
│  │ VOICE.md  │   │ File Saving     │   │ Marketing (4)  │  │
│  │           │   │ Activity Log    │   │ Premium (6+)   │  │
│  └───────────┘   └─────────────────┘   └────────────────┘  │
│                                                             │
│  ┌───────────┐   ┌─────────────────┐   ┌────────────────┐  │
│  │ Security  │   │ Memory          │   │ Author OS      │  │
│  │           │   │                  │   │                │  │
│  │ Vault     │   │ Conversations   │   │ Workflow Engine │  │
│  │ Sandbox   │   │ Book Bible      │   │ Book Bible     │  │
│  │ Audit     │   │ Voice Profile   │   │ Manuscript     │  │
│  │ Injection │   │ Summaries       │   │ Format Factory │  │
│  └───────────┘   └─────────────────┘   └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## AI Providers

AuthorClaw supports 5 AI providers with tiered routing:

| Provider | Tier | Cost | Best For | Setup |
|----------|------|------|----------|-------|
| Ollama | FREE | $0 | Local, private | Install Ollama, runs at localhost:11434 |
| Google Gemini | FREE | $0 | General writing, planning | Dashboard → Settings → paste Gemini key |
| DeepSeek | CHEAP | ~$0.14/M tokens | Creative writing | Dashboard → Settings → paste DeepSeek key |
| Anthropic Claude | PAID | ~$3/M tokens | Complex reasoning, editing | Dashboard → Settings → paste Anthropic key |
| OpenAI GPT-4o | PAID | ~$2.5/M tokens | Alternative premium | Dashboard → Settings → paste OpenAI key |

Task routing is automatic — planning and research use free models, creative writing uses mid-tier, final editing uses premium (when available).

---

## Telegram Command Center

Connect a Telegram bot to control AuthorClaw from your phone:

| Command | What It Does |
|---------|-------------|
| `/goal [task]` | Tell AuthorClaw what to do — it plans steps and executes autonomously |
| `/write [idea]` | Shortcut for writing goals — plans a book from your idea |
| `/goals` | List all goals with status |
| `/status` | Quick status check |
| `/research [topic]` | Research a topic, save results to file |
| `/files [folder]` | List files in your workspace |
| `/read [file]` | Preview a file's contents |
| `/stop` | Pause the active goal |
| `continue` | Resume a paused goal |

### Example Session

```
You:      /goal write a full novel about rogue AI in aviation
AuthorClaw: Planning "write a full novel about rogue AI in aviation"...
AuthorClaw: Planned 15 steps. Running autonomously...
AuthorClaw: ✅ 1/15: Develop premise (~800 words)
            ⏭ Next: Create character profiles...
AuthorClaw: ✅ 2/15: Create character profiles (~2,400 words)
            ⏭ Next: Build world and settings...
...
AuthorClaw: 🎉 All 15 steps complete!
            📁 Files saved to workspace/projects/
```

---

## Dashboard

Open `http://localhost:3847` to access the web dashboard:

- **Settings** — API keys, AI providers, Ollama config, budgets, Telegram
- **Agent** — Give tasks, monitor goals, view skills
- **Activity Log** — Real-time feed of everything the agent does

---

## Dynamic Task Planning

When you give AuthorClaw a task, it doesn't use hardcoded templates. Instead:

1. The AI receives a catalog of all available skills (with descriptions and triggers)
2. The AI receives the list of Author OS tools
3. The AI dynamically plans the right number of steps, picks the right skills for each
4. Each step is executed with that skill's full content injected into the AI's context
5. Results from earlier steps are chained into later steps for continuity

If AI planning fails, the system falls back to template-based planning (8 goal types with pre-built step sequences).

---

## Skills

Skills are markdown files that teach the AI how to handle specific writing tasks:

**Author Skills (16):** premise, outline, write, revise, book-bible, series-bible, dialogue, style-clone, research, nonfiction-research, format, beta-reader, query-letter, manuscript-hub, market-research, promote

**Marketing Skills (4):** blurb-writer, ad-copy, social-media, email-list

**Core Skills:** full-pipeline (complete novel orchestration), plus system skills

**Tool Ingestion:** AuthorClaw can read source code of any tool and generate a new skill from it. Just say "create a skill from this code" or use `POST /api/tools/ingest`.

Skills are automatically matched by keyword triggers and injected into the AI's context.

### Premium Skills Bundle

The **AuthorClaw Premium Skills Bundle** adds advanced capabilities — available on our [Ko-Fi store](https://ko-fi.com/writingsecrets) *(link coming soon)*:

- **Ghostwriter Pro** — Scene generation, pacing analysis, tension mapping, deep write mode, dialogue polish
- **Series Architect** — Multi-book series planning, continuity engine, thread tracker, revenue projections
- **Book Launch Machine** — 60-day launch automation, ad copy factory, email sequences, social media calendar
- **Writing Secrets Integration** — Bridges for Book Bible Engine, Workflow Engine, and StyleClone Pro (47 voice markers)

Install: copy the skill folders to `skills/premium/` and restart. See `skills/premium/README.md` for details.

---

## Project Structure

```
authorclaw/
├── gateway/src/          # Core application
│   ├── index.ts          # Main entry point (gateway, handlers, bridges)
│   ├── ai/router.ts      # Multi-provider AI routing
│   ├── api/routes.ts     # REST API endpoints
│   ├── bridges/          # Telegram, Discord bridges
│   ├── security/         # Vault, audit, sandbox, injection detection
│   ├── services/         # Memory, soul, goals, activity log, heartbeat
│   └── skills/loader.ts  # Skill loading and matching
├── skills/               # Skill definitions (SKILL.md files)
│   ├── core/             # System skills (full-pipeline, etc.)
│   ├── author/           # Writing skills (16)
│   ├── marketing/        # Marketing skills (4)
│   └── premium/          # Premium skill packs (6+)
├── dashboard/dist/       # Web dashboard (single HTML file)
├── workspace/            # Working directory
│   ├── soul/             # SOUL.md, STYLE-GUIDE.md, VOICE-PROFILE.md
│   ├── memory/           # Conversations, book bible, summaries
│   ├── projects/         # Goal output files organized by project
│   ├── research/         # Research output files
│   ├── .activity/        # Universal activity log (JSONL)
│   └── .audit/           # Security audit log (JSONL)
├── config/               # Configuration files
│   ├── default.json      # Main config
│   ├── .vault/           # Encrypted API key storage
│   └── research-allowlist.json  # Approved research domains
└── scripts/              # Utility scripts
```

---

## Security

AuthorClaw inherits MoatBot-grade security:

- **Vault**: AES-256-GCM encrypted credential storage (scrypt KDF)
- **Sandbox**: Workspace-only file access enforcement
- **Audit**: Daily JSONL logs with categories (message, security, error, connection)
- **Injection Detection**: Pattern matching for prompt injection attempts
- **Rate Limiting**: Per-channel rate limits
- **Research Gate**: 38 whitelisted domains for internet access
- **Localhost Only**: Server binds to 127.0.0.1 (no external access)

---

## Setup Wizard

For a guided setup experience, run the interactive wizard:

```bash
bash scripts/setup-wizard.sh
```

It walks you through everything: OS detection, Node.js installation, Ollama setup, API key configuration, vault passphrase creation, and personalization (genre, word goals). It even generates a troubleshooting prompt you can paste into any AI chatbot if you get stuck.

---

## Contributing

AuthorClaw is open source and contributions are welcome! Whether you're an author with ideas for new skills, a developer who wants to improve the codebase, or a tinkerer who built a cool integration — we'd love your help.

### Ways to Contribute

- **New Skills** — Create SKILL.md files for writing tasks we haven't covered yet
- **Bug Fixes** — Find and fix issues in the gateway, dashboard, or bridges
- **New AI Providers** — Add support for additional AI services
- **New Bridges** — Build integrations for Slack, WhatsApp, Matrix, etc.
- **Dashboard Improvements** — The dashboard is a single HTML file — lots of room to grow
- **Documentation** — Better guides, tutorials, and examples
- **Author OS Tools** — Build new writing tools that integrate via the Author OS service

### How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-new-skill`)
3. Make your changes
4. Test locally (`npx tsx gateway/src/index.ts`)
5. Submit a Pull Request with a clear description

For new skills, just create a folder in `skills/author/` (or `skills/marketing/`, `skills/core/`) with a `SKILL.md` file following the existing format (YAML frontmatter + markdown body).

---

## Disclaimer

This software is provided "as is" without warranty of any kind. **Use at your own risk.** AuthorClaw is an experimental AI writing tool — some configuration and code tinkering may be required to get the agent working exactly the way you want it. AI outputs should always be reviewed by a human before publishing. The authors are not responsible for any content generated by the AI or any consequences of using this software.

AuthorClaw relies on third-party AI providers (Gemini, Claude, OpenAI, DeepSeek, Ollama). Usage of those services is subject to their respective terms and pricing. API costs are your responsibility.

## License

MIT License. See [LICENSE](LICENSE) for details.

Built with love for writers by an author who believes AI should amplify creativity, not replace it.

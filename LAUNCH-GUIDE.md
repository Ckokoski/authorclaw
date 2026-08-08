# AuthorAgent Launch Guide

Quick reference for starting, stopping, and managing AuthorAgent.

---

## Local PC (Windows — Direct)

### Start the server
```bash
cd C:\Users\chris\OneDrive\Documents\Automations\AuthorAgent\authoragent
npm start
```

### Start with auto-reload (development)
```bash
npm run dev
```

### Stop the server
Press `Ctrl+C` in the terminal, or:
```bash
taskkill /F /FI "WINDOWTITLE eq *authoragent*"
```

### Dashboard
Open browser to: **http://localhost:3847**

---

## VPS / Remote Server (Docker)

### First-time setup
```bash
# 1. Clone the repo
git clone https://github.com/Ckokoski/authoragent.git
cd authoragent

# 2. Install Node 22+ (if running without Docker)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Create .env with your vault key
echo "AUTHORCLAW_VAULT_KEY=your-64-char-hex-key-here" > .env
chmod 600 .env

# 4. Install dependencies (if running without Docker)
npm ci
```

### Start with Docker
```bash
# Build and start
npm run docker:up

# View logs
npm run docker:logs

# Stop
npm run docker:down
```

### Start without Docker (direct on VPS)
```bash
npm start
```

### Remote access (from your PC to VPS)
AuthorAgent binds to `127.0.0.1` only — it's not exposed to the internet by default.
Use an SSH tunnel to access it securely:
```bash
# On your local PC — creates a secure tunnel
ssh -L 3847:localhost:3847 user@your-vps-ip

# Then open: http://localhost:3847 on your PC
```

Or set up a reverse proxy (Nginx/Caddy) with HTTPS + auth for public access.

---

## Key Locations

| What | Path |
|---|---|
| Main code | `gateway/src/index.ts` |
| Dashboard | `dashboard/dist/index.html` |
| Skills | `skills/{core,author,marketing}/` (19 active, rest in `_archived/`) |
| Config | `config/default.json` (public), `config/user.json` (private) |
| Vault (encrypted keys) | `config/.vault/vault.enc` |
| Project outputs | `workspace/projects/` |
| Author Personas | `workspace/.config/personas.json` |
| Project state | `workspace/.config/projects-state.json` |
| Soul system | `workspace/soul/` |
| Memory/Bible | `workspace/memory/` |
| Self-improvement | `workspace/.agent/` |

## Multiple Books

One running AuthorAgent instance serves ONE **active book** at a time — all of
a book's state (memory, soul, book bible, personas, images, costs, etc.) is
per-book. `AUTHORCLAW_WORKSPACE_DIR` (see `.env.example`) is a ROOT that can
hold many isolated per-book workspaces at `<root>/<book-slug>/`.

**Existing single-book installs need no changes.** If the root already looks
like a flat single-book workspace (has `memory/`, `soul/`, or `projects/`
directly inside it) and no active book is selected, it's used in place exactly
as before.

To add a second book to the same root:

```bash
npm run book -- list                    # show books under the root + which is active
npm run book -- create "My Second Book" # scaffold <root>/my-second-book/
npm run book -- use my-second-book      # writes <root>/.active-book
# restart the gateway — switching is restart-scoped, services are boot-time singletons
```

`AUTHORCLAW_ACTIVE_BOOK` in `.env` overrides the `.active-book` pointer file if
you'd rather pin it there. Migrating an existing flat install into the
multi-book layout on purpose (e.g. to give it a proper slug alongside new
books) is one command and moves data, it doesn't copy/delete it:

```bash
npm run book -- migrate-legacy the-algorithm-of-wanting
```

**Need two books running at the same time, right now, with zero code
changes?** Skip all of the above and start a second AuthorAgent process with
its own `AUTHORCLAW_WORKSPACE_DIR` and its own `server.port`
(`config/user.json`) — fully isolated, two processes instead of one.

## API Keys (Dashboard > Settings)

All keys are stored in the encrypted vault. Set them via the dashboard:
1. Open **http://localhost:3847** > **Settings** tab
2. Enter API keys in the provider fields
3. Click **Save** — keys are encrypted with AES-256-GCM

| Provider | Where to get key | Cost |
|---|---|---|
| Gemini | https://aistudio.google.com/apikey | Free |
| Ollama | Install locally: https://ollama.ai | Free |
| OpenAI | https://platform.openai.com/api-keys | Paid |
| Claude | https://console.anthropic.com | Paid |
| DeepSeek | https://platform.deepseek.com | Cheap |

## Telegram Bot

1. Message **@BotFather** on Telegram → `/newbot`
2. Copy the bot token
3. Dashboard > Settings > paste token > Save
4. Dashboard > Telegram > enter your Telegram user ID > Save
5. Message your bot — it should respond

## Common Commands

```bash
# Check if server is running
curl http://localhost:3847/api/status

# TypeScript compile check (no output = success)
npx tsc --noEmit

# View project list
curl http://localhost:3847/api/projects/list | node -e "const d=require('fs').readFileSync(0,'utf8');JSON.parse(d).projects.forEach(p=>console.log(p.id,p.title,p.status,p.progress+'%'))"

# Compile manuscript from chapter files
curl -X POST http://localhost:3847/api/projects/PROJECT_ID/compile

# Resume a stuck project
curl -X POST http://localhost:3847/api/projects/PROJECT_ID/resume
```

## Ports

| Service | Port | Binding |
|---|---|---|
| AuthorAgent | 3847 | localhost only |
| Ollama (if installed) | 11434 | localhost only |

## Security Checklist

- [ ] `.env` file permissions set to 600 (`chmod 600 .env`)
- [ ] Vault key is unique 64-char hex (not the default)
- [ ] No API keys in plain text files
- [ ] Telegram bot token only in vault
- [ ] `.gitignore` covers `.env`, `vault.enc`, `user.json`, `workspace/`
- [ ] Server binds to `127.0.0.1` (default — don't change)
- [ ] SSH tunnel or HTTPS proxy for remote access

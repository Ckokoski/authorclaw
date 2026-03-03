#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# AuthorClaw Setup Wizard v4.0
# The Secure AI Writing Agent — By Writing Secrets
#
# This wizard handles everything:
# 1. Detects your operating system
# 2. Checks and installs Node.js if needed
# 3. Installs and configures Ollama (free local AI)
# 4. Walks you through API key setup
# 5. Creates your vault passphrase
# 6. Sets up your first project
# 7. Starts AuthorClaw
#
# Run with: bash setup-wizard.sh
# ═══════════════════════════════════════════════════════════════

set -e

# ── Colors and formatting ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# ── Helper functions ──
print_header() {
    clear
    echo ""
    echo -e "${PURPLE}  ╔═══════════════════════════════════════════╗${NC}"
    echo -e "${PURPLE}  ║                                           ║${NC}"
    echo -e "${PURPLE}  ║${WHITE}${BOLD}       AuthorClaw Setup Wizard v4.0       ${NC}${PURPLE}║${NC}"
    echo -e "${PURPLE}  ║${DIM}       The Secure AI Writing Agent         ${NC}${PURPLE}║${NC}"
    echo -e "${PURPLE}  ║                                           ║${NC}"
    echo -e "${PURPLE}  ╚═══════════════════════════════════════════╝${NC}"
    echo ""
}

step() {
    echo ""
    echo -e "${CYAN}  [$1/8]${NC} ${WHITE}${BOLD}$2${NC}"
    echo -e "  ${DIM}────────────────────────────────────────${NC}"
}

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${DIM}$1${NC}"; }
ask() { echo -ne "  ${BLUE}?${NC} $1"; }

wait_for_enter() {
    echo ""
    echo -ne "  ${DIM}Press Enter to continue...${NC}"
    read -r
}

# ── Detect OS ──
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        PACKAGE_MANAGER="brew"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS="linux"
        if command -v apt &> /dev/null; then
            PACKAGE_MANAGER="apt"
        elif command -v dnf &> /dev/null; then
            PACKAGE_MANAGER="dnf"
        elif command -v pacman &> /dev/null; then
            PACKAGE_MANAGER="pacman"
        else
            PACKAGE_MANAGER="unknown"
        fi
    elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
        OS="windows"
        PACKAGE_MANAGER="manual"
    else
        OS="unknown"
        PACKAGE_MANAGER="unknown"
    fi
}

# ═══════════════════════════════════════
# STEP 1: Welcome and OS Detection
# ═══════════════════════════════════════
print_header
detect_os

step "1" "Checking your system"

echo -e "  Detected: ${WHITE}${BOLD}$OS${NC} ($OSTYPE)"

if [[ "$OS" == "unknown" ]]; then
    warn "Could not detect your OS. The wizard will try to continue"
    warn "but you may need to install some things manually."
fi

if [[ "$OS" == "macos" ]]; then
    ok "macOS detected"
    # Check for Homebrew
    if command -v brew &> /dev/null; then
        ok "Homebrew is installed"
    else
        warn "Homebrew not found. Some auto-installs may not work."
        info "Install from: https://brew.sh"
    fi
fi

if [[ "$OS" == "linux" ]]; then
    ok "Linux detected (package manager: $PACKAGE_MANAGER)"
fi

if [[ "$OS" == "windows" ]]; then
    ok "Windows detected (running in Git Bash / WSL)"
    info "Some features may need manual installation on Windows."
fi

wait_for_enter

# ═══════════════════════════════════════
# STEP 2: Node.js
# ═══════════════════════════════════════
print_header
step "2" "Checking Node.js"

NEED_NODE=false

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2)
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)
    
    if [ "$NODE_MAJOR" -ge 22 ]; then
        ok "Node.js v${NODE_VERSION} is installed (v22+ required)"
    elif [ "$NODE_MAJOR" -ge 18 ]; then
        warn "Node.js v${NODE_VERSION} found. v22+ is recommended."
        ask "Continue with v${NODE_VERSION}? (should work, some features may differ) [Y/n]: "
        read -r yn
        if [[ "$yn" =~ ^[Nn]$ ]]; then
            NEED_NODE=true
        fi
    else
        fail "Node.js v${NODE_VERSION} is too old. Need v22+."
        NEED_NODE=true
    fi
else
    fail "Node.js is not installed."
    NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
    echo ""
    echo -e "  ${WHITE}Let's install Node.js 22:${NC}"
    echo ""
    
    if [[ "$OS" == "macos" ]] && command -v brew &> /dev/null; then
        ask "Install via Homebrew? [Y/n]: "
        read -r yn
        if [[ ! "$yn" =~ ^[Nn]$ ]]; then
            brew install node@22
            ok "Node.js installed via Homebrew"
        fi
    elif [[ "$OS" == "linux" && "$PACKAGE_MANAGER" == "apt" ]]; then
        ask "Install via apt (may need sudo)? [Y/n]: "
        read -r yn
        if [[ ! "$yn" =~ ^[Nn]$ ]]; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ok "Node.js installed"
        fi
    else
        echo -e "  ${YELLOW}Please install Node.js 22 manually:${NC}"
        echo -e "  ${WHITE}https://nodejs.org/en/download/${NC}"
        echo ""
        echo -e "  After installing, run this wizard again."
        exit 1
    fi
fi

wait_for_enter

# ═══════════════════════════════════════
# STEP 3: Ollama (Free Local AI)
# ═══════════════════════════════════════
print_header
step "3" "Setting up Ollama (free local AI)"

echo -e "  Ollama lets you run AI models on your own computer."
echo -e "  ${GREEN}It's free, private, and works offline.${NC}"
echo -e "  ${DIM}Your manuscript never leaves your machine when using Ollama.${NC}"
echo ""

OLLAMA_INSTALLED=false
OLLAMA_RUNNING=false

if command -v ollama &> /dev/null; then
    OLLAMA_INSTALLED=true
    ok "Ollama is installed"
    
    # Check if running
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        OLLAMA_RUNNING=true
        ok "Ollama is running"
        
        # Check for models
        MODELS=$(curl -s http://localhost:11434/api/tags | grep -o '"name":"[^"]*"' | cut -d'"' -f4)
        if [ -n "$MODELS" ]; then
            ok "Models found:"
            echo "$MODELS" | while read -r model; do
                echo -e "     ${DIM}•${NC} $model"
            done
        else
            warn "No models installed yet"
        fi
    else
        warn "Ollama is installed but not running"
        ask "Start Ollama now? [Y/n]: "
        read -r yn
        if [[ ! "$yn" =~ ^[Nn]$ ]]; then
            ollama serve &> /dev/null &
            sleep 3
            if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
                OLLAMA_RUNNING=true
                ok "Ollama started"
            else
                warn "Could not start Ollama. Try running 'ollama serve' in another terminal."
            fi
        fi
    fi
else
    echo -e "  Ollama is not installed."
    echo ""
    ask "Would you like to install Ollama? (Recommended) [Y/n]: "
    read -r yn
    
    if [[ ! "$yn" =~ ^[Nn]$ ]]; then
        if [[ "$OS" == "macos" ]]; then
            echo -e "  ${WHITE}Installing Ollama for macOS...${NC}"
            if command -v brew &> /dev/null; then
                brew install ollama
            else
                curl -fsSL https://ollama.com/install.sh | sh
            fi
        elif [[ "$OS" == "linux" ]]; then
            echo -e "  ${WHITE}Installing Ollama for Linux...${NC}"
            curl -fsSL https://ollama.com/install.sh | sh
        else
            echo ""
            echo -e "  ${YELLOW}Please install Ollama manually:${NC}"
            echo -e "  ${WHITE}https://ollama.com/download${NC}"
            echo ""
            echo -e "  ${DIM}After installing, run this wizard again or continue without it.${NC}"
        fi
        
        if command -v ollama &> /dev/null; then
            OLLAMA_INSTALLED=true
            ok "Ollama installed"
            
            # Start it
            ollama serve &> /dev/null &
            sleep 3
            OLLAMA_RUNNING=true
        fi
    else
        info "Skipping Ollama. You'll need at least one AI provider."
        info "You can install Ollama later from https://ollama.com"
    fi
fi

# Pull a model if Ollama is running but has no models
if [ "$OLLAMA_RUNNING" = true ]; then
    MODEL_COUNT=$(curl -s http://localhost:11434/api/tags | grep -c '"name"' 2>/dev/null || echo "0")
    if [ "$MODEL_COUNT" -eq 0 ]; then
        echo ""
        echo -e "  ${WHITE}Let's download an AI model. This is a one-time download.${NC}"
        echo ""
        echo -e "  ${BOLD}Choose a model:${NC}"
        echo -e "    ${WHITE}1)${NC} llama3.2 (2GB)     — Good balance of speed and quality"
        echo -e "    ${WHITE}2)${NC} mistral (4GB)      — Strong at creative writing"
        echo -e "    ${WHITE}3)${NC} qwen2.5 (4.7GB)    — Good at following instructions"
        echo -e "    ${WHITE}4)${NC} Skip for now"
        echo ""
        ask "Choose [1-4]: "
        read -r MODEL_CHOICE
        
        case $MODEL_CHOICE in
            1) echo "  Downloading llama3.2 (~2GB, may take a few minutes)..."
               ollama pull llama3.2 && ok "llama3.2 ready" ;;
            2) echo "  Downloading mistral (~4GB, may take a few minutes)..."
               ollama pull mistral && ok "mistral ready" ;;
            3) echo "  Downloading qwen2.5 (~4.7GB, may take a few minutes)..."
               ollama pull qwen2.5 && ok "qwen2.5 ready" ;;
            *) info "Skipping model download. Run 'ollama pull llama3.2' later." ;;
        esac
    fi
fi

wait_for_enter

# ═══════════════════════════════════════
# STEP 4: API Keys (Optional Paid Providers)
# ═══════════════════════════════════════
print_header
step "4" "API keys (optional — for paid AI providers)"

echo -e "  ${DIM}You can skip all of these if you're using Ollama only.${NC}"
echo -e "  ${DIM}API keys are encrypted with AES-256 in AuthorClaw's vault.${NC}"
echo ""

GEMINI_KEY=""
CLAUDE_KEY=""
OPENAI_KEY=""
DEEPSEEK_KEY=""

# Gemini (free tier)
echo -e "  ${WHITE}Google Gemini${NC} ${GREEN}(has a free tier)${NC}"
echo -e "  ${DIM}Get a free key at: https://ai.google.dev${NC}"
ask "Do you have a Gemini API key? [y/N]: "
read -r yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
    ask "Paste your Gemini key: "
    read -rs GEMINI_KEY
    echo ""
    ok "Gemini key saved (will be encrypted)"
fi

echo ""

# Claude
echo -e "  ${WHITE}Anthropic Claude${NC} ${YELLOW}(paid — best for revision)${NC}"
echo -e "  ${DIM}Get a key at: https://console.anthropic.com${NC}"
ask "Do you have a Claude API key? [y/N]: "
read -r yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
    ask "Paste your Claude key: "
    read -rs CLAUDE_KEY
    echo ""
    ok "Claude key saved (will be encrypted)"
fi

echo ""

# OpenAI
echo -e "  ${WHITE}OpenAI GPT-4o${NC} ${YELLOW}(paid — best for marketing copy)${NC}"
echo -e "  ${DIM}Get a key at: https://platform.openai.com/api-keys${NC}"
ask "Do you have an OpenAI API key? [y/N]: "
read -r yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
    ask "Paste your OpenAI key: "
    read -rs OPENAI_KEY
    echo ""
    ok "OpenAI key saved (will be encrypted)"
fi

echo ""

# DeepSeek
echo -e "  ${WHITE}DeepSeek${NC} ${GREEN}(very cheap — $0.14/million tokens)${NC}"
echo -e "  ${DIM}Get a key at: https://platform.deepseek.com${NC}"
ask "Do you have a DeepSeek API key? [y/N]: "
read -r yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
    ask "Paste your DeepSeek key: "
    read -rs DEEPSEEK_KEY
    echo ""
    ok "DeepSeek key saved (will be encrypted)"
fi

# Count configured providers
PROVIDER_COUNT=0
[ "$OLLAMA_RUNNING" = true ] && PROVIDER_COUNT=$((PROVIDER_COUNT + 1))
[ -n "$GEMINI_KEY" ] && PROVIDER_COUNT=$((PROVIDER_COUNT + 1))
[ -n "$CLAUDE_KEY" ] && PROVIDER_COUNT=$((PROVIDER_COUNT + 1))
[ -n "$OPENAI_KEY" ] && PROVIDER_COUNT=$((PROVIDER_COUNT + 1))
[ -n "$DEEPSEEK_KEY" ] && PROVIDER_COUNT=$((PROVIDER_COUNT + 1))

echo ""
if [ "$PROVIDER_COUNT" -eq 0 ]; then
    fail "No AI providers configured. AuthorClaw needs at least one."
    echo -e "  ${YELLOW}Please install Ollama or add at least one API key.${NC}"
    echo -e "  ${DIM}Run this wizard again after setting up a provider.${NC}"
    exit 1
else
    ok "$PROVIDER_COUNT AI provider(s) configured"
fi

wait_for_enter

# ═══════════════════════════════════════
# STEP 5: Vault Passphrase
# ═══════════════════════════════════════
print_header
step "5" "Setting your vault passphrase"

echo -e "  AuthorClaw encrypts all your API keys with AES-256."
echo -e "  You need a passphrase to unlock them."
echo ""
echo -e "  ${DIM}Choose something you'll remember. If you forget it,${NC}"
echo -e "  ${DIM}you'll need to re-enter your API keys.${NC}"
echo ""

VAULT_PASS=""
while [ -z "$VAULT_PASS" ]; do
    ask "Vault passphrase: "
    read -rs VAULT_PASS
    echo ""
    if [ ${#VAULT_PASS} -lt 4 ]; then
        warn "Passphrase should be at least 4 characters."
        VAULT_PASS=""
    fi
done

ask "Confirm passphrase: "
read -rs VAULT_CONFIRM
echo ""

if [ "$VAULT_PASS" != "$VAULT_CONFIRM" ]; then
    fail "Passphrases don't match. Using the first one entered."
fi

ok "Vault passphrase set"

wait_for_enter

# ═══════════════════════════════════════
# STEP 6: Install Dependencies
# ═══════════════════════════════════════
print_header
step "6" "Installing AuthorClaw"

echo -e "  Installing Node.js dependencies..."

cd "$(dirname "$0")/.." 2>/dev/null || cd "$(dirname "$0")"

if [ -f "package.json" ]; then
    npm install --silent 2>&1 | tail -1
    ok "Dependencies installed"
else
    fail "package.json not found. Make sure you're running this from the authorclaw directory."
    exit 1
fi

# Store vault passphrase — export for this session AND save to .env for persistence
export AUTHORCLAW_VAULT_KEY="$VAULT_PASS"

# Write to .env so dotenv auto-loads it on every future start
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
echo "AUTHORCLAW_VAULT_KEY=$VAULT_PASS" > "$PROJECT_DIR/.env"

ok "Vault passphrase configured"
info "Saved to .env — your API keys will persist across restarts."
info "Use the dashboard Settings tab or the vault API to save keys."

# Ensure workspace directories exist
mkdir -p workspace/memory/conversations
mkdir -p workspace/memory/book-bible
mkdir -p workspace/memory/voice-data
mkdir -p workspace/projects
mkdir -p workspace/exports
mkdir -p workspace/research
mkdir -p workspace/.audit

ok "Workspace directories ready"

wait_for_enter

# ═══════════════════════════════════════
# STEP 7: Quick Personalization
# ═══════════════════════════════════════
print_header
step "7" "Quick personalization"

echo -e "  ${DIM}Let's customize a few things. You can change these later.${NC}"
echo ""

# Author name
ask "Your name (for the Soul system): "
read -r AUTHOR_NAME
AUTHOR_NAME=${AUTHOR_NAME:-"Author"}

# Daily word goal
ask "Daily word goal [1000]: "
read -r WORD_GOAL
WORD_GOAL=${WORD_GOAL:-1000}

# Genre
echo ""
echo -e "  ${WHITE}What do you mainly write?${NC}"
echo -e "    1) Literary Fiction    5) Romance"
echo -e "    2) Thriller/Mystery    6) Sci-Fi/Fantasy"
echo -e "    3) Horror              7) Nonfiction"
echo -e "    4) Historical Fiction  8) Multiple/Other"
echo ""
ask "Choose [1-8]: "
read -r GENRE_CHOICE

case $GENRE_CHOICE in
    1) GENRE="literary fiction" ;;
    2) GENRE="thriller/mystery" ;;
    3) GENRE="horror" ;;
    4) GENRE="historical fiction" ;;
    5) GENRE="romance" ;;
    6) GENRE="sci-fi/fantasy" ;;
    7) GENRE="nonfiction" ;;
    *) GENRE="fiction" ;;
esac

# Write user config
cat > config/user.json << EOF
{
  "heartbeat": {
    "dailyWordGoal": $WORD_GOAL
  }
}
EOF

ok "Config saved: ${WORD_GOAL} words/day, $GENRE"

# Update SOUL.md with author name
if [ -f "workspace/soul/SOUL.md" ]; then
    sed -i "s/your author/${AUTHOR_NAME}/g" workspace/soul/SOUL.md 2>/dev/null || true
fi

wait_for_enter

# ═══════════════════════════════════════
# STEP 8: Done!
# ═══════════════════════════════════════
print_header
step "8" "Setup complete!"

echo ""
echo -e "  ${GREEN}${BOLD}AuthorClaw is ready.${NC}"
echo ""
echo -e "  ${WHITE}What was configured:${NC}"
echo ""
[ "$OLLAMA_RUNNING" = true ] && echo -e "    ${GREEN}✓${NC} Ollama (free local AI)"
[ -n "$GEMINI_KEY" ] && echo -e "    ${GREEN}✓${NC} Google Gemini"
[ -n "$CLAUDE_KEY" ] && echo -e "    ${GREEN}✓${NC} Anthropic Claude"
[ -n "$OPENAI_KEY" ] && echo -e "    ${GREEN}✓${NC} OpenAI GPT-4o"
[ -n "$DEEPSEEK_KEY" ] && echo -e "    ${GREEN}✓${NC} DeepSeek"
echo -e "    ${GREEN}✓${NC} Encrypted vault"
echo -e "    ${GREEN}✓${NC} Word goal: ${WORD_GOAL}/day"
echo -e "    ${GREEN}✓${NC} Genre focus: ${GENRE}"
echo ""
echo -e "  ${WHITE}${BOLD}To start AuthorClaw:${NC}"
echo ""
echo -e "    ${CYAN}cd ~/authorclaw && npx tsx gateway/src/index.ts${NC}"
echo ""
echo -e "  ${WHITE}Then open the dashboard:${NC} ${CYAN}http://localhost:3847${NC}"
echo ""
echo -e "  ${WHITE}The dashboard has 5 panels:${NC}"
echo -e "    ${GREEN}Home${NC}            — Chat with slash commands, writing stats, idle tasks"
echo -e "    ${GREEN}Projects${NC}        — Create & auto-execute writing projects (7 templates + full novel pipeline)"
echo -e "    ${GREEN}Personas${NC}        — Manage pen names with distinct genres, voices, and styles"
echo -e "    ${GREEN}Library${NC}         — Document uploads, manuscripts, DOCX/EPUB downloads"
echo -e "    ${GREEN}Settings${NC}        — API keys, TTS voices, Telegram, autonomous mode, idle tasks"
echo ""
echo -e "  ────────────────────────────────────────"
echo ""
echo -e "  ${DIM}Stuck? See the troubleshooting section in the guide,${NC}"
echo -e "  ${DIM}or copy the help prompt below into any AI chat:${NC}"
echo ""

# ═══════════════════════════════════════
# Generate AI Help Prompt
# ═══════════════════════════════════════
HELP_PROMPT_FILE="HELP-ME-SETUP.md"
cat > "$HELP_PROMPT_FILE" << 'HELPEOF'
# AuthorClaw — Personalized Setup Help

Copy everything below this line and paste it into ChatGPT, Claude, Gemini, or any AI assistant to get personalized help:

---

I'm trying to set up AuthorClaw, an open-source AI writing agent for authors. It's a Node.js/TypeScript project that runs directly with tsx. I need help troubleshooting my setup.

Here's what AuthorClaw is:
- A Node.js 22+ server (TypeScript, uses tsx to run)
- Start command: cd ~/authorclaw && npx tsx gateway/src/index.ts
- Connects to AI providers: Ollama (local), Google Gemini (free), Anthropic Claude, OpenAI, DeepSeek
- Runs on port 3847 (localhost only)
- Has a dashboard at http://localhost:3847 with 5 panels: Home, Projects, Personas, Library, Settings
- Has a project-based autonomy system (planning, research, writing, revision, promotion, analysis)
- Has a novel pipeline that writes complete books (30+ steps: premise, bible, outline, chapters, revision, DOCX assembly)
- Has a Telegram bot integration (configurable from dashboard)
- Has real web search with domain allowlisting for research
- Stores data in a workspace/ directory
- Has encrypted vault for API keys (AES-256-GCM)

My operating system is: [FILL IN: Windows / macOS / Linux]
My Node.js version is: [FILL IN: run "node -v" in terminal]
I'm using Docker: [FILL IN: Yes / No]

The problem I'm having is:
[DESCRIBE YOUR PROBLEM HERE]

The error message I see is:
[PASTE ANY ERROR MESSAGES HERE]

Please help me fix this step by step. I'm not a developer — I'm an author who wants to use this tool. Keep the instructions simple and tell me exactly what to type.
HELPEOF

ok "Help prompt saved to ${HELP_PROMPT_FILE}"
echo -e "  ${DIM}If you get stuck, open that file and paste its contents${NC}"
echo -e "  ${DIM}into any AI chatbot for personalized troubleshooting.${NC}"
echo ""

# Ask if they want to start now
ask "Start AuthorClaw now? [Y/n]: "
read -r yn
if [[ ! "$yn" =~ ^[Nn]$ ]]; then
    echo ""
    echo -e "  ${WHITE}Starting AuthorClaw...${NC}"
    echo ""
    cd "$(dirname "$0")/.." 2>/dev/null || cd "$(dirname "$0")"

    # Start server in background so we can store API keys
    npx tsx gateway/src/index.ts &
    SERVER_PID=$!

    # Wait for server to become ready
    echo -e "  ${DIM}Waiting for server to start...${NC}"
    for i in $(seq 1 30); do
        if curl -s http://localhost:3847/api/agent/status > /dev/null 2>&1; then
            ok "Server is running (PID: $SERVER_PID)"
            break
        fi
        sleep 1
    done
    if [ -n "$GEMINI_KEY" ]; then
        curl -s -X POST http://localhost:3847/api/vault \
          -H 'Content-Type: application/json' \
          -d "{\"key\":\"gemini_api_key\",\"value\":\"$GEMINI_KEY\"}" > /dev/null 2>&1
        ok "Gemini key stored in vault"
    fi
    if [ -n "$CLAUDE_KEY" ]; then
        curl -s -X POST http://localhost:3847/api/vault \
          -H 'Content-Type: application/json' \
          -d "{\"key\":\"anthropic_api_key\",\"value\":\"$CLAUDE_KEY\"}" > /dev/null 2>&1
        ok "Claude key stored in vault"
    fi
    if [ -n "$OPENAI_KEY" ]; then
        curl -s -X POST http://localhost:3847/api/vault \
          -H 'Content-Type: application/json' \
          -d "{\"key\":\"openai_api_key\",\"value\":\"$OPENAI_KEY\"}" > /dev/null 2>&1
        ok "OpenAI key stored in vault"
    fi
    if [ -n "$DEEPSEEK_KEY" ]; then
        curl -s -X POST http://localhost:3847/api/vault \
          -H 'Content-Type: application/json' \
          -d "{\"key\":\"deepseek_api_key\",\"value\":\"$DEEPSEEK_KEY\"}" > /dev/null 2>&1
        ok "DeepSeek key stored in vault"
    fi

    echo ""
    echo -e "  ${GREEN}${BOLD}AuthorClaw is running!${NC}"
    echo -e "  ${WHITE}Dashboard:${NC} ${CYAN}http://localhost:3847${NC}"
    echo ""
    echo -e "  ${DIM}Press Ctrl+C to stop the server.${NC}"
    echo ""

    # Bring server to foreground so user can see output and Ctrl+C to stop
    wait $SERVER_PID
else
    echo ""
    echo -e "  ${DIM}When you're ready, just run:${NC}"
    echo -e "  ${CYAN}cd ~/authorclaw && npx tsx gateway/src/index.ts${NC}"
    echo ""
fi

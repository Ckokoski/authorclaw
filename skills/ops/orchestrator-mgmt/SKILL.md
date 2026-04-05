---
name: orchestrator-mgmt
description: Manage user scripts and automated processes — start, stop, restart, monitor, view logs
triggers:
  - script
  - scripts
  - restart script
  - start script
  - stop script
  - process
  - logs
  - orchestrator
permissions:
  - orchestrator_manage
---

# Orchestrator Management

Manage scripts and background processes through AuthorClaw's built-in orchestrator.

## Capabilities

- **Start/Stop/Restart** individual scripts or all scripts
- **Health Monitoring** with automatic PID checks every 30 seconds
- **Auto-Restart** for scripts configured with autoRestart (up to maxRestarts times)
- **Log Viewing** — last 500 lines of stdout/stderr in a ring buffer
- **Dynamic Configuration** — add, update, or remove scripts via dashboard or API

## Script Configuration

Each managed script has:
- `id`: Unique identifier
- `name`: Human-friendly name
- `command`: The executable to run
- `args`: Command-line arguments
- `cwd`: Working directory (optional)
- `env`: Environment variables (optional, sensitive vars are redacted)
- `autoStart`: Start automatically when AuthorClaw boots
- `autoRestart`: Restart automatically on crash
- `maxRestarts`: Maximum auto-restart attempts (default: 5)
- `restartDelayMs`: Delay between restarts (default: 5000ms)
- `tags`: Labels for grouping scripts

## Commands
- `show scripts` or `list scripts` — Show all managed scripts and their status
- `start <name>` — Start a script
- `stop <name>` — Stop a script
- `restart <name>` — Restart a script
- `logs <name>` — View recent logs for a script
- `add script` — Add a new script to manage

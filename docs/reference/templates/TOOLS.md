---
title: "TOOLS.md Template"
summary: "Workspace template for TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---

# TOOLS.md

## API Keys & Credentials

| Key                     | Location                                                       |
| ----------------------- | -------------------------------------------------------------- |
| Anthropic API key       | `~/.openclaw/.env` → `ANTHROPIC_API_KEY`                       |
| Claude Code credentials | `~/.claude/credentials.json` (auto-managed via `claude` login) |
| Gateway token           | `~/.openclaw/.env` → `OPENCLAW_GATEWAY_TOKEN`                  |
| Telegram bot token      | `~/.openclaw/.env` → `TELEGRAM_BOT_TOKEN`                      |
| User Telegram chat ID   | `~/.openclaw/.env` → `USER_TELEGRAM_CHAT_ID`                   |

Get API keys: https://console.anthropic.com (Anthropic/Claude)
Support: openclaw@voltekit.com

## Channel IDs

<!-- Slack: C01234ABCDE, Discord: 123456789012345678 -->

## File Paths

<!-- Config: ~/.openclaw/openclaw.json -->
<!-- Logs: ~/.openclaw/logs/ -->
<!-- Workspace: ~/.openclaw/workspace/ -->

## SSH Hosts

<!-- alias → hostname (e.g. home-server → 192.168.1.100) -->

## Device Aliases

<!-- camera-name → location, speaker-name → room -->

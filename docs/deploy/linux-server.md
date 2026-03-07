# Linux Server Deployment

## Prerequisites

- Ubuntu, Debian, or another Linux distribution with Node.js 24+
- A dedicated service user, for example `bridge`
- A working `codex` CLI login under that service user's home directory
- A Telegram bot token
- At least one allowlisted Telegram user ID

## Recommended Layout

```text
/opt/codex-telegram-bridge
/var/lib/codex-telegram-bridge
/srv/codex-telegram-bridge/workspaces/main
/home/bridge/.codex
```

## Install

```bash
cd /opt
git clone <your-repo-url> codex-telegram-bridge
cd codex-telegram-bridge
npm ci
```

## Required Environment

```bash
export CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN="123456:replace-me"
export CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS="123456789"
export CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT="/srv/codex-telegram-bridge/workspaces/main"
export CODEX_TELEGRAM_BRIDGE_APP_HOME="/var/lib/codex-telegram-bridge"
export CODEX_TELEGRAM_BRIDGE_CODEX_HOME="/home/bridge/.codex"
export CODEX_TELEGRAM_BRIDGE_LOG_LEVEL="info"
```

## Validate Before Start

```bash
npm run doctor
```

## Run

```bash
npm run start
npm run status
npm run logs 100
```

## Optional systemd Unit

```ini
[Unit]
Description=Codex Telegram Bridge
After=network.target

[Service]
Type=forking
User=bridge
WorkingDirectory=/opt/codex-telegram-bridge
Environment=CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN=123456:replace-me
Environment=CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS=123456789
Environment=CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT=/srv/codex-telegram-bridge/workspaces/main
Environment=CODEX_TELEGRAM_BRIDGE_APP_HOME=/var/lib/codex-telegram-bridge
Environment=CODEX_TELEGRAM_BRIDGE_CODEX_HOME=/home/bridge/.codex
Environment=CODEX_TELEGRAM_BRIDGE_LOG_LEVEL=info
ExecStart=/usr/bin/npm run start
ExecStop=/usr/bin/npm run stop
ExecReload=/usr/bin/npm run stop
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Operational Commands

```bash
npm run status
npm run logs 200
npm run doctor
npm run stop
```

## Notes

- The workspace root must already exist before startup.
- Session paths must be absolute Linux paths.
- If you change the service user's Codex login, rerun `codex login status` as that user before restarting the bridge.

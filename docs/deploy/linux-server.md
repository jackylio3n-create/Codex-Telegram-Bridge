# Linux Server Deployment

This guide covers a direct Ubuntu/Debian deployment of Codex Telegram Bridge.

For a Chinese overview, see [README.zh-CN.md](../../README.zh-CN.md).

## Requirements

- Ubuntu or Debian
- Node.js 24+
- `npm`
- `systemd`
- installed `codex` CLI
- completed `codex login`
- Telegram bot token
- one Telegram user ID to allowlist

## Recommended Layout

- Repository checkout: `/srv/codex-telegram-bridge`
- Workspace root: `/home/<user>/codex-workspaces/main`
- App home: `/home/<user>/.local/share/codex-telegram-bridge`
- Config file: `/home/<user>/.config/codex-telegram-bridge/config.env`

## Install

```bash
git clone <your-repo-url> /srv/codex-telegram-bridge
cd /srv/codex-telegram-bridge
npm ci
codex login
./scripts/install-ubuntu.sh
```

The installer will:

- validate the runtime environment
- ask for the bot token and Telegram allowlist user ID
- ask for the first-contact verification password
- generate the env file
- install and start a `systemd` service

## Reconfigure

```bash
cd /srv/codex-telegram-bridge
./scripts/install-ubuntu.sh --reconfigure
```

## Manual Setup Alternative

If you do not want to use the installer:

```bash
cd /srv/codex-telegram-bridge
npm run setup
npm run doctor
npm run serve
```

## First Telegram Login Flow

For an allowlisted user:

1. Send `/start` to the bot
2. The bot sends a bilingual welcome
3. Send the verification password in the next plain-text message
4. Choose `中文` or `English`
5. Start using normal bot commands

Security notes:

- `/start` does not count as a failed verification attempt
- unverified messages, commands, files, and callbacks do not reach Codex
- 5 wrong password attempts permanently ban that Telegram user ID locally

## Useful Commands

```bash
systemctl status codex-telegram-bridge
journalctl -u codex-telegram-bridge -n 100
cd /srv/codex-telegram-bridge && npm run doctor
cd /srv/codex-telegram-bridge && npm run status
cd /srv/codex-telegram-bridge && npm run logs 100
```

## Updating the Service

```bash
cd /srv/codex-telegram-bridge
git pull
npm ci
npm run typecheck
sudo systemctl restart codex-telegram-bridge
```

If the update includes schema changes, the bridge will apply SQLite migrations on startup.

## Troubleshooting

- If `doctor` reports missing Codex login, run `codex login` again as the runtime user
- If the service starts but Telegram messages do nothing, verify the allowlisted user ID and owner lock settings
- If a user is banned during first-contact verification, remove the ban from local state manually before retrying
- If workspace commands fail, check that all configured paths are absolute Linux paths

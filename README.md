# Codex Telegram Bridge

Telegram private-chat bridge for running the local `codex` CLI on a Linux server, with session management, approvals, SQLite persistence, and privacy-minded defaults.

[中文说明 / Chinese README](./README.zh-CN.md)

## What This Project Does

This project lets an allowlisted Telegram user talk to a self-hosted Codex runtime through a private Telegram bot.

It is designed for direct Linux deployment and keeps the control plane local:

- Runs against the locally logged-in `codex` CLI, not an API-key-first architecture
- Persists sessions, approvals, offsets, runtime state, and summaries in SQLite
- Supports text input and image input from Telegram private chats
- Enforces a first-contact verification password before the bot can be used
- Requires the user to choose Chinese or English prompts after verification
- Drops unverified or banned traffic before it reaches the Codex runtime
- Uses workspace boundaries plus approval gates for filesystem-affecting work

## Security Model

The bridge now has multiple layers of access control:

1. Telegram private chat only
2. Telegram user ID allowlist
3. Optional owner user/chat lock
4. First-contact verification password
5. Persistent language selection gate
6. Permanent local ban after 5 wrong verification attempts

Important behavior:

- `/start` on first contact shows a bilingual welcome and does not count as a failed attempt
- Before verification, text, commands, files, and callbacks do not reach Codex
- After 5 wrong password attempts, the Telegram user ID is locally banned
- Banned users are silently dropped, including callback actions

## Main Features

- Long polling with persisted Telegram offsets
- Multi-session chat binding and rebinding
- Commands for session creation, cwd changes, access scope changes, and pruning
- Approval handling through inline buttons and `/perm` fallback
- Rolling summaries and resume/stale-recovery support
- Runtime status inspection and diagnostics
- Setup flow for generating an env file safely
- Ubuntu/Debian installer script
- Privacy defaults for reduced audit detail and automatic cleanup

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/cli/` | daemon CLI, setup flow, operational commands |
| `src/runtime/bridge/` | bridge runtime orchestration |
| `src/runtime/codex/` | Codex process execution, status, and resume handling |
| `src/transport/telegram/` | Telegram client, polling, update mapping |
| `src/core/commands/` | Telegram command handling |
| `src/core/approval/` | approval lifecycle and `/perm` parsing |
| `src/core/workspace/` | workspace boundary enforcement and path validation |
| `src/config/` | config loading, parsing, redaction, startup validation |
| `src/store/` | SQLite store, split repositories, mappers, shared codecs |
| `scripts/deploy/` | deployment and installation scripts |
| `scripts/dev/` | local developer utility scripts |
| `migrations/` | schema migrations |
| `docs/testing/` | manual verification checklists |
| `tests/unit/` | focused unit tests |
| `tests/integration/` | multi-module and store-backed tests |

## Requirements

- Linux server
- Node.js 24+
- Working `codex` CLI installation
- Completed `codex login`
- One Telegram bot token
- At least one allowlisted Telegram user ID

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo-url> Codex-Telegram-Bridge
cd Codex-Telegram-Bridge
npm ci
```

### 2. Log in to Codex on the target machine

```bash
codex login
```

### 3. Configure the bridge

Interactive setup:

```bash
npm run setup
```

Or use the Ubuntu/Debian helper:

```bash
./scripts/deploy/install-ubuntu.sh
```

The setup flow will ask for:

- Telegram bot token
- Verification password used on first Telegram contact
- Allowlisted Telegram user ID
- Default workspace root
- App home and Codex home paths

### 4. Run checks

```bash
npm run doctor
npm run status
```

### 5. Start the daemon

```bash
npm run start
```

For process managers such as `systemd`, use:

```bash
npm run serve
```

## Configuration

Use [`.env.example`](./.env.example) as the template.

Core settings:

- `CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN`
- `CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH`
- `CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS`
- `CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID`
- `CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT`
- `CODEX_TELEGRAM_BRIDGE_APP_HOME`
- `CODEX_TELEGRAM_BRIDGE_CODEX_HOME`
- `CODEX_TELEGRAM_BRIDGE_LOG_LEVEL`

Privacy and retention settings:

- `CODEX_TELEGRAM_BRIDGE_AUDIT_LEVEL`
- `CODEX_TELEGRAM_BRIDGE_INCLUDE_RUNTIME_IDENTIFIERS`
- `CODEX_TELEGRAM_BRIDGE_MAX_AUDIT_ROWS`
- `CODEX_TELEGRAM_BRIDGE_MAX_SUMMARIES_PER_SESSION`
- `CODEX_TELEGRAM_BRIDGE_RESOLVED_APPROVAL_RETENTION_DAYS`
- `CODEX_TELEGRAM_BRIDGE_EXPIRED_APPROVAL_RETENTION_DAYS`

Notes:

- Use absolute Linux paths
- Do not store the plaintext verification password in env files
- The setup command writes a hashed verification password
- Keep the env file private because it contains bot credentials

## Runtime Data

Default application home layout:

```text
APP_HOME/
  data/
    bridge.sqlite3
  logs/
    bridge.log
  run/
    bridge.pid
    runtime-state.json
  tmp/
    telegram-media-*
```

## Telegram Commands

Aliases are supported as shown below.

| Command | Purpose |
| --- | --- |
| `/start` | show the welcome / verification flow |
| `/help` | show supported Telegram commands |
| `/new [cwd]` | create and bind a new session |
| `/sess` or `/sessions` | list sessions |
| `/bind <session_id>` | bind to an existing session |
| `/cd <absolute_path>` or `/cwd <absolute_path>` | update the current session cwd |
| `/allow <absolute_path>` or `/adddir <absolute_path>` | request an extra allowed directory |
| `/mode <ask\|plan\|code>` | change session mode |
| `/scope [workspace\|system]` | show or change access scope |
| `/think [minimal\|low\|medium\|high\|xhigh]` or `/reasoning ...` | show or change reasoning effort |
| `/stat` or `/status` | show current status |
| `/stop` | cancel the active run |
| `/perm` | list pending approvals |
| `/perm approve <permission_id>` | approve a request |
| `/perm deny <permission_id>` | deny a request |
| `/clean [keep_count]` or `/prune [keep_count]` | prune inactive unbound sessions |

## Development

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run lint:shell
```

Key scripts:

- `npm run build`
- `npm run clean`
- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run test`
- `npm run lint:shell`
- `npm run start`
- `npm run serve`
- `npm run stop`
- `npm run status`
- `npm run logs`
- `npm run doctor`
- `npm run setup`

Notes:

- `npm run lint:shell` runs a local wrapper. If `shellcheck` is unavailable on Windows, it exits successfully with a message and CI remains the real enforcement point.
- CI runs on Ubuntu and executes `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test`, and `npm run lint:shell`.

## Deployment Notes

- Recommended target: Ubuntu or Debian
- Direct deployment is the intended path; Docker is not required
- The included installer script writes a config file and a `systemd` unit
- See [docs/deploy/linux-server.md](./docs/deploy/linux-server.md) for a step-by-step deployment guide

## Test Status

Current local verification before preparing this repository for GitHub:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run test`

All passed in the current workspace. `npm run lint:shell` may fall back locally when `shellcheck` is not installed, while CI runs the real shellcheck gate on Ubuntu. Some integration tests are skipped on Windows because they require Linux-style workspace paths.

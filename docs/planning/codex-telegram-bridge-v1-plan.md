# Codex + Telegram Bridge V1 Plan

## Summary

Build a Linux-first, single-user Telegram bridge for local Codex sessions with SQLite persistence, Telegram long polling, direct Linux server deployment, and a modular TypeScript service.

Core V1 capabilities:

- Telegram private chat only, allowlisted user IDs only
- Codex local login session only, available on the Linux host
- `/new`, `/sessions`, `/bind`, `/cwd`, `/adddir`, `/mode`, `/status`, `/stop`, `/help`, `/perm`
- text input, Telegram photo input, and image-as-document input
- streamed Telegram preview with fixed truncation and chunking rules
- unified approval flow based on Codex `on-request`
- SQLite persistence for session state, offsets, approvals, audit logs, and rolling summaries
- per-session actor queues plus a separate chat-level binding gate

## Key Decisions

### Routing and state model

- Use two coordination layers:
  - `chat gate`: serializes chat-level binding changes and control operations that mutate `chat -> session`
  - `session actor`: serializes all events for a specific session
- Routing rules:
  - normal user messages: resolve current binding, then enqueue into target session actor
  - approval callbacks: route by `pending_permission.session_id`, never by current chat binding
  - `/stop`: route to the currently bound session actor
  - `/bind` and `/new`: handled first by the chat gate, then any follow-up work is sent to the target session actor
- Run states:
  - `idle`
  - `running`
  - `waiting_approval`
  - `cancelling`
  - `cancelled`
  - `failed`
  - `stale_recovered`
- Cancellation result is separate from run state:
  - `full`
  - `partial`
  - `unknown`
- While the current bound session is `running`, `waiting_approval`, or `cancelling`, reject `/bind`, `/new`, `/cwd`, `/mode`, and `/adddir`; allow only `/status`, `/help`, and `/stop`.

### Session initialization and workspace model

- Session fields:
  - `workspace_root`
  - `extra_allowed_dirs`
  - `cwd`
  - `mode`
  - `codex_thread_id`
  - `rolling_summary`
- `/new [cwd]` initialization is fixed:
  - `workspace_root`: inherit current chat-bound session root if one exists, otherwise global default root
  - `extra_allowed_dirs`: start empty, never inherit
  - `cwd`: explicit argument if valid; otherwise `workspace_root`
  - `mode`: fixed default `code`, not inherited
- `cwd` must always remain inside `workspace_root` or one of `extra_allowed_dirs`.
- `/cwd <absolute_path>` only succeeds if the path is already inside the allowed directory set.
- `/adddir <absolute_path>` adds an allowed directory after explicit confirmation and audit logging.
- Rolling summary is deterministic and local-only in V1: derive it from session metadata, recent audit events, recent approvals or denials, and recent cancel or recovery outcomes; do not call another model to summarize.

### Mode and Codex runtime behavior

- Do not use deprecated `on-failure`.
- Mode mapping:
  - `/mode ask` -> `approval=on-request`, `sandbox=read-only`
  - `/mode plan` -> `approval=on-request`, `sandbox=workspace-write`
  - `/mode code` -> `approval=on-request`, `sandbox=workspace-write`
- V1 does not implement persistent session `unsafe` mode.
- Approval source is unified:
  - Codex `on-request` is the only normal tool approval source
  - bridge-specific dangerous commands like `/adddir` use separate explicit confirmation
- On resume failure or stale thread mismatch:
  - start a fresh thread
  - preserve the bridge session
  - mark state as `stale_recovered`
  - notify the Telegram user that historical context may be incomplete
  - seed the fresh thread with the rolling summary

### Approval lifecycle

- `pending_permissions` stores:
  - `permission_id`
  - `session_id`
  - `run_id`
  - `chat_id`
  - `user_id`
  - `source_message_id`
  - `tool_name`
  - `summary`
  - `expires_at`
  - `resolved`
- `approval_decision` is rejected as stale and answered with "expired or already handled" when any of these hold:
  - permission is already resolved
  - permission is expired
  - callback `chat_id` does not match
  - callback `user_id` does not match
  - permission `run_id` is not the currently waiting run for that session
- Callback flow:
  - immediately `answerCallbackQuery`
  - only then enqueue decision into the owning session actor if still valid

### Telegram transport and output rules

- Use `getUpdates` long polling with offset persisted in SQLite.
- Accept private chats only and only from configured allowed Telegram user IDs.
- Telegram constraints are first-class:
  - message text hard limit: 4096 chars
  - callback data hard limit: 64 bytes
- Approval buttons use short opaque IDs only; all state is resolved from SQLite.
- Preview rules:
  - preview max length: 1500 chars
  - final message max chunk length: 3600 chars
  - if a code block crosses chunk boundaries, downgrade that chunk to plain text rather than forcing broken fenced Markdown
- Final replacement strategy:
  - if final output fits one chunk, edit preview into the final message
  - if final output needs multiple chunks, keep the preview as a short completed summary or short first segment, then append the remaining final chunks
  - if preview send or edit fails, stop preview mode and send final chunks directly with at most one fallback attempt
- Transport interface should support preview capability detection so a future Telegram `sendMessageDraft` path can be added without changing core logic.

### Media input and persistence

- Accept only image media.
- Support Telegram photo and document-form image uploads.
- Enforce a fixed file size cap.
- Download to temp storage only and clean up after the run.
- Do not pass EXIF or raw original filenames into prompts.
- SQLite tables:
  - `sessions`
  - `chat_bindings`
  - `pending_permissions`
  - `channel_offsets`
  - `audit_logs`
  - `session_summaries`
  - `migrations`
- `channel_offsets` stores:
  - `channel_key`
  - `current_offset`
  - `previous_offset`
  - `updated_at`
- Audit logs distinguish user intent from agent behavior:
  - user-side: `user_input`, `user_command`, `approval_decision`
  - agent-side: `agent_text`, `tool_start`, `tool_result`, `file_change`, `shell_exec`, `session_rebind`, `run_cancel`, `resume_recovery`

### Deployment and portability

- Deployment target is a Linux host process managed directly on the server.
- Ship:
  - one Node.js daemon entrypoint for the bridge service
  - one `.env.example` for runtime path and token settings
  - one Linux server deployment runbook
- Use fixed absolute Linux paths:
  - Codex home such as `/home/bridge/.codex`
  - workspace root(s) such as `/srv/codex-telegram-bridge/workspaces/main`
  - app data path for SQLite, logs, temp files, and runtime state
- Path model is Linux-host-native:
  - `/cwd` and `/adddir` accept only absolute Linux paths, not Windows host paths
  - session `workspace_root`, `extra_allowed_dirs`, and `cwd` are always stored as Linux paths
  - this keeps runtime behavior stable between local Linux development and cloud server deployment
- `/adddir` can only authorize directories already visible to the service user on the host; adding a truly new root requires creating it on the server and updating session configuration.
- Auth strategy:
  - default and only V1 path is using an existing Codex local login under the service user
  - do not design V1 around API key auth
- Runtime defaults:
  - foreground Node daemon with `start`, `stop`, `status`, `logs`, and `doctor`
  - persistent SQLite and logs under the configured app home
  - easy later wrapping by `systemd`

### Operations and diagnostics

- Linux-only V1, foreground Node service designed for direct server deployment and easy `systemd` wrapping.
- Provide:
  - daemon entrypoint
  - `start`, `stop`, `status`, `logs`, `doctor` wrapper commands
  - Linux server runbook
- `doctor` checks:
  - Telegram token validity
  - Codex CLI and SDK availability and login state
  - writable DB and log paths
  - valid default workspace root
  - stale approvals
  - stuck actor or run states
  - workspace boundary consistency:
    - `workspace_root` exists and is accessible
    - `extra_allowed_dirs` exist, are deduplicated, and do not escape expected roots through symlink resolution
    - each session `cwd` is still inside the allowed directory set
  - offset health:
    - offset row exists
    - `current_offset` is numeric and non-negative
    - `current_offset >= previous_offset`
    - suspicious jump warning if `current_offset - previous_offset > 10000`
- Add simple rate limiting for inbound Telegram messages and dangerous bridge commands.

## Assumptions

- Single bot, single operator, Telegram private chat only.
- V1 approval behavior is uniformly `on-request`.
- `workspace_root` is required in config and serves as the default starting `cwd`.
- Full transcript persistence is intentionally out of scope; rolling summaries are the continuity mechanism.
- Paths exposed to Telegram commands are absolute Linux paths, not Windows host paths.

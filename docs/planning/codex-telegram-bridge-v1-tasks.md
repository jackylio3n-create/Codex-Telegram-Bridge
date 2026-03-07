# Codex + Telegram Bridge V1 Task Breakdown

## 1. Planning docs

1. Freeze the V1 spec, defaults, and invariants in project docs.
2. Freeze numeric defaults: preview size, chunk size, approval TTL, offset warning threshold.
3. Record V1 exclusions: no persistent `unsafe` mode, no full transcript persistence, no API-key-first auth path.

## 2. Bootstrap and config

1. Define app home, environment variables, startup validation, and secret handling.
2. Define logger interface, redaction rules, and log output paths.
3. Define wrapper command behavior for `start`, `stop`, `status`, `logs`, and `doctor`.

## 3. SQLite and migrations

1. Design schema for sessions, bindings, approvals, offsets, audit logs, summaries, and migrations.
2. Define repository interfaces and transaction boundaries.
3. Define bootstrap migrations and version management.
4. Define cleanup policy for approvals, summaries, and audit rows.

## 4. Routing core

1. Define normalized inbound and outbound message types.
2. Implement chat gate rules for binding changes.
3. Implement session actor state machine and run ownership.
4. Define command rejection policy while a session is active.
5. Define `run_id` ownership across approval and cancellation flows.

## 5. Workspace boundary model

1. Define validation for `workspace_root`, `extra_allowed_dirs`, and `cwd`.
2. Implement `/new` inheritance behavior.
3. Implement `/cwd` success and failure rules.
4. Implement `/adddir` confirmation flow and symlink checks.
5. Define how each Codex turn reconstructs runtime context from session state.

## 6. Telegram transport

1. Define polling loop, offset commit rules, and replay protection.
2. Define private-chat and allowlist checks.
3. Define send, edit, and callback answer behavior.
4. Define preview capability modes: `draft`, `edit`, `none`.
5. Define preview-to-final replacement and fallback rules.
6. Define media download, temp file handling, and cleanup flow.

## 7. Codex runtime

1. Define local-login runtime initialization.
2. Define mode-to-sandbox and approval mapping.
3. Define stream event normalization.
4. Define soft-cancel semantics and user-visible outcomes.
5. Define stale-thread recovery and rolling-summary seeding.

## 8. Approval flow

1. Define pending permission schema, short token format, TTL, and invalidation rules.
2. Define inline button generation and `/perm` fallback.
3. Define approval routing by `session_id + run_id`.
4. Define approval audit events and stale-callback responses.

## 9. Commands and UX

1. Define `/start`, `/help`, and `/status`.
2. Define `/new`, `/sessions`, and `/bind`.
3. Define `/cwd`, `/adddir`, and `/mode`.
4. Define `/stop` and cancellation feedback.
5. Define user-facing error classes: invalid, blocked, stale, cancelled, recovered.

## 10. Summaries and audit

1. Define deterministic rolling summary structure and update triggers.
2. Define audit taxonomy for user and agent events.
3. Define recovery-time summary injection.
4. Define audit coverage for cancel and directory-boundary changes.

## 11. Direct Deployment

1. Define direct Linux server deployment layout and service user expectations.
2. Define `.env.example`, required runtime paths, and app-home conventions.
3. Define stable absolute Linux path conventions.
4. Define Codex login-state requirements on the host.
5. Define Linux server runbook and optional `systemd` integration.
6. Define startup validation and `doctor` wiring for direct deployment.

## 12. Diagnostics and ops

1. Define `doctor` checks for config, DB, offsets, approvals, actors, and workspace boundaries.
2. Define rate limiting and stuck-run detection.
3. Define log inspection and troubleshooting workflow.

## 13. Testing

1. Unit tests for routing, state machine, `/new` inheritance, directory boundaries, approvals, preview policy, summary generation, and migrations.
2. Integration tests for commands, rebinding races, stale approval rejection, media input, cancel flow, recovery flow, and offset diagnostics.
3. Manual acceptance for direct Linux server deployment.

# Repository Guidelines

## Project Structure & Module Organization

`src/` holds the service code. Use `src/cli/` for daemon commands and setup flow, `src/config/` for config parsing/redaction/validation, `src/core/` for sessions, routing, approvals, workspaces, and command handling, `src/runtime/` for Codex process integration, `src/transport/telegram/` for polling and update mapping, `src/store/` for SQLite access plus split repositories/helpers, and `src/doctor/` for diagnostics. SQL migrations live in `migrations/`. Deployment notes live in `docs/deploy/`. Manual verification notes live in `docs/testing/`. Tests are split into `tests/unit/` and `tests/integration/`.

## Build, Test, and Development Commands

Use Node 24+.

- `npm run build`: compile TypeScript into `dist/`.
- `npm run clean`: remove generated `dist/` output.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run lint`: run ESLint for `src/` and `tests/`.
- `npm run format`: format the repo with Prettier.
- `npm run format:check`: verify Prettier formatting.
- `npm run test`: run the full automated test suite.
- `npm run lint:shell`: run `shellcheck` for `scripts/deploy/install-ubuntu.sh` through the local wrapper.
- `npm run start`: start the bridge daemon.
- `npm run stop`, `npm run status`, `npm run logs`, `npm run doctor`: run local operational commands.
- `npm run cli -- help`: invoke the CLI directly with a custom subcommand.

## Coding Style & Naming Conventions

Write TypeScript with ES modules and keep the existing 2-space indentation style. Prefer `const`, readonly interfaces, and narrow union types for state. File names are lowercase with hyphens where needed, such as `in-memory-routing-core.ts`; exported types and classes use `PascalCase`; functions and variables use `camelCase`. ESLint and Prettier are checked in now, so use `npm run typecheck`, `npm run lint`, and `npm run format:check` as the standard quality gate.

## Testing Guidelines

Tests use Node's built-in `node:test` runner through `tsx`. Put focused logic tests in `tests/unit/` and cross-module or store-backed scenarios in `tests/integration/`. Name files `*.test.ts` and write descriptive test titles that state the expected behavior. Add regression tests for any bug in session state, approval handling, routing hydration, repository persistence, or shared store helper behavior.

## Commit & Pull Request Guidelines

This repository currently has no commit history, so use short imperative commit subjects such as `fix session hydration on bind` or `add regression test for denied approvals`. Keep commits scoped to one logical change. Pull requests should include a brief summary, the affected areas, test evidence, and any config or migration impact. Include screenshots only when UI or Telegram-facing output changes.

## Security & Configuration Tips

Do not commit `.env` files, bot tokens, or local Codex credentials. Use `.env.example` as the template. Treat workspace paths as absolute Linux paths such as `/srv/codex-telegram-bridge/workspaces/main`, not host-only Windows paths, when working on runtime or Telegram command behavior.

## Quality Gates

Before closing non-trivial changes, prefer this sequence:

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `npm run lint:shell`

On Windows, `npm run lint:shell` may print that `shellcheck` is unavailable locally; CI on Ubuntu is the real shellcheck enforcement point.

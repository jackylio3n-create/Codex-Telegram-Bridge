# Repository Guidelines

## Project Structure & Module Organization
`src/` holds the service code. Use `src/cli/` for daemon commands, `src/core/` for sessions, routing, approvals, workspaces, and command handling, `src/runtime/` for Codex process integration, `src/transport/telegram/` for polling and update mapping, `src/store/` for SQLite access, and `src/doctor/` for diagnostics. SQL migrations live in `migrations/`. Deployment notes live in `docs/deploy/`. Tests are split into `tests/unit/`, `tests/integration/`, and `tests/manual/`.

## Build, Test, and Development Commands
Use Node 24+.

- `npm run build`: compile TypeScript into `dist/`.
- `npm run clean`: remove generated `dist/` output.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run start`: start the bridge daemon.
- `npm run stop`, `npm run status`, `npm run logs`, `npm run doctor`: run local operational commands.
- `npm run cli -- help`: invoke the CLI directly with a custom subcommand.
- `npx tsx --test tests\\unit\\*.test.ts tests\\integration\\*.test.ts`: run the full automated test suite.

## Coding Style & Naming Conventions
Write TypeScript with ES modules and keep the existing 2-space indentation style. Prefer `const`, readonly interfaces, and narrow union types for state. File names are lowercase with hyphens where needed, such as `in-memory-routing-core.ts`; exported types and classes use `PascalCase`; functions and variables use `camelCase`. No formatter or lint config is checked in, so match nearby files and use `npm run typecheck` as the minimum quality gate.

## Testing Guidelines
Tests use Node's built-in `node:test` runner through `tsx`. Put focused logic tests in `tests/unit/` and cross-module or store-backed scenarios in `tests/integration/`. Name files `*.test.ts` and write descriptive test titles that state the expected behavior. Add regression tests for any bug in session state, approval handling, routing hydration, or repository persistence.

## Commit & Pull Request Guidelines
This repository currently has no commit history, so use short imperative commit subjects such as `fix session hydration on bind` or `add regression test for denied approvals`. Keep commits scoped to one logical change. Pull requests should include a brief summary, the affected areas, test evidence, and any config or migration impact. Include screenshots only when UI or Telegram-facing output changes.

## Security & Configuration Tips
Do not commit `.env` files, bot tokens, or local Codex credentials. Use `.env.example` as the template. Treat workspace paths as absolute Linux paths such as `/srv/codex-telegram-bridge/workspaces/main`, not host-only Windows paths, when working on runtime or Telegram command behavior.

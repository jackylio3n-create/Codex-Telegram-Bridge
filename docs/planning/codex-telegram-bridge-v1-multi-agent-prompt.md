# Codex Multi-Agent Coordinator Prompt

Read these two files first and treat them as the source of truth:

- `D:\Project\Codex-Brige\docs\planning\codex-telegram-bridge-v1-plan.md`
- `D:\Project\Codex-Brige\docs\planning\codex-telegram-bridge-v1-tasks.md`

You are the coordinator agent for this implementation. Use Codex multi-agent to execute the task list in parallel where safe.

Execution rules:

- Respect the V1 plan exactly. Do not expand scope.
- Use the task breakdown as the implementation backlog.
- Prefer CSV fan-out if available; otherwise parse the same task structure manually and spawn subagents yourself.
- Spawn at most 5 subagents concurrently.
- Do not let two subagents edit the same owned paths.
- Respect `depends_on` strictly. Blocked tasks must wait.
- Treat routing, state-machine, workspace-boundary, approval, and Linux deployment requirements as hard constraints.
- All runtime and workspace paths must remain absolute Linux paths, even though the repo is currently on Windows.
- If a task is blocked, return a blocker and a proposed interface or contract instead of guessing.

Coordination workflow:

1. Read the plan and task files.
2. Build a dependency graph from the CSV or task rows.
3. Start the first safe batch of subagents in parallel.
4. After each subagent finishes, review its output and merge in a conflict-safe order.
5. Run focused tests per completed task.
6. When all tasks are done, run a final integration pass and summarize:
   - completed tasks
   - blockers
   - changed paths
   - test results
   - follow-up risks

Subagent rules:

- Each subagent must only work within its `owned_paths`.
- Each subagent must report:
  - what it changed
  - tests run
  - blockers
  - any interface assumptions it introduced
- If a subagent sees overlap with another task, it must stop and report the conflict.

Use the CSV file `D:\Project\Codex-Brige\docs\planning\codex-telegram-bridge-v1-fanout.csv` as the canonical fan-out plan.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalService } from "../../src/core/approval/index.js";
import { CommandsService } from "../../src/core/commands/service.js";
import { InMemoryRoutingCore } from "../../src/core/router/index.js";
import { createBridgeStore, type BridgeStore } from "../../src/store/index.js";
import { mapTelegramUpdateToInbound } from "../../src/transport/telegram/updates.js";

const DEFAULT_WORKSPACE_ROOT = "/workspaces/main";

test("commands service creates and binds a new session, then reports status", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(
      createCommand("new", {
        requestedCwd: "/workspaces/main/app"
      })
    );
    assert.equal(created.status, "ok");
    assert.equal(created.data?.sessionId, "session-1");

    const stored = harness.store.sessions.get("session-1");
    assert.ok(stored);
    assert.equal(stored.cwd, "/workspaces/main/app");
    assert.equal(stored.mode, "code");
    assert.equal(stored.accessScope, "workspace");

    const binding = harness.store.chatBindings.get("chat-1");
    assert.equal(binding?.sessionId, "session-1");

    const status = await harness.commands.dispatch(createCommand("status"));
    assert.equal(status.status, "ok");
    assert.match(status.message, /Bound to session-1/);
    assert.equal(status.data?.status.binding?.sessionId, "session-1");
    assert.equal(status.data?.status.session?.cwd, "/workspaces/main/app");
  } finally {
    await harness.dispose();
  }
});

test("commands service help lists commands with descriptions", async () => {
  const harness = await createHarness();

  try {
    const help = await harness.commands.dispatch(createCommand("help"));
    assert.equal(help.status, "ok");
    assert.match(
      help.message,
      /\/cd <absolute_path> - Update the current session cwd\./
    );
    assert.match(
      help.message,
      /\/scope \[workspace\|system\] - Show or change the current session access scope\./
    );
    assert.match(
      help.message,
      /\/stat - Show the current bound session or Codex status summary\./
    );
    assert.match(help.message, /\/help - Show this command reference\./);
  } finally {
    await harness.dispose();
  }
});

test("commands service help follows the resolved prompt language", async () => {
  const harness = await createHarness({
    languageResolver: () => "zh"
  });

  try {
    const help = await harness.commands.dispatch(createCommand("help"));
    assert.equal(help.status, "ok");
    assert.match(
      help.message,
      /\/cd <absolute_path> - 修改当前 session 的 cwd。/
    );
    assert.match(
      help.message,
      /\/scope \[workspace\|system\] - 查看或切换当前 session 的访问范围。/
    );
    assert.match(
      help.message,
      /\/stat - 查看当前绑定 session 或 Codex 状态摘要。/
    );
    assert.match(help.message, /\/help - 显示这份命令说明。/);
  } finally {
    await harness.dispose();
  }
});

test("commands service blocks workspace mutation commands while the session actor is active", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(createCommand("new"));
    const sessionId = created.data?.sessionId;
    assert.equal(sessionId, "session-1");

    const actor = harness.routing.getSessionActor(sessionId);
    assert.ok(actor);
    await actor.enqueue({
      kind: "run_started",
      runId: "run-active",
      startedAt: "2026-03-06T15:00:00.000Z"
    });

    const rejected = await harness.commands.dispatch(
      createCommand("cwd", {
        path: "/workspaces/main/blocked"
      })
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(
      rejected.message,
      "/cwd is blocked while the current bound session is active."
    );
  } finally {
    await harness.dispose();
  }
});

test("commands service resolves /perm approval decisions against the bound session actor", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(createCommand("new"));
    const sessionId = created.data?.sessionId;
    assert.equal(sessionId, "session-1");

    const actor = harness.routing.getSessionActor(sessionId);
    assert.ok(actor);
    await actor.enqueue({
      kind: "run_started",
      runId: "run-approve",
      startedAt: "2026-03-06T16:00:00.000Z"
    });

    const pending = harness.approval.createPendingApproval({
      sessionId,
      runId: "run-approve",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      toolName: "shell_command",
      summary: "Approve a command"
    });
    await actor.enqueue({
      kind: "approval_requested",
      runId: "run-approve",
      permissionId: pending.permission.permissionId,
      requestedAt: "2026-03-06T16:01:00.000Z"
    });

    const resolved = await harness.commands.dispatch(
      createCommand("perm", {
        args: ["approve", pending.permission.permissionId]
      })
    );
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.message, "Approval granted.");

    const savedPermission = harness.store.pendingPermissions.get(
      pending.permission.permissionId
    );
    assert.equal(savedPermission?.resolution, "approved");

    const snapshot = harness.routing.getSessionSnapshot(sessionId);
    assert.equal(snapshot?.runState, "running");
    assert.equal(snapshot?.waitingPermissionId, null);
  } finally {
    await harness.dispose();
  }
});

test("commands service fails the session when /perm denies an approval", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(createCommand("new"));
    const sessionId = created.data?.sessionId;
    assert.equal(sessionId, "session-1");

    const actor = harness.routing.getSessionActor(sessionId);
    assert.ok(actor);
    await actor.enqueue({
      kind: "run_started",
      runId: "run-deny",
      startedAt: "2026-03-06T16:10:00.000Z"
    });

    const pending = harness.approval.createPendingApproval({
      sessionId,
      runId: "run-deny",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      toolName: "shell_command",
      summary: "Deny a command"
    });
    await actor.enqueue({
      kind: "approval_requested",
      runId: "run-deny",
      permissionId: pending.permission.permissionId,
      requestedAt: "2026-03-06T16:11:00.000Z"
    });

    const denied = await harness.commands.dispatch(
      createCommand("perm", {
        args: ["deny", pending.permission.permissionId]
      })
    );
    assert.equal(denied.status, "ok");
    assert.equal(denied.message, "Approval denied.");
    assert.equal(
      harness.store.pendingPermissions.get(pending.permission.permissionId)
        ?.resolution,
      "denied"
    );

    const snapshot = harness.routing.getSessionSnapshot(sessionId);
    assert.equal(snapshot?.runState, "failed");
    assert.equal(snapshot?.currentRunId, null);
    assert.equal(snapshot?.waitingPermissionId, null);
  } finally {
    await harness.dispose();
  }
});

test("commands service hydrates persisted bindings before routing stop commands", async () => {
  const harness = await createHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-restart",
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      extraAllowedDirs: [],
      cwd: DEFAULT_WORKSPACE_ROOT,
      mode: "code",
      runState: "running",
      activeRunId: "run-restart",
      createdAt: "2026-03-06T16:20:00.000Z",
      updatedAt: "2026-03-06T16:20:00.000Z"
    });
    harness.store.chatBindings.save({
      chatId: "chat-1",
      sessionId: "session-restart"
    });

    const status = await harness.commands.dispatch(createCommand("status"));
    assert.equal(status.data?.status.actorSnapshot?.runState, "running");

    const stopped = await harness.commands.dispatch(createCommand("stop"));
    assert.equal(stopped.status, "ok");
    assert.equal(
      harness.routing.getChatBinding("chat-1").sessionId,
      "session-restart"
    );
    assert.equal(
      harness.routing.getSessionSnapshot("session-restart")?.runState,
      "cancelling"
    );
  } finally {
    await harness.dispose();
  }
});

test("commands service preserves waiting approval state when binding an existing session", async () => {
  const harness = await createHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-existing",
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      extraAllowedDirs: [],
      cwd: DEFAULT_WORKSPACE_ROOT,
      mode: "code",
      runState: "waiting_approval",
      activeRunId: "run-existing",
      createdAt: "2026-03-06T16:30:00.000Z",
      updatedAt: "2026-03-06T16:30:00.000Z"
    });
    harness.store.pendingPermissions.create({
      permissionId: "perm-existing",
      sessionId: "session-existing",
      runId: "run-existing",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      toolName: "shell_command",
      summary: "Resume existing approval",
      expiresAt: "2026-03-06T17:00:00.000Z",
      createdAt: "2026-03-06T16:30:00.000Z"
    });

    const bound = await harness.commands.dispatch(
      createCommand("bind", {
        targetSessionId: "session-existing"
      })
    );
    assert.equal(bound.status, "ok");

    const status = await harness.commands.dispatch(createCommand("status"));
    assert.equal(
      status.data?.status.actorSnapshot?.runState,
      "waiting_approval"
    );
    assert.equal(
      status.data?.status.actorSnapshot?.waitingPermissionId,
      "perm-existing"
    );

    const resolved = await harness.commands.dispatch(
      createCommand("perm", {
        args: ["approve", "perm-existing"]
      })
    );
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.message, "Approval granted.");
    assert.equal(
      harness.store.pendingPermissions.get("perm-existing")?.resolution,
      "approved"
    );
    assert.equal(
      harness.routing.getSessionSnapshot("session-existing")?.runState,
      "running"
    );
  } finally {
    await harness.dispose();
  }
});

test("telegram /perm command maps to tokenized args and resolves through commands service", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(createCommand("new"));
    const sessionId = created.data?.sessionId;
    assert.equal(sessionId, "session-1");

    const actor = harness.routing.getSessionActor(sessionId);
    assert.ok(actor);
    await actor.enqueue({
      kind: "run_started",
      runId: "run-telegram-perm",
      startedAt: "2026-03-06T17:00:00.000Z"
    });

    const pending = harness.approval.createPendingApproval({
      sessionId,
      runId: "run-telegram-perm",
      chatId: "1",
      userId: "1",
      sourceMessageId: "message-1",
      toolName: "shell_command",
      summary: "Approve from Telegram"
    });
    await actor.enqueue({
      kind: "approval_requested",
      runId: "run-telegram-perm",
      permissionId: pending.permission.permissionId,
      requestedAt: "2026-03-06T17:01:00.000Z"
    });

    const mapped = await mapTelegramUpdateToInbound(
      {
        update_id: 55,
        message: {
          message_id: 101,
          date: 1_772_766_400,
          text: `/perm approve ${pending.permission.permissionId}`,
          chat: {
            id: 1,
            type: "private"
          },
          from: {
            id: 1,
            is_bot: false,
            first_name: "Tester"
          }
        }
      },
      {
        allowedUserIds: new Set(["1"]),
        store: harness.store,
        client: {
          async answerCallbackQuery() {
            throw new Error(
              "answerCallbackQuery should not be called for Telegram text commands."
            );
          }
        },
        callbackReceivedText: "Received.",
        callbackStaleText: "Expired or already handled."
      }
    );

    assert.equal(mapped.kind, "accepted");
    if (mapped.kind !== "accepted") {
      return;
    }

    const inbound = mapped.envelope.inboundMessage;
    assert.equal(inbound.type, "command");
    assert.equal(inbound.command, "perm");
    assert.deepEqual(inbound.args, [
      "approve",
      pending.permission.permissionId
    ]);

    const resolved = await harness.commands.dispatch(inbound);
    assert.equal(resolved.status, "ok");
    assert.equal(resolved.message, "Approval granted.");
    assert.equal(
      harness.store.pendingPermissions.get(pending.permission.permissionId)
        ?.resolution,
      "approved"
    );
  } finally {
    await harness.dispose();
  }
});

test("commands service rejects /perm list when no session is bound", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.commands.dispatch(createCommand("perm"));
    assert.equal(result.status, "rejected");
    assert.equal(result.message, "/perm requires a bound session.");
  } finally {
    await harness.dispose();
  }
});

test("commands service status uses the injected codex status provider output", async () => {
  const harness = await createHarness({
    statusTextProvider: async () =>
      [
        "Model: gpt-5.4",
        "Reasoning effort: xhigh",
        "5-hour limit remaining (latest known): 85%",
        "Weekly limit remaining (latest known): 96%"
      ].join("\n")
  });

  try {
    const status = await harness.commands.dispatch(createCommand("status"));
    assert.equal(status.status, "ok");
    assert.equal(
      status.message,
      [
        "Model: gpt-5.4",
        "Reasoning effort: xhigh",
        "5-hour limit remaining (latest known): 85%",
        "Weekly limit remaining (latest known): 96%"
      ].join("\n")
    );
  } finally {
    await harness.dispose();
  }
});

test("commands service reports and updates reasoning effort through the injected config service", async () => {
  let currentEffort = "high";
  const harness = await createHarness({
    reasoningConfigService: {
      supportedValues: ["minimal", "low", "medium", "high", "xhigh"],
      getCurrentEffort() {
        return currentEffort;
      },
      setCurrentEffort(value: string) {
        currentEffort = value;
      }
    }
  });

  try {
    const current = await harness.commands.dispatch(createCommand("reasoning"));
    assert.equal(current.status, "ok");
    assert.match(current.message, /Current reasoning effort: high\./);

    const updated = await harness.commands.dispatch(
      createCommand("reasoning", {
        args: ["xhigh"]
      })
    );
    assert.equal(updated.status, "ok");
    assert.equal(
      updated.message,
      "Updated reasoning effort to xhigh. This applies to new Codex runs."
    );
    assert.equal(currentEffort, "xhigh");
  } finally {
    await harness.dispose();
  }
});

test("commands service switches a bound session between workspace and system scope", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(createCommand("new"));
    const sessionId = created.data?.sessionId;
    assert.equal(sessionId, "session-1");

    const current = await harness.commands.dispatch(createCommand("scope"));
    assert.equal(current.status, "ok");
    assert.equal(current.message, "Current access scope is workspace.");

    const widened = await harness.commands.dispatch(
      createCommand("scope", {
        args: ["system"]
      })
    );
    assert.equal(widened.status, "ok");
    assert.equal(widened.message, "Updated access scope to system.");
    assert.equal(
      harness.store.sessions.get(sessionId ?? "")?.accessScope,
      "system"
    );

    harness.store.sessions.update(sessionId ?? "", {
      cwd: "/etc"
    });

    const narrowed = await harness.commands.dispatch(
      createCommand("scope", {
        args: ["workspace"]
      })
    );
    assert.equal(narrowed.status, "ok");
    assert.match(narrowed.message, /Cwd moved back to \/workspaces\/main/);
    assert.equal(
      harness.store.sessions.get(sessionId ?? "")?.accessScope,
      "workspace"
    );
    assert.equal(
      harness.store.sessions.get(sessionId ?? "")?.cwd,
      DEFAULT_WORKSPACE_ROOT
    );
  } finally {
    await harness.dispose();
  }
});

test("commands service rejects unsupported reasoning effort values", async () => {
  const harness = await createHarness({
    reasoningConfigService: {
      supportedValues: ["minimal", "low", "medium", "high", "xhigh"],
      getCurrentEffort() {
        return "high";
      },
      async setCurrentEffort() {
        throw new Error(
          "setCurrentEffort should not be called for invalid values."
        );
      }
    }
  });

  try {
    const rejected = await harness.commands.dispatch(
      createCommand("reasoning", {
        args: ["turbo"]
      })
    );
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.message, /Unsupported reasoning effort "turbo"/);
  } finally {
    await harness.dispose();
  }
});

test("commands service prunes inactive unbound sessions and releases routing actors", async () => {
  const harness = await createHarness();

  try {
    const created = await harness.commands.dispatch(createCommand("new"));
    assert.equal(created.status, "ok");
    assert.equal(created.data?.sessionId, "session-1");

    harness.store.sessions.save({
      sessionId: "session-keep",
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      extraAllowedDirs: [],
      cwd: DEFAULT_WORKSPACE_ROOT,
      mode: "code",
      accessScope: "workspace",
      runState: "idle",
      createdAt: "2026-03-06T16:40:00.000Z",
      updatedAt: "2026-03-06T16:40:00.000Z"
    });
    harness.store.sessions.save({
      sessionId: "session-old",
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      extraAllowedDirs: [],
      cwd: DEFAULT_WORKSPACE_ROOT,
      mode: "code",
      accessScope: "workspace",
      runState: "failed",
      createdAt: "2026-03-06T16:30:00.000Z",
      updatedAt: "2026-03-06T16:30:00.000Z"
    });
    harness.store.sessions.save({
      sessionId: "session-bound",
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      extraAllowedDirs: [],
      cwd: DEFAULT_WORKSPACE_ROOT,
      mode: "code",
      accessScope: "workspace",
      runState: "idle",
      createdAt: "2026-03-06T16:20:00.000Z",
      updatedAt: "2026-03-06T16:20:00.000Z"
    });
    harness.store.sessions.save({
      sessionId: "session-active",
      workspaceRoot: DEFAULT_WORKSPACE_ROOT,
      extraAllowedDirs: [],
      cwd: DEFAULT_WORKSPACE_ROOT,
      mode: "code",
      accessScope: "workspace",
      runState: "running",
      activeRunId: "run-active",
      createdAt: "2026-03-06T16:10:00.000Z",
      updatedAt: "2026-03-06T16:10:00.000Z"
    });
    harness.store.chatBindings.save({
      chatId: "chat-2",
      sessionId: "session-bound"
    });

    harness.routing.registerSession("session-keep");
    harness.routing.registerSession("session-old");

    const pruned = await harness.commands.dispatch(
      createCommand("prune", {
        args: ["1"]
      })
    );
    assert.equal(pruned.status, "ok");
    assert.match(pruned.message, /Pruned 1 inactive unbound session\./);
    assert.match(pruned.message, /Kept 1 newest inactive unbound session\./);
    assert.match(pruned.message, /Skipped 2 bound and 1 active sessions\./);
    assert.deepEqual(pruned.data?.deletedSessionIds, ["session-old"]);
    assert.deepEqual(pruned.data?.keptSessionIds, ["session-keep"]);

    assert.equal(harness.store.sessions.get("session-old"), null);
    assert.ok(harness.store.sessions.get("session-keep"));
    assert.ok(harness.store.sessions.get("session-bound"));
    assert.ok(harness.store.sessions.get("session-active"));
    assert.ok(harness.store.sessions.get("session-1"));
    assert.equal(harness.routing.getSessionActor("session-old"), null);
    assert.ok(harness.routing.getSessionActor("session-keep"));
  } finally {
    await harness.dispose();
  }
});

async function createHarness(): Promise<{
  readonly store: BridgeStore;
  readonly routing: InMemoryRoutingCore;
  readonly approval: ApprovalService;
  readonly commands: CommandsService;
  dispose(): Promise<void>;
}>;
async function createHarness(
  options: {
    readonly statusTextProvider?: () => Promise<string> | string;
    readonly languageResolver?: (userId: string) => "zh" | "en";
    readonly reasoningConfigService?: {
      readonly supportedValues: readonly string[];
      getCurrentEffort(): Promise<string | null> | string | null;
      setCurrentEffort(value: string): Promise<void> | void;
    };
  } = {}
): Promise<{
  readonly store: BridgeStore;
  readonly routing: InMemoryRoutingCore;
  readonly approval: ApprovalService;
  readonly commands: CommandsService;
  dispose(): Promise<void>;
}> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), "codex-telegram-bridge-commands-")
  );
  const store = await createBridgeStore({
    databaseFilePath: join(tempRoot, "bridge.sqlite3")
  });
  const routing = new InMemoryRoutingCore();
  const approval = new ApprovalService(store.pendingPermissions, {
    clock: () => new Date("2026-03-06T16:00:00.000Z")
  });
  const commands = new CommandsService(store, routing, approval, {
    defaultWorkspaceRoot: DEFAULT_WORKSPACE_ROOT,
    sessionIdFactory: () => "session-1",
    workspaceMutationOptions: {
      requireExistingPaths: false
    },
    ...(options.languageResolver
      ? { languageResolver: options.languageResolver }
      : {}),
    ...(options.statusTextProvider
      ? { statusTextProvider: options.statusTextProvider }
      : {}),
    ...(options.reasoningConfigService
      ? { reasoningConfigService: options.reasoningConfigService }
      : {})
  });

  return {
    store,
    routing,
    approval,
    commands,
    async dispose() {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

function createCommand(
  command:
    | "bind"
    | "new"
    | "status"
    | "stop"
    | "cwd"
    | "perm"
    | "prune"
    | "reasoning"
    | "scope"
    | "help",
  extra: Record<string, unknown> = {}
) {
  return {
    type: "command" as const,
    command,
    envelope: {
      chatId: "chat-1",
      userId: "user-1",
      messageId: "message-1",
      receivedAt: "2026-03-06T14:00:00.000Z"
    },
    ...extra
  };
}

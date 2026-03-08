import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAccessScopeChange,
  applyCwdChange,
  confirmAddDir,
  initializeNewSessionWorkspace,
  prepareAddDirConfirmation
} from "../../src/core/workspace/session-workspace.js";

test("initializeNewSessionWorkspace inherits bound workspace root and falls back invalid cwd", async () => {
  const result = await initializeNewSessionWorkspace({
    defaultWorkspaceRoot: "/default-root",
    currentBoundSession: { workspaceRoot: "/bound-root" },
    requestedCwd: "/outside-root"
  });

  assert.equal(result.ok, true);
  assert.equal(result.session.workspaceRoot, "/bound-root");
  assert.equal(result.session.cwd, "/bound-root");
  assert.equal(result.session.mode, "code");
  assert.equal(result.session.accessScope, "workspace");
  assert.ok(result.issues.some((issue) => issue.field === "requestedCwd"));
});

test("initializeNewSessionWorkspace keeps a normalized cwd when the only cwd issue is non-blocking", async () => {
  const result = await initializeNewSessionWorkspace({
    defaultWorkspaceRoot: "/default-root",
    currentBoundSession: { workspaceRoot: "/bound-root" },
    requestedCwd: "/bound-root/./child"
  });

  assert.equal(result.ok, true);
  assert.equal(result.session.workspaceRoot, "/bound-root");
  assert.equal(result.session.cwd, "/bound-root/child");
  assert.equal(result.session.accessScope, "workspace");
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "path_not_normalized" && issue.field === "cwd"
    )
  );
  assert.equal(
    result.issues.some((issue) => issue.field === "requestedCwd"),
    false
  );
});

test("applyCwdChange rejects a cwd outside the allowed directory set", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: ["/extra"],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };

  const result = await applyCwdChange(session, "/not-allowed");

  assert.equal(result.ok, false);
  assert.deepEqual(result.session, session);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "path_outside_allowed_set" && issue.field === "cwd"
    )
  );
});

test("applyCwdChange keeps a normalized cwd when the only cwd issue is non-blocking", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: [],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };

  const result = await applyCwdChange(session, "/workspace/./logs");

  assert.equal(result.ok, true);
  assert.equal(result.session.cwd, "/workspace/logs");
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "path_not_normalized" && issue.field === "cwd"
    )
  );
});

test("applyAccessScopeChange falls back cwd to workspace root when narrowing from system scope", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: [],
    cwd: "/etc",
    mode: "code" as const,
    accessScope: "system" as const
  };

  const result = await applyAccessScopeChange(session, "workspace");

  assert.equal(result.ok, true);
  assert.equal(result.fallbackCwdApplied, true);
  assert.equal(result.session.accessScope, "workspace");
  assert.equal(result.session.cwd, "/workspace");
  assert.ok(result.issues.some((issue) => issue.field === "scope"));
});

test("prepareAddDirConfirmation rejects duplicates already in the allowed set", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: ["/extra"],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };

  const result = await prepareAddDirConfirmation(session, "/extra");

  assert.equal(result.ok, false);
  assert.equal(result.confirmation, undefined);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "path_duplicate" && issue.field === "requestedPath"
    )
  );
});

test("prepareAddDirConfirmation short-circuits duplicate paths before filesystem validation", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: [],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };
  const inspector = {
    async lstat() {
      throw new Error(
        "duplicate path should not trigger filesystem inspection"
      );
    },
    async realpath() {
      throw new Error(
        "duplicate path should not trigger filesystem inspection"
      );
    }
  };

  const result = await prepareAddDirConfirmation(session, "/workspace", {
    inspector
  });

  assert.equal(result.ok, false);
  assert.equal(result.confirmation, undefined);
  assert.deepEqual(result.issues, [
    {
      code: "path_duplicate",
      field: "requestedPath",
      message: "Directory is already in the allowed set: /workspace."
    }
  ]);
});

test("prepareAddDirConfirmation rejects an empty requested path", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: [],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };

  const result = await prepareAddDirConfirmation(session, "   ");

  assert.equal(result.ok, false);
  assert.equal(result.confirmation, undefined);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "path_empty" && issue.field === "extraAllowedDirs[0]"
    )
  );
});

test("confirmAddDir applies a validated directory change", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: [],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };

  const result = await confirmAddDir(session, {
    action: "adddir",
    requestedPath: "/logs/../logs",
    normalizedPath: "/logs",
    summary: "Allow access to /logs"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.session.extraAllowedDirs, ["/logs"]);
  assert.equal(result.session.accessScope, "workspace");
});

test("confirmAddDir rejects a duplicate confirmation against the current session", async () => {
  const session = {
    workspaceRoot: "/workspace",
    extraAllowedDirs: ["/logs"],
    cwd: "/workspace",
    mode: "code" as const,
    accessScope: "workspace" as const
  };

  const result = await confirmAddDir(session, {
    action: "adddir",
    requestedPath: "/logs",
    normalizedPath: "/logs",
    summary: "Allow access to /logs"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.session, session);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "path_duplicate" && issue.field === "extraAllowedDirs[1]"
    )
  );
});

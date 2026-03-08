import assert from "node:assert/strict";
import test from "node:test";
import {
  type FilesystemInspector,
  validateWorkspaceSession
} from "../../src/core/workspace/path-policy.js";

test("validateWorkspaceSession preserves filesystem-derived issues when inspector checks are batched", async () => {
  const inspector = createInspector({
    "/workspace": {
      exists: true,
      isDirectory: true,
      isSymbolicLink: false,
      realpath: "/workspace"
    },
    "/workspace/current": {
      exists: true,
      isDirectory: true,
      isSymbolicLink: true,
      realpath: "/outside"
    },
    "/missing-extra": {
      exists: false,
      isDirectory: false,
      isSymbolicLink: false,
      realpath: "/missing-extra"
    }
  });

  const result = await validateWorkspaceSession(
    {
      workspaceRoot: "/workspace",
      extraAllowedDirs: ["/missing-extra"],
      cwd: "/workspace/current",
      mode: "code"
    },
    {
      inspector,
      requireExistingPaths: true
    }
  );

  assert.ok(
    result.issues.some(
      (issue) => issue.code === "path_missing" && issue.field === "allowedDirs"
    )
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "path_missing" && issue.field === "extraAllowedDirs[0]"
    )
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "path_symlink_escape" && issue.field === "cwd"
    )
  );
});

test("validateWorkspaceSession reuses filesystem inspections across roots and field checks", async () => {
  const lstatCalls = new Map<string, number>();
  const realpathCalls = new Map<string, number>();
  const inspector = createInspector(
    {
      "/workspace": {
        exists: true,
        isDirectory: true,
        isSymbolicLink: false,
        realpath: "/workspace"
      },
      "/extra": {
        exists: true,
        isDirectory: true,
        isSymbolicLink: false,
        realpath: "/extra"
      }
    },
    {
      lstatCalls,
      realpathCalls
    }
  );

  const result = await validateWorkspaceSession(
    {
      workspaceRoot: "/workspace",
      extraAllowedDirs: ["/extra"],
      cwd: "/workspace",
      mode: "code"
    },
    {
      inspector,
      visiblePolicy: {
        mountedRoots: ["/workspace", "/extra"]
      },
      requireExistingPaths: true
    }
  );

  assert.equal(result.issues.length, 0);
  assert.deepEqual(
    [...lstatCalls.entries()],
    [
      ["/workspace", 1],
      ["/extra", 1]
    ]
  );
  assert.deepEqual(
    [...realpathCalls.entries()],
    [
      ["/workspace", 1],
      ["/extra", 1]
    ]
  );
});

function createInspector(
  entries: Record<
    string,
    {
      readonly exists: boolean;
      readonly isDirectory: boolean;
      readonly isSymbolicLink: boolean;
      readonly realpath: string;
    }
  >,
  recorder?: {
    readonly lstatCalls: Map<string, number>;
    readonly realpathCalls: Map<string, number>;
  }
): FilesystemInspector {
  return {
    async lstat(targetPath: string) {
      incrementCallCount(recorder?.lstatCalls, targetPath);
      const entry = entries[targetPath];
      if (!entry) {
        throw new Error(`Unexpected lstat path: ${targetPath}`);
      }

      return {
        exists: entry.exists,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink
      };
    },
    async realpath(targetPath: string) {
      incrementCallCount(recorder?.realpathCalls, targetPath);
      const entry = entries[targetPath];
      if (!entry) {
        throw new Error(`Unexpected realpath path: ${targetPath}`);
      }

      return entry.realpath;
    }
  };
}

function incrementCallCount(
  counter: Map<string, number> | undefined,
  targetPath: string
): void {
  if (!counter) {
    return;
  }

  counter.set(targetPath, (counter.get(targetPath) ?? 0) + 1);
}

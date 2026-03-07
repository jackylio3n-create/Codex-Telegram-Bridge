import type { SessionRecord } from "../../store/types.js";

export interface RollingSummarySnapshot {
  readonly sessionId: string;
  readonly mode: SessionRecord["mode"];
  readonly workspaceRoot: string;
  readonly extraAllowedDirs: readonly string[];
  readonly cwd: string;
  readonly runState: SessionRecord["runState"];
  readonly activeRunId: string | null;
  readonly codexThreadId: string | null;
  readonly lastError: string | null;
  readonly staleRecovered: boolean;
  readonly pendingApprovals: readonly string[];
  readonly recentApprovalDecisions: readonly string[];
  readonly recentCommands: readonly string[];
  readonly recentBoundaryChanges: readonly string[];
  readonly recentRuntimeOutcomes: readonly string[];
}

export interface RollingSummaryResult {
  readonly snapshot: RollingSummarySnapshot;
  readonly content: string;
}

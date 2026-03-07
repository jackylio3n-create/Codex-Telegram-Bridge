import type { AppConfig, ConfigIssue } from "../config/index.js";
import type { FilesystemInspector, VisibleDirectoryPolicy } from "../core/workspace/index.js";
import type { BridgeStore } from "../store/types.js";

export type DoctorCheckStatus = "ok" | "warning" | "error" | "skipped";

export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface DoctorSummary {
  readonly status: DoctorCheckStatus;
  readonly okCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly skippedCount: number;
}

export interface DoctorReport {
  readonly generatedAt: string;
  readonly checks: readonly DoctorCheck[];
  readonly summary: DoctorSummary;
}

export interface DoctorContext {
  readonly config: AppConfig;
  readonly configIssues: readonly ConfigIssue[];
  readonly startupIssues: readonly ConfigIssue[];
  readonly filesystemInspector: FilesystemInspector;
  readonly visiblePolicy?: VisibleDirectoryPolicy;
  readonly now: Date;
  readonly offsetChannelKey: string;
  readonly offsetJumpWarningThreshold: number;
  readonly store?: BridgeStore;
  readonly storeError?: string;
}

export interface DoctorRunOptions {
  readonly clock?: () => Date;
  readonly filesystemInspector?: FilesystemInspector;
  readonly visiblePolicy?: VisibleDirectoryPolicy;
  readonly offsetChannelKey?: string;
}

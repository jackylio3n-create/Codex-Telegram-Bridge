import { randomUUID } from "node:crypto";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalService } from "../../core/approval/index.js";
import type { ApprovalResolutionResult } from "../../core/approval/types.js";
import { AuditService } from "../../core/audit/index.js";
import { CommandsService } from "../../core/commands/index.js";
import type { CommandExecutionResult } from "../../core/commands/types.js";
import { InMemoryRoutingCore } from "../../core/router/index.js";
import {
  buildPersistedSessionActorSnapshot,
  toWorkspaceSessionState
} from "../../core/session/index.js";
import { SummaryService } from "../../core/summary/index.js";
import type {
  ImageUserInput,
  NormalizedApprovalDecision,
  NormalizedCommandRequest,
  NormalizedInboundMessage,
  SessionActorSnapshot
} from "../../core/types/index.js";
import {
  buildRuntimeWorkspaceContext,
  confirmAddDir,
  createNodeFilesystemInspector,
  validateWorkspaceSession,
  type AddDirConfirmation,
  type FilesystemInspector,
  type VisibleDirectoryPolicy,
  type WorkspaceMutationOptions
} from "../../core/workspace/index.js";
import type { AppConfig } from "../../config/index.js";
import { createLogger, type Logger } from "../../logger/index.js";
import { selectText, type PromptLanguage } from "../../i18n.js";
import {
  createCodexReasoningConfigService,
  createCodexStatusTextProvider,
  startCodexRun
} from "../codex/index.js";
import type {
  CodexCancelOutcome,
  CodexExecCommandBeginEvent,
  CodexExecCommandEndEvent,
  CodexNormalizedEvent,
  CodexPatchApplyBeginEvent,
  CodexRunController,
  CodexRunResult
} from "../codex/types.js";
import { createBridgeStore, type BridgeStore } from "../../store/index.js";
import type {
  PendingPermissionRecord,
  SessionPatch,
  SessionRecord,
  SessionRunState
} from "../../store/types.js";
import {
  TelegramBotClient,
  TelegramPollingService,
  TelegramPreviewPublisher
} from "../../transport/telegram/index.js";
import type {
  TelegramInboundEnvelope,
  TelegramInlineKeyboardMarkup,
  TelegramPreviewHandle
} from "../../transport/telegram/types.js";
import type { TelegramFetch } from "../../transport/telegram/client.js";
import { type BridgeRuntimeState, writeBridgeRuntimeState } from "./state.js";

const DEFAULT_POLL_FAILURE_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
const DEFAULT_INPUT_RATE_LIMIT = { max: 5, windowMs: 10_000 } as const;
const DEFAULT_DANGEROUS_COMMAND_RATE_LIMIT = {
  max: 4,
  windowMs: 30_000
} as const;
const DEFAULT_MEDIA_FILE_SIZE_CAP_BYTES = 20 * 1024 * 1024;
const ADD_DIR_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STATES = new Set<SessionRunState>([
  "running",
  "waiting_approval",
  "cancelling"
]);
const ACTIVE_COMMANDS = new Set<NormalizedCommandRequest["command"]>([
  "new",
  "bind",
  "cwd",
  "mode",
  "adddir",
  "stop",
  "prune"
]);

export interface BridgeRuntimeOptions {
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly store?: BridgeStore;
  readonly clock?: () => Date;
  readonly telegramFetchImplementation?: TelegramFetch;
  readonly codexExecutablePath?: string;
  readonly codexEnvironment?: NodeJS.ProcessEnv;
  readonly workspaceMutationOptions?: WorkspaceMutationOptions;
  readonly filesystemInspector?: FilesystemInspector;
  readonly visiblePolicy?: VisibleDirectoryPolicy;
}

interface PollMetrics {
  readonly startedAt: string | null;
  readonly lastPollAt: string | null;
  readonly lastSuccessfulPollAt: string | null;
  readonly lastFailedPollAt: string | null;
  readonly consecutivePollFailures: number;
  readonly lastPollError: string | null;
  readonly previousOffset: number | null;
  readonly currentOffset: number | null;
  readonly lastEvent: string | null;
}

interface ActiveRunContext {
  readonly sessionId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly inputType: "text" | "image";
  controller: CodexRunController | null;
  readonly startedAt: string;
  readonly imagePaths: readonly string[];
  previewHandle: TelegramPreviewHandle;
  eventTail: Promise<void>;
  lifecycle: "running" | "parking_for_approval" | "awaiting_approval";
  pendingApproval: PendingApprovalContext | null;
  cancelOutcome: CodexCancelOutcome | null;
  parkingCancelOutcome: CodexCancelOutcome | null;
}

interface PendingApprovalContext {
  readonly permissionId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly requestedAt: string;
  decision: "approve" | "deny" | "expired" | null;
}

interface PendingAddDirConfirmation {
  readonly chatId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly confirmation: AddDirConfirmation;
  readonly expiresAt: number;
}

class SlidingWindowRateLimiter {
  readonly #events = new Map<string, number[]>();

  allow(key: string, maxEvents: number, windowMs: number): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (this.#events.get(key) ?? []).filter(
      (timestamp) => timestamp >= cutoff
    );
    if (recent.length >= maxEvents) {
      this.#events.set(key, recent);
      return false;
    }

    recent.push(now);
    this.#events.set(key, recent);
    return true;
  }
}

export class BridgeRuntime {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #store: BridgeStore;
  readonly #ownsStore: boolean;
  readonly #clock: () => Date;
  readonly #routing: InMemoryRoutingCore;
  readonly #approval: ApprovalService;
  readonly #commands: CommandsService;
  readonly #audit: AuditService;
  readonly #summary: SummaryService;
  readonly #telegramClient: TelegramBotClient;
  readonly #polling: TelegramPollingService;
  readonly #preview: TelegramPreviewPublisher;
  readonly #filesystemInspector: FilesystemInspector;
  readonly #visiblePolicy: VisibleDirectoryPolicy | undefined;
  readonly #codexExecutablePath: string;
  readonly #codexEnvironment: NodeJS.ProcessEnv | undefined;
  readonly #workspaceMutationOptions: WorkspaceMutationOptions;
  readonly #activeRuns = new Map<string, ActiveRunContext>();
  readonly #activeRunCompletions = new Map<string, Promise<void>>();
  readonly #pendingAddDirConfirmations = new Map<
    string,
    PendingAddDirConfirmation
  >();
  readonly #inputRateLimiter = new SlidingWindowRateLimiter();
  readonly #dangerousCommandRateLimiter = new SlidingWindowRateLimiter();
  #stateWriteTail: Promise<void> = Promise.resolve();
  #running = false;
  #stopping = false;
  #loopPromise: Promise<void> | null = null;
  #pollMetrics: PollMetrics = {
    startedAt: null,
    lastPollAt: null,
    lastSuccessfulPollAt: null,
    lastFailedPollAt: null,
    consecutivePollFailures: 0,
    lastPollError: null,
    previousOffset: null,
    currentOffset: null,
    lastEvent: null
  };

  private constructor(options: {
    readonly config: AppConfig;
    readonly logger: Logger;
    readonly store: BridgeStore;
    readonly ownsStore: boolean;
    readonly clock: () => Date;
    readonly telegramFetchImplementation?: TelegramFetch;
    readonly codexExecutablePath: string;
    readonly codexEnvironment?: NodeJS.ProcessEnv;
    readonly workspaceMutationOptions: WorkspaceMutationOptions;
    readonly filesystemInspector: FilesystemInspector;
    readonly visiblePolicy?: VisibleDirectoryPolicy;
  }) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: "bridge-runtime" });
    this.#store = options.store;
    this.#ownsStore = options.ownsStore;
    this.#clock = options.clock;
    this.#filesystemInspector = options.filesystemInspector;
    this.#visiblePolicy = options.visiblePolicy;
    this.#codexExecutablePath = options.codexExecutablePath;
    this.#codexEnvironment = options.codexEnvironment;
    this.#workspaceMutationOptions = options.workspaceMutationOptions;
    this.#routing = new InMemoryRoutingCore();
    this.#approval = new ApprovalService(this.#store.pendingPermissions, {
      clock: this.#clock
    });
    this.#commands = new CommandsService(
      this.#store,
      this.#routing,
      this.#approval,
      {
        defaultWorkspaceRoot: this.#config.defaultWorkspaceRoot,
        workspaceMutationOptions: this.#workspaceMutationOptions,
        statusTextProvider: createCodexStatusTextProvider(
          this.#config.codexHome
        ),
        reasoningConfigService: createCodexReasoningConfigService(
          this.#config.codexHome
        ),
        languageResolver: (userId) =>
          this.#store.telegramUserAuth.get(userId)?.preferredLanguage ?? "en"
      }
    );
    this.#audit = new AuditService(this.#store.auditLogs, {
      clock: this.#clock
    });
    this.#summary = new SummaryService(this.#store, { clock: this.#clock });
    this.#telegramClient = new TelegramBotClient({
      botToken: this.#config.telegramBotToken,
      ...(options.telegramFetchImplementation
        ? { fetchImplementation: options.telegramFetchImplementation }
        : {})
    });
    this.#polling = new TelegramPollingService(
      this.#telegramClient,
      this.#store,
      {
        botToken: this.#config.telegramBotToken,
        allowedUserIds: this.#config.allowedTelegramUserIds,
        verificationPasswordHash: this.#config.verificationPasswordHash,
        ownerUserId: this.#config.ownerTelegramUserId,
        ownerChatId: this.#config.ownerTelegramChatId,
        pollingTimeoutSeconds: 30,
        offsetChannelKey: "telegram:getUpdates",
        previewCapabilityMode: "edit",
        previewMaxLength: this.#config.defaults.previewMaxLength,
        finalChunkMaxLength: this.#config.defaults.finalChunkMaxLength,
        tempDirectoryPath: this.#config.paths.tempDir
      }
    );
    this.#preview = new TelegramPreviewPublisher(this.#telegramClient, {
      previewCapabilityMode: "edit",
      previewMaxLength: this.#config.defaults.previewMaxLength,
      finalChunkMaxLength: this.#config.defaults.finalChunkMaxLength
    });
  }

  static async create(options: BridgeRuntimeOptions): Promise<BridgeRuntime> {
    const clock = options.clock ?? (() => new Date());
    const filesystemInspector =
      options.filesystemInspector ?? createNodeFilesystemInspector();
    const logger =
      options.logger ??
      createLogger({
        name: options.config.appName,
        level: options.config.logLevel,
        console: true,
        filePath: options.config.paths.logFilePath,
        redactValues: [
          options.config.telegramBotToken,
          ...(options.config.verificationPasswordHash
            ? [options.config.verificationPasswordHash]
            : [])
        ]
      });
    const store =
      options.store ??
      (await createBridgeStore({ config: options.config, clock }));

    return new BridgeRuntime({
      config: options.config,
      logger,
      store,
      ownsStore: !options.store,
      clock,
      ...(options.telegramFetchImplementation
        ? { telegramFetchImplementation: options.telegramFetchImplementation }
        : {}),
      codexExecutablePath:
        options.codexExecutablePath ??
        process.env.CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE ??
        "codex",
      ...(options.codexEnvironment
        ? { codexEnvironment: options.codexEnvironment }
        : {}),
      workspaceMutationOptions: {
        inspector: filesystemInspector,
        ...(options.visiblePolicy
          ? { visiblePolicy: options.visiblePolicy }
          : {}),
        ...(options.workspaceMutationOptions ?? {})
      },
      filesystemInspector,
      ...(options.visiblePolicy ? { visiblePolicy: options.visiblePolicy } : {})
    });
  }

  async runUntilStopped(): Promise<void> {
    if (!this.#loopPromise) {
      this.#loopPromise = this.#runLoop();
    }

    return this.#loopPromise;
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      this.#logger.info(
        "Stop requested while shutdown is already in progress."
      );
      this.#polling.stop();
      await Promise.allSettled([...this.#activeRunCompletions.values()]);
      await this.#loopPromise;
      return;
    }

    this.#stopping = true;
    this.#logger.info("Bridge runtime stopping.", {
      activeRunCount: this.#activeRuns.size,
      activeRunCompletionCount: this.#activeRunCompletions.size
    });
    this.#polling.stop();
    this.#logger.info("Polling stop requested.");
    await this.#persistState("stopping");
    this.#logger.info("Runtime state persisted as stopping.");
    await this.#cancelAllActiveRuns();
    this.#logger.info("Active run cancellation completed.");
    await Promise.allSettled([...this.#activeRunCompletions.values()]);
    this.#logger.info("Active run completions settled.");
    await this.#loopPromise;
    this.#logger.info("Run loop exited.");
  }

  async getRuntimeState(): Promise<BridgeRuntimeState> {
    return this.#buildRuntimeState(
      this.#stopping ? "stopping" : this.#running ? "running" : "stopped"
    );
  }

  async #runLoop(): Promise<void> {
    this.#running = true;
    this.#pollMetrics = {
      ...this.#pollMetrics,
      startedAt: this.#clock().toISOString()
    };
    await this.#hydrateFromStore();
    await this.#persistState("running");

    try {
      while (!this.#stopping) {
        await this.#expirePendingApprovals();
        this.#runStoreCleanup();
        this.#pollMetrics = {
          ...this.#pollMetrics,
          lastPollAt: this.#clock().toISOString()
        };

        try {
          const result = await this.#polling.pollOnce((envelope) =>
            this.#handleInboundEnvelope(envelope)
          );
          this.#pollMetrics = {
            ...this.#pollMetrics,
            previousOffset: result.previousOffset,
            currentOffset: result.nextOffset,
            lastSuccessfulPollAt: this.#clock().toISOString(),
            consecutivePollFailures: 0,
            lastPollError: null
          };
          await this.#persistState("running");
        } catch (error) {
          if (this.#isStoppingAbortError(error)) {
            this.#logger.info("Polling aborted during shutdown.");
            break;
          }

          this.#logger.error("Polling iteration failed.", { error });
          this.#pollMetrics = {
            ...this.#pollMetrics,
            lastFailedPollAt: this.#clock().toISOString(),
            consecutivePollFailures:
              this.#pollMetrics.consecutivePollFailures + 1,
            lastPollError: getErrorMessage(error)
          };
          await this.#persistState("error");
          if (this.#shouldStopRunLoop()) {
            break;
          }

          const backoffMs =
            DEFAULT_POLL_FAILURE_BACKOFF_MS[
              Math.min(
                this.#pollMetrics.consecutivePollFailures - 1,
                DEFAULT_POLL_FAILURE_BACKOFF_MS.length - 1
              )
            ] ??
            DEFAULT_POLL_FAILURE_BACKOFF_MS[
              DEFAULT_POLL_FAILURE_BACKOFF_MS.length - 1
            ];
          await delay(backoffMs);
        }
      }
    } finally {
      this.#running = false;
      await this.#persistState(this.#stopping ? "stopped" : "error");
      if (this.#ownsStore) {
        this.#store.close();
      }
    }
  }

  async #hydrateFromStore(): Promise<void> {
    const unresolved = this.#store.pendingPermissions.list({ resolved: false });
    const unresolvedBySessionRun = new Map<string, PendingPermissionRecord[]>();
    for (const permission of unresolved) {
      const key = createSessionRunKey(permission.sessionId, permission.runId);
      let existing = unresolvedBySessionRun.get(key);
      if (!existing) {
        existing = [];
        unresolvedBySessionRun.set(key, existing);
      }

      existing.push(permission);
    }

    for (const session of this.#store.sessions.list()) {
      let normalized = session;
      if (ACTIVE_RUN_STATES.has(session.runState)) {
        const recoveredAt = this.#clock().toISOString();
        normalized = this.#store.sessions.update(session.sessionId, {
          runState: "failed",
          activeRunId: null,
          cancellationResult: null,
          staleRecovered: true,
          lastError:
            "Recovered after daemon restart while a run was still active.",
          updatedAt: recoveredAt
        });

        if (session.activeRunId) {
          for (const permission of unresolvedBySessionRun.get(
            createSessionRunKey(session.sessionId, session.activeRunId)
          ) ?? []) {
            this.#store.pendingPermissions.resolve(
              permission.permissionId,
              "expired",
              recoveredAt
            );
          }
        }
      }

      this.#routing.registerSession(
        session.sessionId,
        buildPersistedSessionActorSnapshot(this.#store, normalized)
      );
    }

    for (const binding of this.#store.chatBindings.list()) {
      this.#routing.bindChat(binding.chatId, binding.sessionId);
    }
  }

  async #persistState(status: BridgeRuntimeState["status"]): Promise<void> {
    const writeTask = this.#stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const nextState = await this.#buildRuntimeState(status);
        await writeBridgeRuntimeState(
          this.#config.paths.stateFilePath,
          nextState
        );
      });
    this.#stateWriteTail = writeTask;
    await writeTask;
  }

  async #buildRuntimeState(
    status: BridgeRuntimeState["status"]
  ): Promise<BridgeRuntimeState> {
    const activeSessions = this.#store.sessions
      .listOverview()
      .filter((session) => ACTIVE_RUN_STATES.has(session.runState)).length;

    return {
      version: 1,
      phase: "daemon",
      status,
      updatedAt: this.#clock().toISOString(),
      startedAt: this.#pollMetrics.startedAt,
      pid: process.pid,
      appName: this.#config.appName,
      env: this.#config.env,
      logFilePath: this.#config.paths.logFilePath,
      databaseFilePath: this.#store.databaseFilePath,
      activeRunCount: this.#activeRuns.size,
      activeSessionCount: activeSessions,
      boundChatCount: this.#store.chatBindings.list().length,
      lastPollAt: this.#pollMetrics.lastPollAt,
      lastSuccessfulPollAt: this.#pollMetrics.lastSuccessfulPollAt,
      lastFailedPollAt: this.#pollMetrics.lastFailedPollAt,
      consecutivePollFailures: this.#pollMetrics.consecutivePollFailures,
      lastPollError: this.#pollMetrics.lastPollError,
      previousOffset: this.#pollMetrics.previousOffset,
      currentOffset: this.#pollMetrics.currentOffset,
      lastEvent: this.#pollMetrics.lastEvent
    };
  }

  async #expirePendingApprovals(): Promise<void> {
    const expired = this.#approval.expirePendingApprovals(this.#clock());
    if (expired.expiredCount > 0) {
      this.#logger.info("Expired pending approvals.", {
        expiredCount: expired.expiredCount
      });
      for (const permissionId of expired.expiredPermissionIds) {
        await this.#handleExpiredRuntimeApproval(permissionId);
      }
    }
  }

  #runStoreCleanup(): void {
    const now = this.#clock();
    const cleanup = this.#store.runCleanup({
      approvalExpiryOlderThan: new Date(
        now.getTime() -
          this.#config.defaults.expiredApprovalRetentionDays *
            MILLISECONDS_PER_DAY
      ),
      approvalResolutionOlderThan: new Date(
        now.getTime() -
          this.#config.defaults.resolvedApprovalRetentionDays *
            MILLISECONDS_PER_DAY
      ),
      maxSummariesPerSession: this.#config.defaults.maxSummariesPerSession,
      maxAuditRows: this.#config.defaults.maxAuditRows
    });

    if (
      cleanup.deletedExpiredPermissions > 0 ||
      cleanup.deletedResolvedPermissions > 0 ||
      cleanup.deletedSummaryRows > 0 ||
      cleanup.deletedAuditRows > 0
    ) {
      this.#logger.info("Store cleanup removed historical rows.", {
        ...cleanup
      });
    }
  }

  async #cancelAllActiveRuns(): Promise<void> {
    await Promise.all(
      [...this.#activeRuns.keys()].map((sessionId) =>
        this.#requestRunCancellation(sessionId)
      )
    );
  }

  async #handleInboundEnvelope(
    envelope: TelegramInboundEnvelope
  ): Promise<void> {
    this.#pollMetrics = {
      ...this.#pollMetrics,
      lastEvent: formatInboundEventMetric(
        envelope,
        this.#config.defaults.includeRuntimeIdentifiers
      )
    };

    switch (envelope.inboundMessage.type) {
      case "command":
        await this.#handleCommandEnvelope(envelope, envelope.inboundMessage);
        return;
      case "user_input":
        await this.#handleUserInputEnvelope(envelope, envelope.inboundMessage);
        return;
      case "approval_decision":
        await this.#handleApprovalDecisionEnvelope(envelope.inboundMessage);
        return;
    }
  }

  async #handleCommandEnvelope(
    envelope: TelegramInboundEnvelope,
    command: NormalizedCommandRequest
  ): Promise<void> {
    if (
      this.#isDangerousCommand(command.command) &&
      !this.#dangerousCommandRateLimiter.allow(
        envelope.chatId,
        DEFAULT_DANGEROUS_COMMAND_RATE_LIMIT.max,
        DEFAULT_DANGEROUS_COMMAND_RATE_LIMIT.windowMs
      )
    ) {
      await this.#sendText(
        envelope.chatId,
        this.#tChat(
          envelope.chatId,
          "触发频率限制，请稍后再试。",
          "Rate limit reached. Please wait a moment and try again."
        )
      );
      return;
    }

    const boundSessionId =
      this.#store.chatBindings.get(envelope.chatId)?.sessionId ?? null;
    this.#audit.recordUserCommand(
      {
        chatId: envelope.chatId,
        sessionId: boundSessionId,
        runId: null
      },
      buildUserCommandAuditPayload(command, this.#config.defaults.auditLevel)
    );

    if (command.command === "adddir") {
      const confirmed = await this.#tryApplyPendingAddDirConfirmation(
        command as NormalizedCommandRequest & {
          readonly command: "adddir";
          readonly path: string;
        }
      );
      if (confirmed) {
        return;
      }
    }

    const result = await this.#commands.dispatch(command);
    await this.#handleCommandSideEffects(command, result);
    await this.#sendText(envelope.chatId, renderCommandResult(command, result));
  }

  async #handleUserInputEnvelope(
    envelope: TelegramInboundEnvelope,
    input: Extract<NormalizedInboundMessage, { readonly type: "user_input" }>
  ): Promise<void> {
    if (
      !this.#inputRateLimiter.allow(
        envelope.chatId,
        DEFAULT_INPUT_RATE_LIMIT.max,
        DEFAULT_INPUT_RATE_LIMIT.windowMs
      )
    ) {
      await this.#sendText(
        envelope.chatId,
        this.#tChat(
          envelope.chatId,
          "触发频率限制，请稍后再试。",
          "Rate limit reached. Please wait a moment and try again."
        )
      );
      return;
    }

    const routed = await this.#routing.dispatch(input);
    await this.#emitRoutingEffects(routed.effects);
    if (!routed.binding.sessionId) {
      return;
    }

    const session = this.#store.sessions.get(routed.binding.sessionId);
    if (!session) {
      await this.#sendText(
        envelope.chatId,
        this.#tChat(
          envelope.chatId,
          `会话“${routed.binding.sessionId}”已不存在。`,
          `Session "${routed.binding.sessionId}" no longer exists.`
        )
      );
      return;
    }

    this.#audit.recordUserInput(
      {
        chatId: envelope.chatId,
        sessionId: session.sessionId,
        runId: null
      },
      buildUserInputAuditPayload(input)
    );

    if (
      this.#activeRuns.has(session.sessionId) ||
      ACTIVE_RUN_STATES.has(session.runState)
    ) {
      await this.#sendText(
        envelope.chatId,
        this.#tChat(
          envelope.chatId,
          "当前会话正忙，请使用 /status 或 /stop。",
          "This session is already busy. Use /status or /stop."
        )
      );
      return;
    }

    await this.#startSessionRun(session, input);
  }

  async #handleApprovalDecisionEnvelope(
    decision: NormalizedApprovalDecision
  ): Promise<void> {
    const sessionSnapshot = this.#ensurePersistedRoutingSessionSnapshot(
      decision.sessionId
    );
    const resolution = this.#approval.resolveDecision({
      permissionId: decision.permissionId,
      decision: decision.decision,
      chatId: decision.envelope.chatId,
      userId: decision.envelope.userId,
      sessionSnapshot
    });

    if (resolution.status === "approved" || resolution.status === "denied") {
      const routed = await this.#routing.dispatch(decision);
      if (routed.sessionSnapshot) {
        this.#syncSessionSnapshot(decision.sessionId, routed.sessionSnapshot, {
          updatedAt: this.#clock().toISOString()
        });
      }
    }

    if (resolution.permission) {
      this.#audit.recordApprovalDecision(
        {
          chatId: decision.envelope.chatId,
          sessionId: resolution.permission.sessionId,
          runId: resolution.permission.runId
        },
        {
          permissionId: resolution.permission.permissionId,
          decision: decision.decision,
          resolutionStatus: resolution.status
        }
      );
      this.#summary.refreshRollingSummary(resolution.permission.sessionId);
      await this.#handleRuntimeApprovalResolution(resolution);
    }

    await this.#sendText(
      decision.envelope.chatId,
      this.#formatApprovalResolutionMessage(
        decision.envelope.chatId,
        resolution
      )
    );
  }

  async #handleCommandSideEffects(
    command: NormalizedCommandRequest,
    result: CommandExecutionResult
  ): Promise<void> {
    if (command.command === "stop" && result.status === "ok") {
      const binding = this.#store.chatBindings.get(command.envelope.chatId);
      if (binding?.sessionId) {
        await this.#requestRunCancellation(binding.sessionId);
      }
    }

    if (command.command === "bind" && result.status === "ok") {
      const sessionId = extractSessionId(result);
      this.#audit.recordSessionRebind(
        {
          chatId: command.envelope.chatId,
          sessionId,
          runId: null
        },
        {
          previousSessionId: null,
          nextSessionId: sessionId ?? "unknown",
          reason: "bind"
        }
      );
    }

    if (
      command.command === "adddir" &&
      result.status === "confirmation_required"
    ) {
      const binding = this.#store.chatBindings.get(command.envelope.chatId);
      const sessionId = binding?.sessionId;
      const confirmation =
        result.data &&
        typeof result.data === "object" &&
        "confirmation" in result.data
          ? (result.data as { readonly confirmation: AddDirConfirmation })
              .confirmation
          : null;
      if (sessionId && confirmation) {
        const key = createAddDirConfirmationKey(
          command.envelope.chatId,
          command.envelope.userId,
          sessionId,
          command.path
        );
        this.#pendingAddDirConfirmations.set(key, {
          chatId: command.envelope.chatId,
          userId: command.envelope.userId,
          sessionId,
          confirmation,
          expiresAt: this.#clock().getTime() + ADD_DIR_CONFIRMATION_TTL_MS
        });
      }
    }

    if (result.status !== "ok") {
      return;
    }

    const sessionId = extractSessionId(result);
    if (!sessionId) {
      return;
    }

    if (
      command.command === "cwd" ||
      command.command === "mode" ||
      command.command === "new" ||
      command.command === "bind"
    ) {
      this.#summary.refreshRollingSummary(sessionId);
    }
  }

  async #tryApplyPendingAddDirConfirmation(
    command: NormalizedCommandRequest & {
      readonly command: "adddir";
      readonly path: string;
    }
  ): Promise<boolean> {
    const binding = this.#store.chatBindings.get(command.envelope.chatId);
    if (!binding) {
      return false;
    }

    const session = this.#store.sessions.get(binding.sessionId);
    if (!session) {
      return false;
    }

    const key = createAddDirConfirmationKey(
      command.envelope.chatId,
      command.envelope.userId,
      session.sessionId,
      command.path
    );
    const pending = this.#pendingAddDirConfirmations.get(key);
    if (!pending || pending.expiresAt < this.#clock().getTime()) {
      this.#pendingAddDirConfirmations.delete(key);
      return false;
    }

    this.#pendingAddDirConfirmations.delete(key);
    const confirmed = await confirmAddDir(
      toWorkspaceSessionState(session),
      pending.confirmation,
      this.#workspaceMutationOptions
    );
    if (!confirmed.ok) {
      await this.#sendText(
        command.envelope.chatId,
        this.#formatIssuesMessage(
          command.envelope.chatId,
          "chat",
          `已拒绝 /adddir：${command.path}。`,
          `Rejected /adddir for ${command.path}.`,
          confirmed.issues
        )
      );
      return true;
    }

    this.#store.sessions.update(session.sessionId, {
      extraAllowedDirs: confirmed.session.extraAllowedDirs,
      updatedAt: this.#clock().toISOString()
    });
    this.#audit.recordFileChange(
      {
        chatId: command.envelope.chatId,
        sessionId: session.sessionId,
        runId: null
      },
      buildFileChangeAuditPayload(
        "adddir",
        this.#config.defaults.auditLevel,
        pending.confirmation.normalizedPath
      )
    );
    this.#summary.refreshRollingSummary(session.sessionId);
    await this.#sendText(
      command.envelope.chatId,
      this.#tChat(
        command.envelope.chatId,
        `已将 ${pending.confirmation.normalizedPath} 加入允许目录集合。`,
        `Added ${pending.confirmation.normalizedPath} to the allowed directory set.`
      )
    );
    return true;
  }

  async #emitRoutingEffects(
    effects: readonly {
      readonly type: string;
      readonly chatId?: string;
      readonly text?: string;
    }[]
  ): Promise<void> {
    for (const effect of effects) {
      if (
        (effect.type === "chat_feedback" ||
          effect.type === "command_rejected" ||
          effect.type === "session_event_rejected") &&
        effect.chatId &&
        effect.text
      ) {
        await this.#sendText(effect.chatId, effect.text);
      }
    }
  }

  async #sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.#preview.sendFinalText(chatId, text);
    } catch (error) {
      this.#logger.warn("Telegram send failed, retrying once.", { error });
      await delay(300);
      await this.#preview.sendFinalText(chatId, text);
    }
  }

  #languageForChat(chatId: string): PromptLanguage {
    return (
      this.#store.telegramUserAuth.findByChatId(chatId)?.preferredLanguage ??
      "en"
    );
  }

  #languageForSession(sessionId: string): PromptLanguage {
    const chatId = this.#store.chatBindings
      .list()
      .find((binding) => binding.sessionId === sessionId)?.chatId;
    return chatId ? this.#languageForChat(chatId) : "en";
  }

  #tChat(chatId: string, zh: string, en: string): string {
    return selectText(this.#languageForChat(chatId), zh, en);
  }

  #tSession(sessionId: string, zh: string, en: string): string {
    return selectText(this.#languageForSession(sessionId), zh, en);
  }

  #formatIssuesMessage(
    targetId: string,
    mode: "chat" | "session",
    prefixZh: string,
    prefixEn: string,
    issues: readonly { readonly field: string; readonly message: string }[]
  ): string {
    const prefix =
      mode === "chat"
        ? this.#tChat(targetId, prefixZh, prefixEn)
        : this.#tSession(targetId, prefixZh, prefixEn);
    if (issues.length === 0) {
      return prefix;
    }

    return [
      prefix,
      ...issues.map((issue) => `- ${issue.field}: ${issue.message}`)
    ].join("\n");
  }

  #formatApprovalResolutionMessage(
    chatId: string,
    resolution: ApprovalResolutionResult
  ): string {
    if (resolution.status === "approved") {
      return this.#tChat(chatId, "已批准。", "Approval granted.");
    }

    if (resolution.status === "denied") {
      return this.#tChat(chatId, "已拒绝。", "Approval denied.");
    }

    return this.#tChat(
      chatId,
      "已过期或已处理。",
      "Expired or already handled."
    );
  }

  async #startSessionRun(
    session: SessionRecord,
    input: Extract<NormalizedInboundMessage, { readonly type: "user_input" }>
  ): Promise<void> {
    const validationError = await this.#validateSessionForRun(session);
    if (validationError) {
      await this.#sendText(input.envelope.chatId, validationError);
      return;
    }

    const actor = this.#routing.getSessionActor(session.sessionId);
    if (!actor) {
      throw new Error(`Session actor is missing for ${session.sessionId}.`);
    }

    const runId = randomUUID();
    const startedAt = this.#clock().toISOString();
    const started = await actor.enqueue({
      kind: "run_started",
      runId,
      startedAt
    });
    if (!started.accepted) {
      await this.#emitRoutingEffects(started.effects);
      return;
    }

    this.#syncSessionSnapshot(session.sessionId, started.snapshot, {
      lastError: null,
      cancellationResult: null,
      updatedAt: startedAt
    });
    await this.#persistState("running");

    const prompt = buildPromptFromInput(input);
    const previewHandle = await this.#safeBeginPreview(
      input.envelope.chatId,
      input.contentType === "image"
        ? this.#tChat(
            input.envelope.chatId,
            "已收到图片，正在运行 Codex...",
            "Image received. Running Codex..."
          )
        : this.#tChat(
            input.envelope.chatId,
            "正在运行 Codex...",
            "Running Codex..."
          )
    );

    const runtimeWorkspace = this.#buildRuntimeWorkspace(session);
    const images: string[] = [];
    if (input.contentType === "image") {
      const downloaded = await this.#downloadInboundImage(input);
      images.push(downloaded.tempFilePath);
    }

    const activeRunRef: { current: ActiveRunContext | null } = {
      current: null
    };
    const controller = this.#startCodexController(
      session,
      prompt,
      images,
      runtimeWorkspace,
      (event) => {
        const activeRun = activeRunRef.current;
        if (!activeRun) {
          return;
        }

        activeRun.eventTail = activeRun.eventTail.then(
          () => this.#handleCodexEvent(activeRun, event),
          () => undefined
        );
      }
    );

    const activeRun: ActiveRunContext = {
      sessionId: session.sessionId,
      chatId: input.envelope.chatId,
      userId: input.envelope.userId,
      runId,
      prompt,
      inputType: input.contentType,
      controller,
      startedAt,
      imagePaths: images,
      previewHandle,
      eventTail: Promise.resolve(),
      lifecycle: "running",
      pendingApproval: null,
      cancelOutcome: null,
      parkingCancelOutcome: null
    };
    activeRunRef.current = activeRun;
    this.#activeRuns.set(session.sessionId, activeRun);
    this.#trackRunCompletion(activeRun);
  }

  #trackRunCompletion(activeRun: ActiveRunContext): void {
    const completion = this.#awaitRunCompletion(activeRun).finally(() => {
      if (this.#activeRunCompletions.get(activeRun.sessionId) === completion) {
        this.#activeRunCompletions.delete(activeRun.sessionId);
      }
    });
    this.#activeRunCompletions.set(activeRun.sessionId, completion);
  }

  async #awaitRunCompletion(activeRun: ActiveRunContext): Promise<void> {
    let keepActiveRun = false;
    try {
      if (!activeRun.controller) {
        return;
      }

      const result = await activeRun.controller.completion;
      await activeRun.eventTail;
      if (
        activeRun.pendingApproval &&
        activeRun.lifecycle === "parking_for_approval"
      ) {
        keepActiveRun = await this.#parkRunAwaitingApproval(activeRun, result);
        return;
      }

      await this.#finalizeRun(activeRun, result);
    } catch (error) {
      await activeRun.eventTail;
      await this.#finalizeRunFailure(activeRun, error);
    } finally {
      await this.#releaseActiveRunResources(activeRun, keepActiveRun);
      await this.#persistRuntimeStateIfRunning();
    }
  }

  async #finalizeRun(
    activeRun: ActiveRunContext,
    result: CodexRunResult
  ): Promise<void> {
    const actor = this.#routing.getSessionActor(activeRun.sessionId);
    if (!actor) {
      return;
    }

    const nowIso = this.#clock().toISOString();
    const effectiveCancelOutcome =
      activeRun.cancelOutcome ??
      inferCancelOutcome(actor.getSnapshot(), result, nowIso);
    if (effectiveCancelOutcome) {
      const cancelled = await actor.enqueue({
        kind: "run_cancelled",
        runId: activeRun.runId,
        cancelledAt: nowIso,
        cancellationResult: effectiveCancelOutcome.result
      });
      this.#syncSessionSnapshot(activeRun.sessionId, cancelled.snapshot, {
        updatedAt: nowIso,
        lastError: null
      });
      this.#audit.recordRunCancel(
        {
          chatId: activeRun.chatId,
          sessionId: activeRun.sessionId,
          runId: activeRun.runId
        },
        {
          phase: "completed",
          cancellationResult: effectiveCancelOutcome.result
        }
      );
      this.#summary.refreshRollingSummary(activeRun.sessionId);
      await this.#safeFinalizePreview(
        activeRun.previewHandle,
        effectiveCancelOutcome.result === "full"
          ? this.#tChat(activeRun.chatId, "运行已取消。", "Run cancelled.")
          : effectiveCancelOutcome.result === "partial"
            ? this.#tChat(
                activeRun.chatId,
                "运行已中断，取消前可能已有部分工作完成。",
                "Run interrupted. Some work may have completed before cancellation."
              )
            : this.#tChat(
                activeRun.chatId,
                "已请求取消，但最终进程状态未知。",
                "Cancellation was requested, but the final process state is unknown."
              )
      );
      return;
    }

    if (result.staleRecovered) {
      this.#audit.recordResumeRecovery(
        {
          chatId: activeRun.chatId,
          sessionId: activeRun.sessionId,
          runId: activeRun.runId
        },
        buildResumeRecoveryAuditPayload(
          this.#store.sessions.get(activeRun.sessionId)?.codexThreadId ?? null,
          result.threadId,
          result.usedSummarySeed,
          this.#config.defaults.auditLevel
        )
      );
    }

    if (result.exitCode === 0) {
      const completed = await actor.enqueue({
        kind: "run_completed",
        runId: activeRun.runId,
        completedAt: nowIso
      });
      this.#syncSessionSnapshot(activeRun.sessionId, completed.snapshot, {
        codexThreadId: result.threadId,
        staleRecovered: result.staleRecovered,
        lastError: null,
        updatedAt: nowIso
      });
      this.#summary.refreshRollingSummary(activeRun.sessionId);
      await this.#safeFinalizePreview(
        activeRun.previewHandle,
        result.finalMessage ??
          (result.staleRecovered
            ? "Codex recovered the thread context but did not emit a final message."
            : "Codex completed without a final message.")
      );
      return;
    }

    await this.#finalizeRunFailure(
      activeRun,
      new Error(`Codex exited with status ${String(result.exitCode)}`)
    );
  }

  async #finalizeRunFailure(
    activeRun: ActiveRunContext,
    error: unknown
  ): Promise<void> {
    const message = getErrorMessage(error);
    await this.#markRunFailed(activeRun.sessionId, activeRun.runId, message);
    this.#summary.refreshRollingSummary(activeRun.sessionId);
    await this.#safeFinalizePreview(
      activeRun.previewHandle,
      `Run failed: ${message}`
    );
  }

  async #handleCodexEvent(
    activeRun: ActiveRunContext,
    event: CodexNormalizedEvent
  ): Promise<void> {
    this.#pollMetrics = {
      ...this.#pollMetrics,
      lastEvent: formatCodexEventMetric(
        event,
        activeRun.sessionId,
        this.#config.defaults.includeRuntimeIdentifiers
      )
    };

    switch (event.kind) {
      case "thread_started":
        this.#store.sessions.update(activeRun.sessionId, {
          codexThreadId: event.threadId,
          updatedAt: this.#clock().toISOString()
        });
        return;
      case "agent_message":
        this.#audit.recordAgentText(
          {
            chatId: activeRun.chatId,
            sessionId: activeRun.sessionId,
            runId: activeRun.runId
          },
          buildAgentTextAuditPayload(event.text)
        );
        activeRun.previewHandle = await this.#preview.updatePreview(
          activeRun.previewHandle,
          event.text
        );
        return;
      case "approval_request":
        await this.#handleCodexApprovalRequest(activeRun, event);
        return;
      case "exec_command_begin":
        this.#recordExecCommandBegin(activeRun, event);
        return;
      case "exec_command_end":
        this.#recordExecCommandEnd(activeRun, event);
        return;
      case "patch_apply_begin":
        this.#recordPatchApplyBegin(activeRun, event);
        return;
      default:
        return;
    }
  }

  async #handleCodexApprovalRequest(
    activeRun: ActiveRunContext,
    event: Extract<CodexNormalizedEvent, { readonly kind: "approval_request" }>
  ): Promise<void> {
    if (activeRun.pendingApproval) {
      return;
    }

    const actor = this.#routing.getSessionActor(activeRun.sessionId);
    if (!actor) {
      return;
    }

    const created = this.#approval.createPendingApproval(
      {
        sessionId: activeRun.sessionId,
        runId: activeRun.runId,
        chatId: activeRun.chatId,
        userId: activeRun.userId,
        sourceMessageId: String(
          activeRun.previewHandle.previewMessageId ?? `run:${activeRun.runId}`
        ),
        toolName: "exec_command",
        summary: buildStoredApprovalSummary(
          "exec_command",
          event.summary,
          this.#config.defaults.auditLevel
        )
      },
      this.#languageForChat(activeRun.chatId)
    );

    const requested = await actor.enqueue({
      kind: "approval_requested",
      runId: activeRun.runId,
      permissionId: created.permission.permissionId,
      requestedAt: this.#clock().toISOString()
    });
    if (!requested.accepted) {
      this.#store.pendingPermissions.resolve(
        created.permission.permissionId,
        "expired",
        this.#clock().toISOString()
      );
      await this.#emitRoutingEffects(requested.effects);
      return;
    }

    this.#syncSessionSnapshot(activeRun.sessionId, requested.snapshot, {
      updatedAt: this.#clock().toISOString()
    });
    activeRun.lifecycle = "parking_for_approval";
    activeRun.pendingApproval = {
      permissionId: created.permission.permissionId,
      toolName: created.permission.toolName,
      summary: event.summary,
      requestedAt: created.permission.createdAt,
      decision: null
    };

    this.#logger.warn("Runtime approval requested by Codex exec stream.", {
      permissionId: created.permission.permissionId,
      toolName: created.permission.toolName
    });
    await this.#sendApprovalRequestMessage(
      activeRun,
      created.permission,
      created.replyMarkup,
      event.summary
    );
    activeRun.previewHandle = await this.#preview.updatePreview(
      activeRun.previewHandle,
      this.#tChat(
        activeRun.chatId,
        `等待批准：${event.summary}`,
        `Waiting for approval: ${event.summary}`
      )
    );
    this.#summary.refreshRollingSummary(activeRun.sessionId);
    await this.#persistState("running");

    if (activeRun.controller) {
      try {
        activeRun.parkingCancelOutcome = await activeRun.controller.cancel();
      } catch (error) {
        this.#logger.warn("Failed to park run for approval.", { error });
      }
    }
  }

  async #sendApprovalRequestMessage(
    activeRun: ActiveRunContext,
    permission: PendingPermissionRecord,
    replyMarkup: TelegramInlineKeyboardMarkup,
    commandSummary: string
  ): Promise<void> {
    const lines = [
      this.#tChat(
        activeRun.chatId,
        "Codex 继续执行前需要审批。",
        "Codex needs approval before it can continue."
      ),
      this.#tChat(
        activeRun.chatId,
        `命令：${commandSummary}`,
        `Command: ${commandSummary}`
      ),
      this.#tChat(
        activeRun.chatId,
        `权限 ID：${permission.permissionId}`,
        `Permission ID: ${permission.permissionId}`
      ),
      this.#tChat(
        activeRun.chatId,
        "请使用下方按钮，或执行 /perm approve <permission_id>。",
        "Use the buttons below or /perm approve <permission_id>."
      )
    ];

    try {
      await this.#telegramClient.sendMessage(
        activeRun.chatId,
        lines.join("\n"),
        { replyMarkup }
      );
    } catch (error) {
      this.#logger.warn(
        "Failed to send approval keyboard, falling back to plain text.",
        {
          permissionId: permission.permissionId,
          error
        }
      );
      await this.#sendText(
        activeRun.chatId,
        [
          ...lines,
          `/perm approve ${permission.permissionId}`,
          `/perm deny ${permission.permissionId}`
        ].join("\n")
      );
    }
  }

  async #parkRunAwaitingApproval(
    activeRun: ActiveRunContext,
    result: CodexRunResult
  ): Promise<boolean> {
    if (!activeRun.pendingApproval) {
      return false;
    }

    activeRun.controller = null;
    activeRun.parkingCancelOutcome = null;
    activeRun.lifecycle = "awaiting_approval";

    if (result.threadId) {
      this.#store.sessions.update(activeRun.sessionId, {
        codexThreadId: result.threadId,
        updatedAt: this.#clock().toISOString()
      });
    }

    const decision = activeRun.pendingApproval.decision;
    if (decision === "approve") {
      await this.#resumeApprovedRun(activeRun);
      return false;
    }

    if (decision === "deny" || decision === "expired") {
      await this.#finalizeAwaitingApprovalRun(activeRun, decision);
      return false;
    }

    return true;
  }

  async #handleRuntimeApprovalResolution(
    resolution: ApprovalResolutionResult
  ): Promise<void> {
    if (!resolution.permission) {
      return;
    }

    const activeRun = this.#activeRuns.get(resolution.permission.sessionId);
    if (
      !activeRun?.pendingApproval ||
      activeRun.pendingApproval.permissionId !==
        resolution.permission.permissionId
    ) {
      return;
    }

    if (resolution.status === "approved") {
      activeRun.pendingApproval.decision = "approve";
      if (activeRun.lifecycle === "awaiting_approval") {
        await this.#resumeApprovedRun(activeRun);
      }
      return;
    }

    if (resolution.status === "denied" || resolution.status === "stale") {
      activeRun.pendingApproval.decision =
        resolution.status === "denied" ? "deny" : "expired";
      if (activeRun.lifecycle === "awaiting_approval") {
        await this.#finalizeAwaitingApprovalRun(
          activeRun,
          activeRun.pendingApproval.decision
        );
      }
    }
  }

  async #handleExpiredRuntimeApproval(permissionId: string): Promise<void> {
    const permission = this.#store.pendingPermissions.get(permissionId);
    if (!permission) {
      return;
    }

    const activeRun = this.#activeRuns.get(permission.sessionId);
    if (
      !activeRun?.pendingApproval ||
      activeRun.pendingApproval.permissionId !== permissionId
    ) {
      return;
    }

    activeRun.pendingApproval.decision = "expired";
    if (activeRun.lifecycle === "awaiting_approval") {
      await this.#finalizeAwaitingApprovalRun(activeRun, "expired");
    }
  }

  async #resumeApprovedRun(activeRun: ActiveRunContext): Promise<void> {
    if (!activeRun.pendingApproval) {
      return;
    }

    const session = this.#store.sessions.get(activeRun.sessionId);
    if (!session) {
      return;
    }

    const validationError = await this.#validateSessionForRun(session);
    if (validationError) {
      await this.#finalizeAwaitingApprovalRun(
        activeRun,
        "expired",
        validationError
      );
      return;
    }

    const runtimeWorkspace = this.#buildRuntimeWorkspace(session);
    const continuationPrompt = buildApprovalResumePrompt(
      activeRun.pendingApproval.summary
    );

    const resumedRunRef: { current: ActiveRunContext | null } = {
      current: null
    };
    const controller = this.#startCodexController(
      session,
      continuationPrompt,
      [],
      runtimeWorkspace,
      (event) => {
        const resumedRun = resumedRunRef.current;
        if (!resumedRun) {
          return;
        }

        resumedRun.eventTail = resumedRun.eventTail.then(
          () => this.#handleCodexEvent(resumedRun, event),
          () => undefined
        );
      }
    );

    const resumedRun: ActiveRunContext = {
      ...activeRun,
      controller,
      eventTail: Promise.resolve(),
      lifecycle: "running",
      pendingApproval: null,
      cancelOutcome: null,
      parkingCancelOutcome: null
    };
    resumedRunRef.current = resumedRun;
    this.#activeRuns.set(activeRun.sessionId, resumedRun);
    this.#trackRunCompletion(resumedRun);
    resumedRun.previewHandle = await this.#preview.updatePreview(
      resumedRun.previewHandle,
      "Approval granted. Resuming Codex..."
    );
    await this.#persistState("running");
  }

  async #finalizeAwaitingApprovalRun(
    activeRun: ActiveRunContext,
    outcome: "deny" | "expired",
    explicitMessage?: string
  ): Promise<void> {
    await this.#markRunFailed(
      activeRun.sessionId,
      activeRun.runId,
      explicitMessage ??
        (outcome === "deny" ? "Approval denied." : "Approval expired.")
    );

    await this.#releaseActiveRunResources(activeRun);
    this.#summary.refreshRollingSummary(activeRun.sessionId);
    await this.#safeFinalizePreview(
      activeRun.previewHandle,
      explicitMessage ??
        (outcome === "deny"
          ? "Approval denied. The run was stopped."
          : "Approval expired. The run was stopped.")
    );
    await this.#persistRuntimeStateIfRunning();
  }

  async #markRunFailed(
    sessionId: string,
    runId: string,
    lastError: string
  ): Promise<void> {
    const actor = this.#routing.getSessionActor(sessionId);
    if (!actor) {
      return;
    }

    const failedAt = this.#clock().toISOString();
    const failed = await actor.enqueue({
      kind: "run_failed",
      runId,
      failedAt
    });
    this.#syncSessionSnapshot(sessionId, failed.snapshot, {
      lastError,
      updatedAt: failedAt
    });
  }

  async #releaseActiveRunResources(
    activeRun: ActiveRunContext,
    keepActiveRun = false
  ): Promise<void> {
    if (keepActiveRun) {
      return;
    }

    if (this.#activeRuns.get(activeRun.sessionId) === activeRun) {
      this.#activeRuns.delete(activeRun.sessionId);
    }
    for (const filePath of activeRun.imagePaths) {
      await rm(filePath, { force: true });
    }
  }

  async #persistRuntimeStateIfRunning(): Promise<void> {
    if (!this.#running) {
      return;
    }

    await this.#persistState(this.#stopping ? "stopping" : "running");
  }

  #isStoppingAbortError(error: unknown): boolean {
    return this.#stopping && isAbortError(error);
  }

  #shouldStopRunLoop(): boolean {
    return this.#stopping;
  }

  #recordExecCommandBegin(
    activeRun: ActiveRunContext,
    event: CodexExecCommandBeginEvent
  ): void {
    this.#audit.recordShellExec(
      {
        chatId: activeRun.chatId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId
      },
      buildShellExecAuditPayload(
        event.command,
        null,
        this.#config.defaults.auditLevel
      )
    );
    this.#audit.recordToolStart(
      {
        chatId: activeRun.chatId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId
      },
      buildToolStartAuditPayload(
        "exec_command",
        event.command.join(" "),
        this.#config.defaults.auditLevel
      )
    );
  }

  #recordExecCommandEnd(
    activeRun: ActiveRunContext,
    event: CodexExecCommandEndEvent
  ): void {
    this.#audit.recordToolResult(
      {
        chatId: activeRun.chatId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId
      },
      {
        toolName: "exec_command",
        status: event.exitCode === 0 ? "success" : "error",
        ...buildToolResultDetail(
          event.aggregatedOutput,
          this.#config.defaults.auditLevel
        )
      }
    );
    this.#audit.recordShellExec(
      {
        chatId: activeRun.chatId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId
      },
      buildShellExecAuditPayload(
        event.command,
        event.exitCode,
        this.#config.defaults.auditLevel
      )
    );
  }

  #recordPatchApplyBegin(
    activeRun: ActiveRunContext,
    event: CodexPatchApplyBeginEvent
  ): void {
    this.#audit.recordToolResult(
      {
        chatId: activeRun.chatId,
        sessionId: activeRun.sessionId,
        runId: activeRun.runId
      },
      {
        toolName: "patch_apply",
        status: "success",
        ...buildToolResultDetail(
          event.changedPaths.join(", "),
          this.#config.defaults.auditLevel
        )
      }
    );
  }

  async #safeBeginPreview(
    chatId: string,
    text: string
  ): Promise<TelegramPreviewHandle> {
    try {
      return await this.#preview.beginPreview(chatId, text);
    } catch (error) {
      this.#logger.warn("Failed to publish preview message.", { error });
      return {
        chatId,
        mode: "none",
        previewText: text
      };
    }
  }

  async #safeFinalizePreview(
    handle: TelegramPreviewHandle,
    finalText: string
  ): Promise<void> {
    try {
      await this.#preview.finalizePreview(handle, finalText);
    } catch (error) {
      this.#logger.warn("Failed to finalize preview.", { error });
      await this.#sendText(handle.chatId, finalText);
    }
  }

  #buildRuntimeWorkspace(session: SessionRecord) {
    return buildRuntimeWorkspaceContext(toWorkspaceSessionState(session));
  }

  #buildCodexRuntimeContext(
    runtimeWorkspace: ReturnType<typeof buildRuntimeWorkspaceContext>
  ) {
    return {
      cwd: runtimeWorkspace.cwd,
      extraWritableRoots: runtimeWorkspace.writableRoots.filter(
        (root) => root !== runtimeWorkspace.cwd
      ),
      mode: runtimeWorkspace.mode
    };
  }

  #startCodexController(
    session: SessionRecord,
    prompt: string,
    images: readonly string[],
    runtimeWorkspace: ReturnType<typeof buildRuntimeWorkspaceContext>,
    onEvent: (event: CodexNormalizedEvent) => void
  ): CodexRunController {
    return startCodexRun({
      executablePath: this.#codexExecutablePath,
      prompt,
      images,
      resumeThreadId: session.codexThreadId,
      rollingSummary: session.rollingSummary,
      ...(this.#codexEnvironment
        ? { environment: this.#codexEnvironment }
        : {}),
      runtimeContext: this.#buildCodexRuntimeContext(runtimeWorkspace),
      onEvent
    });
  }

  #ensurePersistedRoutingSessionSnapshot(
    sessionId: string
  ): SessionActorSnapshot | null {
    const existingSnapshot = this.#routing.getSessionSnapshot(sessionId);
    if (existingSnapshot) {
      return existingSnapshot;
    }

    const persistedSession = this.#store.sessions.get(sessionId);
    return persistedSession
      ? this.#routing.registerSession(
          sessionId,
          buildPersistedSessionActorSnapshot(this.#store, persistedSession)
        )
      : null;
  }

  async #validateSessionForRun(session: SessionRecord): Promise<string | null> {
    const validation = await validateWorkspaceSession(
      toWorkspaceSessionState(session),
      {
        inspector: this.#filesystemInspector,
        ...(this.#visiblePolicy ? { visiblePolicy: this.#visiblePolicy } : {}),
        requireExistingPaths: true
      }
    );
    const blockingIssues = validation.issues.filter(
      (issue) => issue.code !== "path_not_normalized"
    );
    if (blockingIssues.length === 0) {
      return null;
    }

    return this.#formatIssuesMessage(
      session.sessionId,
      "session",
      "当前会话工作区已无效。",
      "The current session workspace is no longer valid.",
      blockingIssues
    );
  }

  async #downloadInboundImage(
    input: ImageUserInput
  ): Promise<{ readonly tempFilePath: string }> {
    await mkdir(this.#config.paths.tempDir, { recursive: true });
    const telegramFile = await this.#telegramClient.getFile(
      input.telegramFileId
    );
    if (!telegramFile.file_path) {
      throw new Error(
        `Telegram file path is missing for ${input.telegramFileId}.`
      );
    }

    const fileSize = telegramFile.file_size ?? 0;
    if (fileSize > DEFAULT_MEDIA_FILE_SIZE_CAP_BYTES) {
      throw new Error(
        `Telegram media exceeds the configured size cap (${fileSize} > ${DEFAULT_MEDIA_FILE_SIZE_CAP_BYTES}).`
      );
    }

    const extension = resolveTempExtension(
      input.mimeType ?? "image/jpeg",
      telegramFile.file_path
    );
    const tempFilePath = join(
      this.#config.paths.tempDir,
      `telegram-media-${randomUUID()}${extension}`
    );
    const fileContents = await this.#telegramClient.downloadFile(
      telegramFile.file_path
    );
    await writeFile(tempFilePath, fileContents);

    return {
      tempFilePath
    };
  }

  #syncSessionSnapshot(
    sessionId: string,
    snapshot: SessionActorSnapshot,
    patch: Omit<SessionPatch, "runState" | "activeRunId"> = {}
  ): void {
    if (!this.#store.sessions.get(sessionId)) {
      return;
    }

    this.#store.sessions.update(sessionId, {
      runState: snapshot.runState,
      activeRunId: snapshot.currentRunId,
      cancellationResult: snapshot.cancellationResult,
      ...patch
    });
  }

  async #requestRunCancellation(sessionId: string): Promise<void> {
    const activeRun = this.#activeRuns.get(sessionId);
    if (!activeRun || activeRun.cancelOutcome) {
      return;
    }

    if (!activeRun.controller) {
      if (activeRun.lifecycle === "awaiting_approval") {
        await this.#finalizeAwaitingApprovalRun(
          activeRun,
          "expired",
          this.#tChat(
            activeRun.chatId,
            "运行在等待审批时已取消。",
            "Run cancelled while waiting for approval."
          )
        );
      }
      return;
    }

    try {
      activeRun.cancelOutcome = await activeRun.controller.cancel();
    } catch (error) {
      this.#logger.warn("Run cancellation failed.", { error });
    }
  }

  #isDangerousCommand(command: NormalizedCommandRequest["command"]): boolean {
    return ACTIVE_COMMANDS.has(command);
  }
}

function createSessionRunKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

function createAddDirConfirmationKey(
  chatId: string,
  userId: string,
  sessionId: string,
  path: string
): string {
  return `${chatId}\u0000${userId}\u0000${sessionId}\u0000${path.trim()}`;
}

function inferCancelOutcome(
  snapshot: SessionActorSnapshot,
  result: CodexRunResult,
  requestedAt: string
): CodexCancelOutcome | null {
  if (snapshot.runState !== "cancelling") {
    return null;
  }

  return {
    requestedAt,
    result:
      result.exitCode === null
        ? "partial"
        : result.exitCode === 0
          ? "full"
          : "unknown",
    exited: result.exitCode !== null
  };
}

function buildPromptFromInput(
  input: Extract<NormalizedInboundMessage, { readonly type: "user_input" }>
): string {
  if (input.contentType === "text") {
    return input.text;
  }

  const caption = input.caption?.trim();
  return caption && caption !== ""
    ? ["The user attached an image.", `Caption: ${caption}`].join("\n")
    : "The user attached an image. Inspect it and help with the request.";
}

function buildApprovalResumePrompt(summary: string): string {
  return [
    "The user approved the pending execution request.",
    `Approved request: ${summary}`,
    "Continue the interrupted task from the current thread state."
  ].join("\n");
}

function extractCommandArgs(
  command: NormalizedCommandRequest
): readonly string[] {
  switch (command.command) {
    case "bind":
      return [command.targetSessionId];
    case "new":
      return command.requestedCwd ? [command.requestedCwd] : [];
    case "cwd":
    case "adddir":
      return [command.path];
    case "mode":
      return [command.mode];
    case "status":
    case "help":
    case "stop":
    case "sessions":
    case "start":
    case "perm":
    case "prune":
    case "reasoning":
    case "scope":
      return command.args ?? [];
  }
}

function extractSessionId(result: CommandExecutionResult): string | null {
  if (result.session && "sessionId" in result.session) {
    return String(result.session.sessionId);
  }

  if (
    result.data &&
    typeof result.data === "object" &&
    "sessionId" in result.data
  ) {
    return String((result.data as { readonly sessionId: string }).sessionId);
  }

  return null;
}

function renderCommandResult(
  command: NormalizedCommandRequest,
  result: CommandExecutionResult
): string {
  const lines = [result.message];
  if (result.issues && result.issues.length > 0) {
    lines.push(
      ...result.issues.map((issue) => `- ${issue.field}: ${issue.message}`)
    );
  }

  if (
    command.command === "adddir" &&
    result.status === "confirmation_required"
  ) {
    lines.push("Repeat the same /adddir command within 2 minutes to confirm.");
  }

  return lines.join("\n");
}

function formatInboundEventMetric(
  envelope: TelegramInboundEnvelope,
  includeRuntimeIdentifiers: boolean
): string {
  return includeRuntimeIdentifiers
    ? `${envelope.inboundMessage.type}:${envelope.chatId}`
    : envelope.inboundMessage.type;
}

function formatCodexEventMetric(
  event: CodexNormalizedEvent,
  sessionId: string,
  includeRuntimeIdentifiers: boolean
): string {
  return includeRuntimeIdentifiers ? `${event.kind}:${sessionId}` : event.kind;
}

function buildUserCommandAuditPayload(
  command: NormalizedCommandRequest,
  auditLevel: AppConfig["defaults"]["auditLevel"]
): {
  readonly command: string;
  readonly args?: readonly string[];
} {
  const args = extractCommandArgs(command);
  return auditLevel === "debug" && args.length > 0
    ? {
        command: command.command,
        args
      }
    : {
        command: command.command
      };
}

function buildUserInputAuditPayload(
  input: Extract<NormalizedInboundMessage, { readonly type: "user_input" }>
): {
  readonly contentType: "text" | "image";
  readonly messageLength: number;
  readonly viaDocument?: boolean;
  readonly hasCaption?: boolean;
} {
  return input.contentType === "text"
    ? {
        contentType: "text",
        messageLength: input.text.length
      }
    : {
        contentType: "image",
        messageLength: input.caption?.length ?? 0,
        viaDocument: input.viaDocument,
        hasCaption: Boolean(input.caption?.trim())
      };
}

function buildAgentTextAuditPayload(text: string): {
  readonly messageLength: number;
} {
  return {
    messageLength: text.length
  };
}

function buildStoredApprovalSummary(
  toolName: string,
  summary: string,
  auditLevel: AppConfig["defaults"]["auditLevel"]
): string {
  return auditLevel === "debug" ? summary : `${toolName} approval request`;
}

function buildFileChangeAuditPayload(
  changeType: "cwd" | "adddir" | "workspace_root",
  auditLevel: AppConfig["defaults"]["auditLevel"],
  nextPath: string
): {
  readonly changeType: "cwd" | "adddir" | "workspace_root";
  readonly nextPath?: string;
} {
  return auditLevel === "debug" ? { changeType, nextPath } : { changeType };
}

function buildResumeRecoveryAuditPayload(
  previousThreadId: string | null,
  nextThreadId: string | null,
  usedSummarySeed: boolean,
  auditLevel: AppConfig["defaults"]["auditLevel"]
): {
  readonly previousThreadId?: string | null;
  readonly nextThreadId?: string | null;
  readonly usedSummarySeed: boolean;
  readonly reason: string;
} {
  return {
    ...(auditLevel === "debug"
      ? {
          previousThreadId,
          nextThreadId
        }
      : {}),
    usedSummarySeed,
    reason: "stale_thread_resume_mismatch"
  };
}

function buildShellExecAuditPayload(
  command: readonly string[],
  exitCode: number | null,
  auditLevel: AppConfig["defaults"]["auditLevel"]
): {
  readonly commandPreview?: string;
  readonly commandWordCount: number;
  readonly exitCode: number | null;
} {
  return {
    ...(auditLevel === "debug" ? { commandPreview: command.join(" ") } : {}),
    commandWordCount: command.length,
    exitCode
  };
}

function buildToolStartAuditPayload(
  toolName: string,
  summary: string,
  auditLevel: AppConfig["defaults"]["auditLevel"]
): {
  readonly toolName: string;
  readonly summary?: string;
} {
  return auditLevel === "debug"
    ? {
        toolName,
        summary
      }
    : {
        toolName
      };
}

function buildToolResultDetail(
  detail: string,
  auditLevel: AppConfig["defaults"]["auditLevel"]
): {
  readonly detail?: string;
} {
  return auditLevel === "debug"
    ? {
        detail: detail.slice(0, 500)
      }
    : {};
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function resolveTempExtension(mimeType: string, filePath: string): string {
  const byPath = extname(filePath).trim();
  if (byPath !== "") {
    return byPath;
  }

  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
    default:
      return ".jpg";
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return String(error);
}

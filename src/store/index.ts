import type { AppConfig } from "../config/index.js";
import { BridgeDatabase, getDefaultDatabaseFilePath, openBridgeDatabase } from "./database.js";
import { applyMigrations } from "./migrations.js";
import {
  SqliteAuditLogsRepository,
  SqliteChannelOffsetsRepository,
  SqliteChatBindingsRepository,
  SqliteMigrationRepository,
  SqlitePendingPermissionsRepository,
  SqliteSessionSummariesRepository,
  SqliteSessionsRepository,
  type StoreClock
} from "./repositories.js";
import type { BridgeStore, CleanupPolicy, CleanupResult } from "./types.js";

export * from "./database.js";
export * from "./migrations.js";
export * from "./types.js";

export interface CreateBridgeStoreOptions {
  readonly config?: Pick<AppConfig, "paths">;
  readonly databaseFilePath?: string;
  readonly migrationsDirectory?: string | URL;
  readonly clock?: StoreClock;
}

export async function createBridgeStore(options: CreateBridgeStoreOptions = {}): Promise<BridgeStore> {
  const databaseFilePath = resolveDatabaseFilePath(options);
  const database = openBridgeDatabase({
    filePath: databaseFilePath,
    createDirectory: true
  });

  try {
    const migrationOptions = {
      ...(options.migrationsDirectory ? { migrationsDirectory: options.migrationsDirectory } : {}),
      ...(options.clock ? { clock: options.clock } : {})
    };

    await applyMigrations(database, migrationOptions);
    return new SqliteBridgeStore(database, options.clock ?? (() => new Date()));
  } catch (error) {
    database.close();
    throw error;
  }
}

class SqliteBridgeStore implements BridgeStore {
  readonly databaseFilePath: string;
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;
  readonly sessions;
  readonly chatBindings;
  readonly pendingPermissions;
  readonly channelOffsets;
  readonly auditLogs;
  readonly sessionSummaries;
  readonly migrations;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
    this.databaseFilePath = database.filePath;
    this.sessions = new SqliteSessionsRepository(database, clock);
    this.chatBindings = new SqliteChatBindingsRepository(database, clock);
    this.pendingPermissions = new SqlitePendingPermissionsRepository(database, clock);
    this.channelOffsets = new SqliteChannelOffsetsRepository(database, clock);
    this.auditLogs = new SqliteAuditLogsRepository(database, clock);
    this.sessionSummaries = new SqliteSessionSummariesRepository(database, clock);
    this.migrations = new SqliteMigrationRepository(database);
  }

  withTransaction<T>(callback: (store: BridgeStore) => T): T {
    return this.#database.withTransaction(() => callback(this));
  }

  runCleanup(policy: CleanupPolicy): CleanupResult {
    const deletedExpiredPermissions = policy.approvalExpiryOlderThan
      ? this.pendingPermissions.deleteExpired(toIsoTimestamp(policy.approvalExpiryOlderThan))
      : 0;
    const deletedResolvedPermissions = policy.approvalResolutionOlderThan
      ? this.pendingPermissions.deleteResolved(toIsoTimestamp(policy.approvalResolutionOlderThan))
      : 0;
    const deletedSummaryRows =
      typeof policy.maxSummariesPerSession === "number"
        ? this.sessionSummaries.pruneToMaxPerSession(policy.maxSummariesPerSession)
        : 0;

    let deletedAuditRows = 0;
    if (policy.auditRowsOlderThan) {
      deletedAuditRows += this.auditLogs.pruneOlderThan(toIsoTimestamp(policy.auditRowsOlderThan));
    }
    if (typeof policy.maxAuditRows === "number") {
      deletedAuditRows += this.auditLogs.pruneToMaxRows(policy.maxAuditRows);
    }

    return {
      deletedExpiredPermissions,
      deletedResolvedPermissions,
      deletedSummaryRows,
      deletedAuditRows
    };
  }

  close(): void {
    this.#database.close();
  }

  get clock(): StoreClock {
    return this.#clock;
  }
}

function resolveDatabaseFilePath(options: CreateBridgeStoreOptions): string {
  if (typeof options.databaseFilePath === "string" && options.databaseFilePath.trim() !== "") {
    return options.databaseFilePath;
  }

  if (options.config) {
    return getDefaultDatabaseFilePath(options.config);
  }

  throw new Error("createBridgeStore requires either a config or an explicit databaseFilePath.");
}

function toIsoTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

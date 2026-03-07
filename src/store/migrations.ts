import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BridgeDatabase } from "./database.js";
import type { AppliedMigrationRecord } from "./types.js";

export interface MigrationDefinition {
  readonly migrationId: string;
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface ApplyMigrationsOptions {
  readonly migrationsDirectory?: string | URL;
  readonly clock?: () => Date;
}

export interface ApplyMigrationsResult {
  readonly applied: readonly AppliedMigrationRecord[];
  readonly skipped: readonly AppliedMigrationRecord[];
  readonly discovered: number;
}

const MIGRATION_FILENAME_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/i;

export async function loadMigrationDefinitions(
  migrationsDirectory?: string | URL
): Promise<readonly MigrationDefinition[]> {
  const directoryPath = resolveMigrationsDirectory(migrationsDirectory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const definitions: MigrationDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(MIGRATION_FILENAME_PATTERN);
    if (!match) {
      continue;
    }

    const [, versionText, migrationName] = match;
    if (!versionText || !migrationName) {
      continue;
    }

    const version = Number.parseInt(versionText, 10);
    const sql = await readFile(`${directoryPath}/${entry.name}`, "utf8");

    definitions.push({
      migrationId: `${versionText}_${migrationName}`,
      version,
      name: migrationName,
      filename: entry.name,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql
    });
  }

  definitions.sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));
  return definitions;
}

export async function applyMigrations(
  database: BridgeDatabase,
  options: ApplyMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  ensureMigrationsTable(database);

  const definitions = await loadMigrationDefinitions(options.migrationsDirectory);
  const appliedRecords = new Map(
    listAppliedMigrations(database).map((record) => [record.migrationId, record] as const)
  );

  const applied: AppliedMigrationRecord[] = [];
  const skipped: AppliedMigrationRecord[] = [];
  const now = options.clock ?? (() => new Date());

  for (const definition of definitions) {
    const existing = appliedRecords.get(definition.migrationId);
    if (existing) {
      if (existing.checksum !== definition.checksum) {
        throw new Error(
          `Applied migration checksum mismatch for ${definition.migrationId}: expected ${existing.checksum}, got ${definition.checksum}.`
        );
      }

      skipped.push(existing);
      continue;
    }

    const record: AppliedMigrationRecord = {
      migrationId: definition.migrationId,
      version: definition.version,
      name: definition.name,
      checksum: definition.checksum,
      appliedAt: now().toISOString()
    };

    database.withTransaction(() => {
      database.exec(definition.sql);
      database.prepare(
        `INSERT INTO migrations (migration_id, version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        record.migrationId,
        record.version,
        record.name,
        record.checksum,
        record.appliedAt
      );
    });

    applied.push(record);
  }

  return {
    applied,
    skipped,
    discovered: definitions.length
  };
}

export function listAppliedMigrations(database: BridgeDatabase): readonly AppliedMigrationRecord[] {
  ensureMigrationsTable(database);
  const rows = database.prepare(
    `SELECT migration_id, version, name, checksum, applied_at
     FROM migrations
     ORDER BY version ASC, migration_id ASC`
  ).all() as ReadonlyArray<Record<string, unknown>>;

  return rows.map((row) => ({
    migrationId: toStringValue(row.migration_id),
    version: toNumberValue(row.version),
    name: toStringValue(row.name),
    checksum: toStringValue(row.checksum),
    appliedAt: toStringValue(row.applied_at)
  }));
}

function ensureMigrationsTable(database: BridgeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      migration_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function resolveMigrationsDirectory(migrationsDirectory?: string | URL): string {
  if (migrationsDirectory instanceof URL) {
    return fileURLToPath(migrationsDirectory);
  }

  if (typeof migrationsDirectory === "string" && migrationsDirectory.trim() !== "") {
    return migrationsDirectory;
  }

  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

function toStringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string SQLite value, received ${typeof value}.`);
  }

  return value;
}

function toNumberValue(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error(`Expected numeric SQLite value, received ${typeof value}.`);
  }

  return value;
}

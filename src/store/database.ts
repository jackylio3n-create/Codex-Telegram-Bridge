import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config/index.js";

export interface OpenBridgeDatabaseOptions {
  readonly filePath: string;
  readonly createDirectory?: boolean;
}

export class BridgeDatabase {
  readonly connection: DatabaseSync;
  readonly filePath: string;
  #transactionDepth = 0;

  constructor(connection: DatabaseSync, filePath: string) {
    this.connection = connection;
    this.filePath = filePath;
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  prepare(sql: string) {
    return this.connection.prepare(sql);
  }

  withTransaction<T>(callback: () => T): T {
    const savepointName = `bridge_store_tx_${this.#transactionDepth + 1}`;
    if (this.#transactionDepth === 0) {
      this.connection.exec("BEGIN IMMEDIATE");
    } else {
      this.connection.exec(`SAVEPOINT ${savepointName}`);
    }

    this.#transactionDepth += 1;

    try {
      const result = callback();
      this.#transactionDepth -= 1;

      if (this.#transactionDepth === 0) {
        this.connection.exec("COMMIT");
      } else {
        this.connection.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }

      return result;
    } catch (error) {
      this.#transactionDepth -= 1;

      if (this.#transactionDepth === 0) {
        this.connection.exec("ROLLBACK");
      } else {
        this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        this.connection.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }

      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}

export function getDefaultDatabaseFilePath(
  config: Pick<AppConfig, "paths">
): string {
  return join(config.paths.dataDir, "bridge.sqlite3");
}

export function openBridgeDatabase(
  options: OpenBridgeDatabaseOptions
): BridgeDatabase {
  if (options.createDirectory ?? true) {
    mkdirSync(dirname(options.filePath), { recursive: true });
  }

  const connection = new DatabaseSync(options.filePath);
  connection.exec("PRAGMA foreign_keys = ON;");
  connection.exec("PRAGMA busy_timeout = 5000;");
  connection.exec("PRAGMA journal_mode = WAL;");
  connection.exec("PRAGMA synchronous = NORMAL;");

  return new BridgeDatabase(connection, options.filePath);
}

import type { BridgeDatabase } from "./database.js";
import { listAppliedMigrations } from "./migrations.js";
import type { AppliedMigrationRecord, MigrationRepository } from "./types.js";

export class SqliteMigrationRepository implements MigrationRepository {
  readonly #database: BridgeDatabase;

  constructor(database: BridgeDatabase) {
    this.#database = database;
  }

  list(): readonly AppliedMigrationRecord[] {
    return listAppliedMigrations(this.#database);
  }
}

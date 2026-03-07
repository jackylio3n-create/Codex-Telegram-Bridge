import type { BridgeStore } from "../../store/types.js";
import type { DoctorCheck } from "../types.js";

const WRITABILITY_PROBE_CHANNEL_KEY = "__doctor_writability_probe__";

export function buildStorageCheck(
  store: BridgeStore | undefined,
  storeError: string | undefined
): DoctorCheck {
  if (storeError) {
    return {
      id: "storage",
      label: "storage",
      status: "error",
      summary: "SQLite store could not be opened.",
      details: [storeError]
    };
  }

  if (!store) {
    return {
      id: "storage",
      label: "storage",
      status: "skipped",
      summary: "Skipped because the store was not initialized.",
      details: []
    };
  }

  const migrations = store.migrations.list();

  verifyDatabaseWritePath(store);

  return {
    id: "storage",
    label: "storage",
    status: "ok",
    summary: `SQLite store is readable and writable at ${store.databaseFilePath}.`,
    details: [`Applied migrations: ${migrations.length}.`]
  };
}

function verifyDatabaseWritePath(store: BridgeStore): void {
  try {
    store.withTransaction((transactionalStore) => {
      transactionalStore.channelOffsets.save({
        channelKey: WRITABILITY_PROBE_CHANNEL_KEY,
        currentOffset: 0,
        previousOffset: 0
      });
      throw new RollbackSentinel();
    });
  } catch (error) {
    if (error instanceof RollbackSentinel) {
      return;
    }

    throw error;
  }
}

class RollbackSentinel extends Error {}

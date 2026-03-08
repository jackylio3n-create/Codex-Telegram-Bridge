import type {
  SessionActorDispatchResult,
  SessionActorSnapshot,
  SessionEvent
} from "../types/index.js";
import {
  createInitialSessionSnapshot,
  isSessionStateActiveForCommandGate,
  reduceSessionEvent
} from "./state-machine.js";

export class SessionActor {
  private snapshot: SessionActorSnapshot;
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    sessionId: string,
    initialSnapshot?: SessionActorSnapshot
  ) {
    const snapshot = initialSnapshot ?? createInitialSessionSnapshot(sessionId);
    if (snapshot.sessionId !== sessionId) {
      throw new Error(
        `SessionActor snapshot session mismatch: expected ${sessionId}, got ${snapshot.sessionId}.`
      );
    }

    this.snapshot = { ...snapshot };
  }

  public getSnapshot(): SessionActorSnapshot {
    return { ...this.snapshot };
  }

  public isActiveForCommandGate(): boolean {
    return isSessionStateActiveForCommandGate(this.snapshot.runState);
  }

  public enqueue(event: SessionEvent): Promise<SessionActorDispatchResult> {
    this.snapshot = {
      ...this.snapshot,
      queuedEventCount: this.snapshot.queuedEventCount + 1
    };

    const execution = this.tail.then(() => {
      const currentSnapshot = this.snapshot;

      try {
        const result = reduceSessionEvent(currentSnapshot, event);
        this.snapshot = {
          ...result.snapshot,
          queuedEventCount: Math.max(currentSnapshot.queuedEventCount - 1, 0)
        };
        return {
          ...result,
          snapshot: this.getSnapshot()
        };
      } catch (error) {
        this.snapshot = {
          ...currentSnapshot,
          queuedEventCount: Math.max(currentSnapshot.queuedEventCount - 1, 0)
        };
        throw error;
      }
    });

    this.tail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }
}

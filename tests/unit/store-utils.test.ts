import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuditLogEventLimits } from "../../src/store/audit-limits.js";
import {
  integerToBoolean,
  parseJson,
  parseStringArray,
  toNumberValue
} from "../../src/store/sqlite-values.js";

test("normalizeAuditLogEventLimits deduplicates by event type and drops non-positive limits", () => {
  const normalized = normalizeAuditLogEventLimits([
    { eventType: "user_command", limit: 2 },
    { eventType: "approval_decision", limit: 0 },
    { eventType: "user_command", limit: 5 },
    { eventType: "agent_text", limit: -1 },
    { eventType: "tool_result", limit: 1 }
  ]);

  assert.deepEqual(normalized, [
    { eventType: "user_command", limit: 5 },
    { eventType: "tool_result", limit: 1 }
  ]);
});

test("parseStringArray returns validated string arrays", () => {
  assert.deepEqual(parseStringArray('["/workspace","/tmp"]'), [
    "/workspace",
    "/tmp"
  ]);
  assert.throws(
    () => parseStringArray('["/workspace",1]'),
    /Expected JSON string array/
  );
});

test("parseJson preserves null semantics for SQLite payload columns", () => {
  assert.equal(parseJson(null), null);
  assert.deepEqual(parseJson('{"ok":true,"count":2}'), { ok: true, count: 2 });
});

test("numeric SQLite helpers support bigint and integer booleans", () => {
  assert.equal(toNumberValue(42n), 42);
  assert.equal(integerToBoolean(1), true);
  assert.equal(integerToBoolean(0), false);
});

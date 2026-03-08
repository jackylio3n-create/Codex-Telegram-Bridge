import type { BridgeStore } from "../../store/types.js";
import type { DoctorCheck } from "../types.js";

export function buildOffsetsCheck(
  store: BridgeStore | undefined,
  offsetChannelKey: string,
  suspiciousJumpThreshold: number
): DoctorCheck {
  if (!store) {
    return {
      id: "offsets",
      label: "telegram offsets",
      status: "skipped",
      summary: "Skipped because the store was not initialized.",
      details: []
    };
  }

  const row = store.channelOffsets.get(offsetChannelKey);
  if (!row) {
    return {
      id: "offsets",
      label: "telegram offsets",
      status: "error",
      summary: `Offset row ${offsetChannelKey} is missing.`,
      details: []
    };
  }

  const details: string[] = [`Updated at: ${row.updatedAt}.`];

  if (row.currentOffset < 0 || row.previousOffset < 0) {
    details.push(
      `current_offset=${row.currentOffset}, previous_offset=${row.previousOffset}`
    );
    return {
      id: "offsets",
      label: "telegram offsets",
      status: "error",
      summary: "Offset values must be non-negative.",
      details
    };
  }

  if (row.currentOffset < row.previousOffset) {
    details.push(
      `current_offset=${row.currentOffset}, previous_offset=${row.previousOffset}`
    );
    return {
      id: "offsets",
      label: "telegram offsets",
      status: "error",
      summary: "current_offset is behind previous_offset.",
      details
    };
  }

  const jump = row.currentOffset - row.previousOffset;
  details.push(
    `current_offset=${row.currentOffset}, previous_offset=${row.previousOffset}, jump=${jump}`
  );

  if (jump > suspiciousJumpThreshold) {
    details.push(`Threshold: ${suspiciousJumpThreshold}.`);
    return {
      id: "offsets",
      label: "telegram offsets",
      status: "warning",
      summary: "Suspicious offset jump detected.",
      details
    };
  }

  return {
    id: "offsets",
    label: "telegram offsets",
    status: "ok",
    summary: "Offset row is present and internally consistent.",
    details
  };
}

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

// SPC-6121: Exponential backoff for repeated `process_lost` failures on the
// same issue. The 11-second flat retry cadence amplified a 48-minute
// host-unavailable event into 433 wasted retries during the 2026-05-24 storm
// (see SPC-6112 post-mortem). After 5 consecutive process_lost runs within a
// 5-minute window, switch to exponential delay between retries.
export const PROCESS_LOST_BACKOFF_THRESHOLD = 5;
export const PROCESS_LOST_BACKOFF_WINDOW_MS = 5 * 60 * 1000;
export const PROCESS_LOST_BACKOFF_DELAYS_MS = [
  30_000,
  60_000,
  120_000,
  300_000,
] as const;
export const PROCESS_LOST_BACKOFF_RETRY_REASON = "process_lost_backoff";
export const PROCESS_LOST_BACKOFF_WAKE_REASON = "process_lost_backoff_retry";

const TERMINAL_RUN_STATUSES = ["failed", "succeeded", "cancelled", "timed_out"] as const;

export function deriveProcessLostBackoffDelayMs(consecutiveCount: number): number {
  if (consecutiveCount < PROCESS_LOST_BACKOFF_THRESHOLD) return 0;
  const stepIndex = Math.min(
    consecutiveCount - PROCESS_LOST_BACKOFF_THRESHOLD,
    PROCESS_LOST_BACKOFF_DELAYS_MS.length - 1,
  );
  return PROCESS_LOST_BACKOFF_DELAYS_MS[stepIndex];
}

export type ProcessLostBackoffDecision = {
  consecutiveCount: number;
  lastFinishedAt: Date | null;
  requiredDelayMs: number;
  remainingDelayMs: number;
};

export async function computeProcessLostBackoffDecision(
  db: Db,
  input: { companyId: string; issueId: string; now: Date; lookback?: number },
): Promise<ProcessLostBackoffDecision> {
  const lookback = Math.max(input.lookback ?? 20, PROCESS_LOST_BACKOFF_THRESHOLD + 5);
  const rows = await db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt))
    .limit(lookback);

  let consecutiveCount = 0;
  let newestFinishedAt: Date | null = null;
  let windowAnchorAt: Date | null = null;

  for (const row of rows) {
    if (row.status !== "failed" || row.errorCode !== "process_lost") break;
    const finishedAt = row.finishedAt
      ? row.finishedAt instanceof Date
        ? row.finishedAt
        : new Date(row.finishedAt)
      : null;
    if (!finishedAt || Number.isNaN(finishedAt.getTime())) break;
    if (!windowAnchorAt) {
      windowAnchorAt = finishedAt;
      newestFinishedAt = finishedAt;
    }
    if (windowAnchorAt.getTime() - finishedAt.getTime() > PROCESS_LOST_BACKOFF_WINDOW_MS) {
      break;
    }
    consecutiveCount += 1;
  }

  const requiredDelayMs = deriveProcessLostBackoffDelayMs(consecutiveCount);
  if (requiredDelayMs === 0 || !newestFinishedAt) {
    return {
      consecutiveCount,
      lastFinishedAt: newestFinishedAt,
      requiredDelayMs,
      remainingDelayMs: 0,
    };
  }
  const elapsedMs = Math.max(0, input.now.getTime() - newestFinishedAt.getTime());
  const remainingDelayMs = Math.max(0, requiredDelayMs - elapsedMs);
  return {
    consecutiveCount,
    lastFinishedAt: newestFinishedAt,
    requiredDelayMs,
    remainingDelayMs,
  };
}

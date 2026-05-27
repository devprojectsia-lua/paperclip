/**
 * Observability pipeline for weak-infra process-loss accumulation.
 *
 * Detects when a single agentId accumulates ≥ WEAK_INFRA_THRESHOLD runs with
 * processLossCauseClass='infrastructure' AND processLossClassifyConfidence='weak'
 * inside a rolling WEAK_INFRA_WINDOW_HOURS window, then creates an alert issue
 * assigned to the first available CTO/CEO agent so they are woken and notified.
 *
 * The check is idempotent: a per-agent in-memory timestamp tracks the last alert
 * so the same agent is not re-alerted within a cooldown equal to the detection
 * window (resets to zero on server restart — acceptable, it just causes one
 * extra alert per restart at most).
 */

import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

// ---------------------------------------------------------------------------
// Constants — adjustable without touching call sites
// ---------------------------------------------------------------------------

/** Number of weak-infra failures that trigger the alert. */
export const WEAK_INFRA_THRESHOLD = 3;

/** Rolling window (hours) in which failures are counted. */
export const WEAK_INFRA_WINDOW_HOURS = 24;

/** After an alert fires, do not re-alert for the same agent for this many ms. */
const ALERT_COOLDOWN_MS = WEAK_INFRA_WINDOW_HOURS * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory dedup state (per process)
// ---------------------------------------------------------------------------

/** agentId → timestamp of last alert emitted */
const lastAlertSentAt = new Map<string, number>();

function isInCooldown(agentId: string, now: number): boolean {
  const last = lastAlertSentAt.get(agentId);
  return last !== undefined && now - last < ALERT_COOLDOWN_MS;
}

function markAlertSent(agentId: string, now: number): void {
  lastAlertSentAt.set(agentId, now);
}

// Exported for tests only.
export function _resetAlertState(): void {
  lastAlertSentAt.clear();
}

// ---------------------------------------------------------------------------
// Core service
// ---------------------------------------------------------------------------

export interface WeakInfraMonitorDeps {
  db: Db;
  now?: Date;
}

export interface WeakInfraCheckResult {
  /** agentIds that triggered the threshold and had alerts created. */
  alerted: string[];
  /** agentIds that triggered the threshold but were suppressed by cooldown. */
  suppressed: string[];
}

/**
 * Scan the recent heartbeat_runs table and emit alert issues for any agent that
 * has accumulated ≥ WEAK_INFRA_THRESHOLD weak-infra failures in the last
 * WEAK_INFRA_WINDOW_HOURS hours.
 *
 * Designed to be called from the periodic server tick (e.g. every minute via
 * the heartbeat scheduler interval).
 */
export async function checkWeakInfraAccumulation(
  deps: WeakInfraMonitorDeps,
): Promise<WeakInfraCheckResult> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - WEAK_INFRA_WINDOW_HOURS * 60 * 60 * 1000);

  // -------------------------------------------------------------------------
  // Step 1: find agents that crossed the threshold in the rolling window
  // -------------------------------------------------------------------------
  const rows = await db
    .select({
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      weakCount: count(heartbeatRuns.id),
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "failed"),
        eq(heartbeatRuns.processLossCauseClass, "infrastructure"),
        eq(heartbeatRuns.processLossClassifyConfidence, "weak"),
        gte(heartbeatRuns.finishedAt, windowStart),
      ),
    )
    .groupBy(heartbeatRuns.agentId, heartbeatRuns.companyId)
    .having(sql`count(${heartbeatRuns.id}) >= ${WEAK_INFRA_THRESHOLD}`);

  if (rows.length === 0) {
    return { alerted: [], suppressed: [] };
  }

  const alerted: string[] = [];
  const suppressed: string[] = [];
  const nowMs = now.getTime();

  for (const row of rows) {
    const { agentId, companyId, weakCount } = row;

    if (isInCooldown(agentId, nowMs)) {
      suppressed.push(agentId);
      continue;
    }

    try {
      await emitWeakInfraAlert({ db, agentId, companyId, weakCount: Number(weakCount), windowHours: WEAK_INFRA_WINDOW_HOURS, now });
      markAlertSent(agentId, nowMs);
      alerted.push(agentId);
    } catch (err) {
      logger.error({ err, agentId, companyId }, "weak-infra alert emission failed");
    }
  }

  if (alerted.length > 0) {
    logger.warn(
      { alerted, suppressed, threshold: WEAK_INFRA_THRESHOLD, windowHours: WEAK_INFRA_WINDOW_HOURS },
      "weak-infra accumulation alert(s) created",
    );
  }

  return { alerted, suppressed };
}

// ---------------------------------------------------------------------------
// Alert creation
// ---------------------------------------------------------------------------

async function getCompanyIssuePrefix(db: Db, companyId: string): Promise<string> {
  return db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]?.issuePrefix ?? "PAP");
}

async function findAlertRecipient(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const roleCandidates = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        inArray(agents.role, ["cto", "ceo"]),
        inArray(agents.status, ["idle", "pending_approval"]),
      ),
    )
    .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt))
    .limit(1);

  return roleCandidates[0]?.id ?? null;
}

async function getAgentInfo(
  db: Db,
  agentId: string,
): Promise<{ name: string } | null> {
  const row = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  return row;
}

async function findAgentActiveIssue(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ id: string; identifier: string | null; title: string } | null> {
  const row = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ["in_progress", "in_review", "todo", "blocked"]),
      ),
    )
    .orderBy(asc(issues.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row;
}

async function emitWeakInfraAlert(input: {
  db: Db;
  agentId: string;
  companyId: string;
  weakCount: number;
  windowHours: number;
  now: Date;
}): Promise<void> {
  const { db, agentId, companyId, weakCount, windowHours, now } = input;

  const [prefix, recipientId, agentInfo, activeIssue] = await Promise.all([
    getCompanyIssuePrefix(db, companyId),
    findAlertRecipient(db, companyId),
    getAgentInfo(db, agentId),
    findAgentActiveIssue(db, companyId, agentId),
  ]);

  const agentName = agentInfo?.name ?? agentId;

  const activeIssueNote = activeIssue?.identifier
    ? `- Active issue: [${activeIssue.identifier}](/${prefix}/issues/${activeIssue.identifier}) — ${activeIssue.title}`
    : "- No active issue found for this agent.";

  const body = [
    `## ⚠️ Weak-infra accumulation alert`,
    "",
    `Agent **${agentName}** (\`${agentId}\`) has accumulated **${weakCount}** \`classifyConfidence=weak\` / \`causeClass=infrastructure\` process-loss failures in the last ${windowHours}h, reaching the alert threshold (≥${WEAK_INFRA_THRESHOLD}).`,
    "",
    "### Details",
    "",
    `- Agent: **${agentName}** (\`${agentId}\`)`,
    `- Failures in window: **${weakCount}** (threshold: ${WEAK_INFRA_THRESHOLD})`,
    `- Detection window: last ${windowHours}h`,
    `- Detected at: ${now.toISOString()}`,
    activeIssueNote,
    "",
    "### What this means",
    "",
    "Repeated `weak` classifications indicate the infra-loss signal may be unreliable for this agent, which is the pattern associated with prompt-injection masking process failures as infrastructure events. Review recent runs for spoofing patterns.",
    "",
    "### Recommended actions",
    "",
    "1. Review the agent's recent heartbeat runs for suspicious patterns.",
    "2. If spoofing is confirmed, consider pausing the agent and escalating.",
    "3. If legitimate infra instability, investigate the underlying infra cause.",
  ].join("\n");

  const issuesSvc = issueService(db);

  if (activeIssue) {
    // Post a structured alert comment on the agent's active issue.
    await issuesSvc.addComment(activeIssue.id, body, {});
  }

  // Also create a dedicated alert issue assigned to CTO/CEO for explicit wakeup.
  await issuesSvc.create(companyId, {
    title: `[weak-infra alert] ${agentName} — ${weakCount} weak-infra failures in ${windowHours}h`,
    description: body,
    status: "todo",
    priority: "high",
    assigneeAgentId: recipientId ?? undefined,
    originKind: "weak_infra_alert",
    originId: agentId,
    originFingerprint: `weak_infra_alert:${companyId}:${agentId}:${Math.floor(now.getTime() / ALERT_COOLDOWN_MS)}`,
  });
}

/**
 * Observability pipeline for weak-infra process-loss accumulation.
 *
 * Detects when a single agentId accumulates ≥ WEAK_INFRA_THRESHOLD runs with
 * processLossCauseClass='infrastructure' AND processLossClassifyConfidence='weak'
 * inside a rolling WEAK_INFRA_WINDOW_HOURS window, then creates an alert issue
 * assigned to the first available CTO/CEO agent so they are woken and notified.
 *
 * F4: Cooldown is persisted in `agent_alert_state` (DB) so restarts do not reset it.
 * F5: Company-wide rate limit (MAX_ALERTS_PER_HOUR) collapses overflow into a digest.
 * F6: Alert recipient query uses an explicit status allowlist (idle/running/paused).
 */

import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentAlertState, agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WEAK_INFRA_THRESHOLD = 3;
export const WEAK_INFRA_WINDOW_HOURS = 24;

/** After an alert fires for an agent, do not re-alert for this many ms. */
const ALERT_COOLDOWN_MS = WEAK_INFRA_WINDOW_HOURS * 60 * 60 * 1000;

/** Maximum individual alerts per company per hour before switching to digest mode. */
export const MAX_ALERTS_PER_HOUR = 3;

/** Alert kind tag stored in agent_alert_state. */
const ALERT_KIND_WEAK_INFRA = "weak_infra";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WeakInfraMonitorDeps {
  db: Db;
  now?: Date;
  /** @internal — override the digest emitter in tests to simulate failures. */
  _emitDigest?: typeof emitWeakInfraDigest;
}

export interface WeakInfraCheckResult {
  /** agentIds that triggered the threshold and had alerts or digest entries created. */
  alerted: string[];
  /** agentIds that triggered the threshold but were suppressed by per-agent cooldown. */
  suppressed: string[];
}

// ---------------------------------------------------------------------------
// DB-persisted cooldown helpers (F4)
// ---------------------------------------------------------------------------

async function getLastAlertFiredAt(db: Db, agentId: string): Promise<Date | null> {
  const rows = await db
    .select({ lastFiredAt: agentAlertState.lastFiredAt })
    .from(agentAlertState)
    .where(
      and(
        eq(agentAlertState.agentId, agentId),
        eq(agentAlertState.alertKind, ALERT_KIND_WEAK_INFRA),
      ),
    )
    .limit(1);
  return rows[0]?.lastFiredAt ?? null;
}

async function upsertAlertFiredAt(db: Db, agentId: string, now: Date): Promise<void> {
  await db
    .insert(agentAlertState)
    .values({ agentId, alertKind: ALERT_KIND_WEAK_INFRA, lastFiredAt: now })
    .onConflictDoUpdate({
      target: [agentAlertState.agentId, agentAlertState.alertKind],
      set: { lastFiredAt: now },
    });
}

// ---------------------------------------------------------------------------
// Company-wide rate limit helpers (F5)
// ---------------------------------------------------------------------------

/**
 * Count how many distinct agents in the given company have fired a weak-infra
 * alert within the last hour.  Used to enforce MAX_ALERTS_PER_HOUR.
 */
async function countCompanyAlertsInLastHour(db: Db, companyId: string, now: Date): Promise<number> {
  const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
  const rows = await db
    .select({ n: count() })
    .from(agentAlertState)
    .innerJoin(agents, eq(agents.id, agentAlertState.agentId))
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agentAlertState.alertKind, ALERT_KIND_WEAK_INFRA),
        gte(agentAlertState.lastFiredAt, windowStart),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Exported reset helper — kept for test ergonomics (no-op in production)
// ---------------------------------------------------------------------------

/** No-op in production. Tests must clean up the agent_alert_state table directly. */
export function _resetAlertState(): void {
  // Cooldown is now persisted in DB; reset by deleting from agent_alert_state in tests.
}

// ---------------------------------------------------------------------------
// Core service
// ---------------------------------------------------------------------------

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
  const nowMs = now.getTime();

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

  // -------------------------------------------------------------------------
  // Step 2: group by company so the rate limit is applied per-company
  // -------------------------------------------------------------------------
  const byCompany = new Map<string, Array<{ agentId: string; weakCount: number }>>();
  for (const row of rows) {
    if (!byCompany.has(row.companyId)) byCompany.set(row.companyId, []);
    byCompany.get(row.companyId)!.push({ agentId: row.agentId, weakCount: Number(row.weakCount) });
  }

  const alerted: string[] = [];
  const suppressed: string[] = [];

  for (const [companyId, agentsAboveThreshold] of byCompany) {
    // F5: load the current hour's alert count for this company from DB
    let companyHourCount = await countCompanyAlertsInLastHour(db, companyId, now);

    const digestCandidates: Array<{ agentId: string; agentName: string; weakCount: number }> = [];

    for (const { agentId, weakCount } of agentsAboveThreshold) {
      // F4: check per-agent cooldown from DB (survives server restarts)
      const lastFiredAt = await getLastAlertFiredAt(db, agentId);
      if (lastFiredAt !== null && nowMs - lastFiredAt.getTime() < ALERT_COOLDOWN_MS) {
        suppressed.push(agentId);
        continue;
      }

      if (companyHourCount < MAX_ALERTS_PER_HOUR) {
        // Individual alert path — within quota
        try {
          await emitWeakInfraAlert({
            db,
            agentId,
            companyId,
            weakCount,
            windowHours: WEAK_INFRA_WINDOW_HOURS,
            now,
          });
          await upsertAlertFiredAt(db, agentId, now);
          companyHourCount++;
          alerted.push(agentId);
        } catch (err) {
          logger.error({ err, agentId, companyId }, "weak-infra alert emission failed");
        }
      } else {
        // F5: company quota exceeded — queue for digest
        const agentInfo = await getAgentInfo(db, agentId);
        digestCandidates.push({
          agentId,
          agentName: agentInfo?.name ?? agentId,
          weakCount,
        });
        // Cooldown stamp deferred until after emitWeakInfraDigest succeeds (GNO-252).
      }
    }

    // Emit a single digest issue for all over-quota agents in this company
    if (digestCandidates.length > 0) {
      try {
        await (deps._emitDigest ?? emitWeakInfraDigest)({
          db,
          companyId,
          digestAgents: digestCandidates,
          now,
        });
        for (const candidate of digestCandidates) {
          await upsertAlertFiredAt(db, candidate.agentId, now);
          alerted.push(candidate.agentId);
        }
      } catch (err) {
        logger.error(
          { err, companyId, digestCount: digestCandidates.length },
          "weak-infra digest emission failed",
        );
      }
    }
  }

  if (alerted.length > 0) {
    logger.warn(
      {
        alerted,
        suppressed,
        threshold: WEAK_INFRA_THRESHOLD,
        windowHours: WEAK_INFRA_WINDOW_HOURS,
      },
      "weak-infra accumulation alert(s) created",
    );
  }

  return { alerted, suppressed };
}

// ---------------------------------------------------------------------------
// Alert creation helpers
// ---------------------------------------------------------------------------

async function getCompanyIssuePrefix(db: Db, companyId: string): Promise<string> {
  return db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]?.issuePrefix ?? "PAP");
}

/**
 * Find a CTO or CEO agent to receive the alert issue.
 * F6: uses an explicit status allowlist — only idle/running/paused agents are
 * considered active recipients. Terminated/removed agents are never included.
 */
async function findAlertRecipient(db: Db, companyId: string): Promise<string | null> {
  const roleCandidates = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        inArray(agents.role, ["cto", "ceo"]),
        inArray(agents.status, ["idle", "running", "paused"]),
      ),
    )
    .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt))
    .limit(1);

  return roleCandidates[0]?.id ?? null;
}

async function getAgentInfo(db: Db, agentId: string): Promise<{ name: string } | null> {
  return db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
}

async function findAgentActiveIssue(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ id: string; identifier: string | null; title: string } | null> {
  return db
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
    await issuesSvc.addComment(activeIssue.id, body, {});
  }

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

/**
 * F5: Emit a single digest issue when the company-wide hourly rate limit is exceeded.
 * Instead of N individual alerts, one issue lists all affected agents.
 */
async function emitWeakInfraDigest(input: {
  db: Db;
  companyId: string;
  digestAgents: Array<{ agentId: string; agentName: string; weakCount: number }>;
  now: Date;
}): Promise<void> {
  const { db, companyId, digestAgents, now } = input;

  const [recipientId] = await Promise.all([findAlertRecipient(db, companyId)]);

  const agentRows = digestAgents
    .map((a) => `| **${a.agentName}** | \`${a.agentId}\` | ${a.weakCount} |`)
    .join("\n");

  const body = [
    `## ⚠️ Weak-infra digest (rate limit atingido)`,
    "",
    `O rate limit company-wide de **${MAX_ALERTS_PER_HOUR} alertas/hora** foi atingido.`,
    `Os seguintes ${digestAgents.length} agente(s) também cruzaram o threshold mas foram agregados neste digest:`,
    "",
    "| Agente | ID | Falhas na janela |",
    "|--------|-----|-----------------|",
    agentRows,
    "",
    "### Ação recomendada",
    "",
    "1. Revisar todos os agentes listados acima.",
    "2. Se houver evidência de spoofing coordenado, considerar pausar os agentes e escalar.",
    "3. Se for outage de infra real, verificar o provider e aguardar recuperação.",
    "",
    `*Digest gerado em ${now.toISOString()}*`,
  ].join("\n");

  const issuesSvc = issueService(db);
  await issuesSvc.create(companyId, {
    title: `[weak-infra digest] ${digestAgents.length} agente(s) — rate limit atingido`,
    description: body,
    status: "todo",
    priority: "high",
    assigneeAgentId: recipientId ?? undefined,
    originKind: "weak_infra_alert",
    originId: `digest:${companyId}`,
    // Fingerprint is per-hour so one digest per hour maximum per company.
    originFingerprint: `weak_infra_digest:${companyId}:${Math.floor(now.getTime() / (60 * 60 * 1000))}`,
  });
}

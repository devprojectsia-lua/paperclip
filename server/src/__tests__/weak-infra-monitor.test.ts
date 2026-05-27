import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentAlertState, companies, heartbeatRuns, issues, issueComments, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  checkWeakInfraAccumulation,
  WEAK_INFRA_THRESHOLD,
  WEAK_INFRA_WINDOW_HOURS,
  MAX_ALERTS_PER_HOUR,
  _resetAlertState,
} from "../services/weak-infra-monitor.js";

// ---------------------------------------------------------------------------
// Integration tests — detection logic against a real DB
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping weak-infra monitor integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("checkWeakInfraAccumulation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-weak-infra-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    _resetAlertState();
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentAlertState);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(overrides: { role?: string; status?: string } = {}) {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: overrides.role ?? "worker",
      status: overrides.status ?? "idle",
    });
  }

  async function insertWeakInfraRun(
    overrides: Partial<{
      agentId: string;
      finishedAt: Date;
      processLossCauseClass: string;
      processLossClassifyConfidence: string;
    }> = {},
  ) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: overrides.agentId ?? agentId,
      status: "failed",
      errorCode: "process_lost",
      processLossCauseClass: overrides.processLossCauseClass ?? "infrastructure",
      processLossClassifyConfidence: overrides.processLossClassifyConfidence ?? "weak",
      finishedAt: overrides.finishedAt ?? now,
    });
    return runId;
  }

  // -------------------------------------------------------------------------
  // Baseline detection tests (unchanged from pre-GNO-233)
  // -------------------------------------------------------------------------

  it("returns empty alerted when no runs exist", async () => {
    await seedCompanyAndAgent();
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(0);
    expect(result.suppressed).toHaveLength(0);
  });

  it("does not alert when count is below threshold", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD - 1; i++) {
      await insertWeakInfraRun();
    }
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(0);
  });

  it("alerts when count reaches the threshold", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toContain(agentId);
  });

  it("does not alert for runs outside the 24h window", async () => {
    await seedCompanyAndAgent();
    const outsideWindow = new Date(
      Date.now() - (WEAK_INFRA_WINDOW_HOURS + 1) * 60 * 60 * 1000,
    );
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun({ finishedAt: outsideWindow });
    }
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(0);
  });

  it("does not alert for primary-confidence runs", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun({ processLossClassifyConfidence: "primary" });
    }
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(0);
  });

  it("does not alert for non-infrastructure cause class", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun({ processLossCauseClass: "agent" });
    }
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(0);
  });

  it("alerts independently per agentId", async () => {
    await seedCompanyAndAgent();
    const agentId2 = randomUUID();
    await db.insert(agents).values({
      id: agentId2,
      companyId,
      name: "TestAgent2",
      role: "worker",
      status: "idle",
    });

    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun({ agentId: agentId2 });
    }
    for (let i = 0; i < WEAK_INFRA_THRESHOLD - 1; i++) {
      await insertWeakInfraRun({ agentId });
    }

    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toContain(agentId2);
    expect(result.alerted).not.toContain(agentId);
  });

  // -------------------------------------------------------------------------
  // F4: DB-persisted cooldown — survives simulated restart
  // -------------------------------------------------------------------------

  it("F4: suppresses duplicate alerts using DB-persisted cooldown", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }

    const first = await checkWeakInfraAccumulation({ db });
    expect(first.alerted).toContain(agentId);

    // Simulate a restart: _resetAlertState() is now a no-op; cooldown lives in DB.
    _resetAlertState();

    // Second call without advancing time — still within cooldown window.
    const second = await checkWeakInfraAccumulation({ db });
    expect(second.alerted).toHaveLength(0);
    expect(second.suppressed).toContain(agentId);
  });

  it("F4: re-alerts after cooldown window expires (DB timestamp respected)", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }

    const past = new Date(Date.now() - WEAK_INFRA_WINDOW_HOURS * 60 * 60 * 1000 - 1);
    // Seed an old alert state as if a previous alert fired before the window
    await db.insert(agentAlertState).values({
      agentId,
      alertKind: "weak_infra",
      lastFiredAt: past,
    });

    const result = await checkWeakInfraAccumulation({ db });
    // Cooldown expired — should re-alert
    expect(result.alerted).toContain(agentId);
  });

  // -------------------------------------------------------------------------
  // F5: Global company rate limit + digest path
  // -------------------------------------------------------------------------

  it("F5: emits individual alerts up to MAX_ALERTS_PER_HOUR", async () => {
    await seedCompanyAndAgent();

    // Create MAX_ALERTS_PER_HOUR agents, all above threshold
    const agentIds: string[] = [];
    for (let i = 0; i < MAX_ALERTS_PER_HOUR; i++) {
      const id = randomUUID();
      agentIds.push(id);
      await db.insert(agents).values({ id, companyId, name: `Agent${i}`, role: "worker", status: "idle" });
      for (let j = 0; j < WEAK_INFRA_THRESHOLD; j++) {
        await insertWeakInfraRun({ agentId: id });
      }
    }

    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(MAX_ALERTS_PER_HOUR);
    // None should go to digest when exactly at quota
    for (const id of agentIds) {
      expect(result.alerted).toContain(id);
    }
  });

  it("F5: agents beyond MAX_ALERTS_PER_HOUR are aggregated into a single digest issue", async () => {
    await seedCompanyAndAgent();

    const totalAgents = MAX_ALERTS_PER_HOUR + 2;
    const agentIds: string[] = [];
    for (let i = 0; i < totalAgents; i++) {
      const id = randomUUID();
      agentIds.push(id);
      await db.insert(agents).values({ id, companyId, name: `Agent${i}`, role: "worker", status: "idle" });
      for (let j = 0; j < WEAK_INFRA_THRESHOLD; j++) {
        await insertWeakInfraRun({ agentId: id });
      }
    }

    const result = await checkWeakInfraAccumulation({ db });
    // All agents are "alerted" (individual or digest)
    expect(result.alerted).toHaveLength(totalAgents);

    // Verify a digest issue was created (title contains "digest")
    const digestIssues = await db
      .select({ title: issues.title })
      .from(issues)
      .where(
        // The digest issue title contains "digest"
        // We can't use LIKE easily in Drizzle without sql``, so just fetch all and filter
        (t) => t,
      );
    const hasDigest = (await db.select({ title: issues.title }).from(issues)).some((i) =>
      i.title.toLowerCase().includes("digest"),
    );
    expect(hasDigest).toBe(true);
  });

  it("F5: existing hour alerts from DB count against company quota", async () => {
    await seedCompanyAndAgent();

    // Pre-seed MAX_ALERTS_PER_HOUR existing alert state entries (fired within last hour)
    const existingAgents: string[] = [];
    for (let i = 0; i < MAX_ALERTS_PER_HOUR; i++) {
      const id = randomUUID();
      existingAgents.push(id);
      await db.insert(agents).values({ id, companyId, name: `Existing${i}`, role: "worker", status: "idle" });
      await db.insert(agentAlertState).values({
        agentId: id,
        alertKind: "weak_infra",
        lastFiredAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago, within hour
      });
    }

    // Now add one new agent above threshold
    const newAgent = randomUUID();
    await db.insert(agents).values({ id: newAgent, companyId, name: "NewAgent", role: "worker", status: "idle" });
    for (let j = 0; j < WEAK_INFRA_THRESHOLD; j++) {
      await insertWeakInfraRun({ agentId: newAgent });
    }

    const result = await checkWeakInfraAccumulation({ db });
    // The new agent should be alerted (in alerted list) but via digest path
    expect(result.alerted).toContain(newAgent);

    // Verify digest issue was created
    const issueList = await db.select({ title: issues.title }).from(issues);
    const hasDigest = issueList.some((i) => i.title.toLowerCase().includes("digest"));
    expect(hasDigest).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F6: Status allowlist — terminated agents never receive alerts
  // -------------------------------------------------------------------------

  it("F6: does not assign alert to terminated CTO agent", async () => {
    await seedCompanyAndAgent();

    // Insert a terminated CTO — should be excluded
    const terminatedCto = randomUUID();
    await db.insert(agents).values({
      id: terminatedCto,
      companyId,
      name: "OldCTO",
      role: "cto",
      status: "terminated",
    });

    // Insert an idle CEO — should be chosen instead
    const activeCeo = randomUUID();
    await db.insert(agents).values({
      id: activeCeo,
      companyId,
      name: "Atlas",
      role: "ceo",
      status: "idle",
    });

    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }

    await checkWeakInfraAccumulation({ db });

    const alertIssues = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues);

    for (const issue of alertIssues) {
      expect(issue.assigneeAgentId).not.toBe(terminatedCto);
    }
  });

  it("F6: does not assign alert to removed CTO agent", async () => {
    await seedCompanyAndAgent();

    const removedCto = randomUUID();
    await db.insert(agents).values({
      id: removedCto,
      companyId,
      name: "RemovedCTO",
      role: "cto",
      status: "removed",
    });

    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }

    await checkWeakInfraAccumulation({ db });

    const alertIssues = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues);

    for (const issue of alertIssues) {
      expect(issue.assigneeAgentId).not.toBe(removedCto);
    }
  });

  it("F6: assigns alert to running CTO when idle CTO is absent", async () => {
    await seedCompanyAndAgent();

    const runningCto = randomUUID();
    await db.insert(agents).values({
      id: runningCto,
      companyId,
      name: "ActiveCTO",
      role: "cto",
      status: "running",
    });

    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }

    await checkWeakInfraAccumulation({ db });

    const alertIssues = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues);

    const hasRunningCtoAssignment = alertIssues.some((i) => i.assigneeAgentId === runningCto);
    expect(hasRunningCtoAssignment).toBe(true);
  });
});

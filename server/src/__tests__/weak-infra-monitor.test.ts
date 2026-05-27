import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issues, issueComments, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  checkWeakInfraAccumulation,
  WEAK_INFRA_THRESHOLD,
  WEAK_INFRA_WINDOW_HOURS,
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
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
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
      role: "worker",
      status: "idle",
    });
  }

  async function insertWeakInfraRun(
    overrides: Partial<{ agentId: string; finishedAt: Date; processLossCauseClass: string; processLossClassifyConfidence: string }> = {},
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

  it("returns empty alerted when no runs exist", async () => {
    await seedCompanyAndAgent();
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toHaveLength(0);
    expect(result.suppressed).toHaveLength(0);
  });

  it("does not alert when count is below threshold", async () => {
    await seedCompanyAndAgent();
    // Insert exactly threshold-1 weak-infra runs
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

  it("alerts on the 4th weak-infra run (threshold=3 means ≥3 triggers)", async () => {
    await seedCompanyAndAgent();
    // Insert 3 runs to cross threshold, then call check — should alert
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }
    // Insert one more run (the "4th") and check again after resetting cooldown
    await insertWeakInfraRun();
    _resetAlertState();
    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toContain(agentId);
  });

  it("does not alert for runs outside the 24h window", async () => {
    await seedCompanyAndAgent();
    const outsideWindow = new Date(Date.now() - (WEAK_INFRA_WINDOW_HOURS + 1) * 60 * 60 * 1000);
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

  it("suppresses duplicate alerts for the same agent within cooldown", async () => {
    await seedCompanyAndAgent();
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun();
    }

    const first = await checkWeakInfraAccumulation({ db });
    expect(first.alerted).toContain(agentId);

    // Second call without resetting state — should suppress
    const second = await checkWeakInfraAccumulation({ db });
    expect(second.alerted).toHaveLength(0);
    expect(second.suppressed).toContain(agentId);
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

    // Only agentId2 crosses the threshold
    for (let i = 0; i < WEAK_INFRA_THRESHOLD; i++) {
      await insertWeakInfraRun({ agentId: agentId2 });
    }
    // agentId has below-threshold count
    for (let i = 0; i < WEAK_INFRA_THRESHOLD - 1; i++) {
      await insertWeakInfraRun({ agentId });
    }

    const result = await checkWeakInfraAccumulation({ db });
    expect(result.alerted).toContain(agentId2);
    expect(result.alerted).not.toContain(agentId);
  });
});

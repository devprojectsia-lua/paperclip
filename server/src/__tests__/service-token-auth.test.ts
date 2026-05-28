/**
 * Tests for service-token auth path (GNO-241).
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({ orderBy: mockDbSelectOrderBy })));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({ insert: mockTxInsert }));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => [COMPANY_A]),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));

const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({ accessService: () => mockAccessService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
vi.mock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
vi.mock("../services/feedback.js", () => ({ feedbackService: () => mockFeedbackService }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => mockInstanceSettingsService }));
vi.mock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
vi.mock("../services/routines.js", () => ({ routineService: () => mockRoutineService }));

vi.mock("../services/index.js", () => ({
  companyService: () => ({ getById: vi.fn(async () => ({ id: COMPANY_A, attachmentMaxBytes: 10 * 1024 * 1024 })) }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_A],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(companyId = COMPANY_A) {
  return {
    id: ISSUE_ID,
    companyId,
    status: "in_progress" as const,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    title: "Test issue",
    identifier: "GNO-999",
    executionWorkspace: null,
    createdByUserId: "local-board",
  };
}

function makeComment(overrides?: Record<string, unknown>) {
  return {
    id: COMMENT_ID,
    issueId: ISSUE_ID,
    companyId: COMPANY_A,
    body: "Alert comment",
    authorType: "system",
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function serviceActor(overrides?: Record<string, unknown>) {
  return {
    type: "service",
    serviceTokenId: SERVICE_TOKEN_ID,
    companyId: COMPANY_A,
    scopes: ["comments:write"],
    source: "service_token",
    ...overrides,
  };
}

describe.sequential("service-token auth — POST /api/issues/:id/comments", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getCurrentScheduledRetry.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockLogActivity.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsert.mockReset();
    mockTxInsertValues.mockReset();

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.addComment.mockResolvedValue(makeComment());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID, blockerIssueIds: [], unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0, allBlockersDone: true, isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow" });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({ orderBy: mockDbSelectOrderBy }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
  });

  it("1. happy path — valid service token with comments:write → 201 with system author", async () => {
    const app = await installActor(createApp(), serviceActor());
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Weak infra alert triggered" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "Weak infra alert triggered",
      expect.objectContaining({ agentId: undefined, userId: undefined }),
      expect.objectContaining({ authorType: "system" }),
    );
  });

  it("2. scope enforcement — service token without comments:write → 403", async () => {
    const app = await installActor(createApp(), serviceActor({ scopes: ["other:scope"] }));
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "should be blocked" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Missing required scope: comments:write/);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("3. comment persist — authorType=system, agentId=undefined, userId=undefined", async () => {
    const app = await installActor(createApp(), serviceActor());
    await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "test comment" });

    expect(mockIssueService.addComment).toHaveBeenCalledOnce();
    const [, , identityArgs, optionsArgs] = mockIssueService.addComment.mock.calls[0];
    expect(identityArgs.agentId).toBeUndefined();
    expect(identityArgs.userId).toBeUndefined();
    expect(optionsArgs.authorType).toBe("system");
  });

  it("4. forge prevention regression — agent JWT cannot claim authorType=system", async () => {
    const agentActor = {
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_A,
      source: "agent_jwt",
      runId: "run-1",
    };
    mockIssueService.addComment.mockRejectedValue(
      Object.assign(new Error("Comment authorType must match authenticated actor"), { status: 422 }),
    );
    const app = await installActor(createApp(), agentActor);
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "forge attempt", authorType: "system" });

    expect(res.status).not.toBe(201);
  });

  it("5. revoked token — actor type remains none → 401", async () => {
    const app = await installActor(createApp(), { type: "none", source: "none" });
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "should be blocked" });

    expect(res.status).toBe(401);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("6. cross-company — service token for company A cannot access issue from company B → 403", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue(COMPANY_B));
    const app = await installActor(createApp(), serviceActor({ companyId: COMPANY_A }));
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "cross-company attack" });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("7. wake-path integration — service comment posts for @mention wake", async () => {
    const app = await installActor(createApp(), serviceActor());
    mockIssueService.addComment.mockResolvedValue(
      makeComment({ body: `[@Atlas](agent://${AGENT_ID}) weak infra detected` }),
    );

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `[@Atlas](agent://${AGENT_ID}) weak infra detected` });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledOnce();
    const [, body] = mockIssueService.addComment.mock.calls[0];
    expect(body).toContain("@Atlas");
  });
});

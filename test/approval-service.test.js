const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ApprovalService } = require("../src/host/approval-service");
const { PolicyEngine } = require("../src/host/policy-engine");
const { SessionRegistry } = require("../src/host/session-registry");

test("ApprovalService auto-resolves low risk approvals for exec-json sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "exec-json",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const result = await service.createApproval(session.hostSessionId, {
    riskLevel: "low",
    actionType: "shell",
    summary: "read-only command"
  });

  assert.equal(result.autoResolved, true);
  assert.equal(result.approval.status, "resolved");
  assert.equal(result.approval.decision.decision, "approve");
});

test("ApprovalService requests human fallback for app-server sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "app-server",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const result = await service.createApproval(session.hostSessionId, {
    riskLevel: "low",
    actionType: "shell",
    summary: "experimental transport"
  });

  assert.equal(result.autoResolved, false);
  assert.equal(result.needsHumanFallback, true);
  assert.equal(result.approval.status, "pending");
});

test("ApprovalService allows local human resolution when no transport callback is required", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "app-server",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const created = await service.createApproval(session.hostSessionId, {
    riskLevel: "high",
    actionType: "shell",
    summary: "needs manual decision"
  });

  const resolved = await service.resolveApproval(created.approval.requestId, {
    decision: "approve",
    decidedBy: "human",
    reason: "manual override"
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.approval.status, "resolved");
  assert.equal(resolved.approval.decision.decision, "approve");
});

test("ApprovalService returns fallback when transport callback cannot inject the decision", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine(),
    decisionHandler: async () => ({ handled: true, ok: false, error: "needs-human-fallback" })
  });

  const session = registry.createSession({
    source: "cli",
    transport: "app-server",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const created = await service.createApproval(session.hostSessionId, {
    riskLevel: "high",
    actionType: "shell",
    summary: "needs upstream reply"
  });

  const resolved = await service.resolveApproval(created.approval.requestId, {
    decision: "approve",
    decidedBy: "human",
    reason: "manual override"
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.error, "needs-human-fallback");
  assert.equal(registry.getApproval(created.approval.requestId).status, "pending");
});

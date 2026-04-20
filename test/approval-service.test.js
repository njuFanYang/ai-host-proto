const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ApprovalService } = require("../src/host/approval-service");
const { PolicyEngine } = require("../src/host/policy-engine");
const { SessionRegistry } = require("../src/host/session-registry");

test("ApprovalService auto-resolves low risk approvals for stream-json sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const result = await service.createApproval(session.hostSessionId, {
    riskLevel: "low",
    actionType: "Read",
    summary: "read-only tool"
  });

  assert.equal(result.autoResolved, true);
  assert.equal(result.approval.status, "resolved");
  assert.equal(result.approval.decision.decision, "approve");
});

test("ApprovalService escalates medium risk approvals to human review", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const result = await service.createApproval(session.hostSessionId, {
    riskLevel: "medium",
    actionType: "Write",
    summary: "file mutation"
  });

  assert.equal(result.autoResolved, false);
  assert.equal(result.needsHumanFallback, true);
  assert.equal(result.approval.status, "pending");
});

test("ApprovalService allows local human resolution for stream-json sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const created = await service.createApproval(session.hostSessionId, {
    riskLevel: "high",
    actionType: "Bash",
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

test("ApprovalService requests human fallback when transport lacks autoHitl support", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const service = new ApprovalService({
    registry,
    policyEngine: new PolicyEngine()
  });

  const session = registry.createSession({
    source: "cli",
    transport: "legacy-tty",
    workspaceRoot: projectRoot
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const result = await service.createApproval(session.hostSessionId, {
    riskLevel: "low",
    actionType: "Read",
    summary: "transport does not support auto-hitl"
  });

  assert.equal(result.autoResolved, false);
  assert.equal(result.needsHumanFallback, true);
  assert.equal(result.approval.status, "pending");
});

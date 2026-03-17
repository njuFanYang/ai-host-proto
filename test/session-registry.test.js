const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionRegistry } = require("../src/host/session-registry");

test("SessionRegistry creates host-managed sessions with deferred upstream binding", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });

  const record = registry.createSession({
    source: "cli",
    transport: "exec-json",
    workspaceRoot: projectRoot
  });

  assert.match(record.hostSessionId, /^host-cli-/);
  assert.equal(record.upstreamSessionId, null);
  assert.equal(record.registrationState, "pending_upstream");

  registry.bindUpstreamSession(record.hostSessionId, "thread-123");
  const updated = registry.getSession(record.hostSessionId);
  assert.equal(updated.upstreamSessionId, "thread-123");
  assert.equal(updated.registrationState, "bound");
});


test("SessionRegistry marks session waiting on approval and returns to running on approve", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });

  const record = registry.createSession({
    source: "cli",
    transport: "exec-json",
    workspaceRoot: projectRoot
  });

  registry.updateSession(record.hostSessionId, { status: "running" });
  const approval = registry.createApproval(record.hostSessionId, {
    riskLevel: "low",
    summary: "safe command"
  });

  assert.equal(registry.getSession(record.hostSessionId).status, "waiting_approval");

  registry.resolveApproval(approval.requestId, {
    decision: "approve",
    decidedBy: "policy",
    controllability: "controllable"
  });

  assert.equal(registry.getSession(record.hostSessionId).status, "running");
});


test("SessionRegistry reloads persisted sessions and approvals from disk", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });

  const record = registry.createSession({
    source: "cli",
    transport: "exec-json",
    workspaceRoot: projectRoot
  });
  registry.updateSession(record.hostSessionId, { status: "running" });
  const approval = registry.createApproval(record.hostSessionId, {
    riskLevel: "high",
    actionType: "shell",
    summary: "needs review"
  });
  registry.resolveApproval(approval.requestId, {
    decision: "approve",
    decidedBy: "human",
    controllability: "controllable"
  });

  const restored = new SessionRegistry({ projectRoot });
  const restoredSession = restored.getSession(record.hostSessionId);
  const restoredApproval = restored.getApproval(approval.requestId);

  assert.equal(restoredSession.hostSessionId, record.hostSessionId);
  assert.equal(restoredSession.status, "running");
  assert.equal(restoredApproval.status, "resolved");
  assert.equal(restoredApproval.decision.decision, "approve");
});


test("SessionRegistry persists wrapper commands across reload and keeps active lease", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });

  const record = registry.createSession({
    source: "ide",
    transport: "app-server",
    workspaceRoot: projectRoot
  });

  registry.enqueueWrapperCommand(record.hostSessionId, {
    kind: "start_turn",
    payload: { threadId: "thread-1", prompt: "hello" }
  });
  const claimed = registry.claimWrapperCommands(record.hostSessionId, {
    leaseMs: 60000,
    now: "2026-03-17T00:00:00.000Z"
  });

  const restored = new SessionRegistry({ projectRoot });
  const commands = restored.listWrapperCommands(record.hostSessionId);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].status, "leased");
  assert.equal(commands[0].commandId, claimed[0].commandId);
  assert.equal(commands[0].leaseToken, claimed[0].leaseToken);
});


test("SessionRegistry requeues expired wrapper command leases and rotates lease token", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });

  const record = registry.createSession({
    source: "ide",
    transport: "app-server",
    workspaceRoot: projectRoot
  });

  const queued = registry.enqueueWrapperCommand(record.hostSessionId, {
    kind: "start_turn",
    payload: { threadId: "thread-1", prompt: "hello" },
    maxRetries: 2
  });
  const firstLease = registry.claimWrapperCommands(record.hostSessionId, {
    leaseMs: 1000,
    now: "2026-03-17T00:00:00.000Z"
  })[0];

  const requeued = registry.requeueExpiredWrapperCommands(record.hostSessionId, {
    now: "2026-03-17T00:00:02.000Z",
    reason: "lease_expired"
  });
  const secondLease = registry.claimWrapperCommands(record.hostSessionId, {
    leaseMs: 1000,
    now: "2026-03-17T00:00:03.000Z"
  })[0];

  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].commandId, queued.commandId);
  assert.equal(requeued[0].status, "queued");
  assert.equal(requeued[0].retryCount, 1);
  assert.equal(secondLease.commandId, queued.commandId);
  assert.notEqual(secondLease.leaseToken, firstLease.leaseToken);
});


test("SessionRegistry handles duplicate completion with the same lease token safely", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });

  const record = registry.createSession({
    source: "ide",
    transport: "app-server",
    workspaceRoot: projectRoot
  });

  registry.enqueueWrapperCommand(record.hostSessionId, {
    kind: "start_turn",
    payload: { threadId: "thread-1", prompt: "hello" }
  });
  const lease = registry.claimWrapperCommands(record.hostSessionId, {
    leaseMs: 1000,
    now: "2026-03-17T00:00:00.000Z"
  })[0];

  const completed = registry.completeWrapperCommand(record.hostSessionId, lease.commandId, {
    ok: true,
    leaseToken: lease.leaseToken,
    response: { turn: { id: "turn-1" } }
  });
  const duplicate = registry.completeWrapperCommand(record.hostSessionId, lease.commandId, {
    ok: true,
    leaseToken: lease.leaseToken,
    response: { turn: { id: "turn-1" } }
  });

  assert.equal(completed.status, "completed");
  assert.equal(duplicate.status, "completed");
  assert.equal(registry.listEvents(record.hostSessionId).filter((event) => event.kind === "wrapper_command_completed").length, 1);
});

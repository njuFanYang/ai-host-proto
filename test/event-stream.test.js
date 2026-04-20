const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionRegistry } = require("../src/host/session-registry");

test("SessionRegistry publishes session, event, and approval updates to subscribers", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const messages = [];
  const unsubscribe = registry.subscribe((message) => messages.push(message));

  const record = registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot
  });

  registry.updateSession(record.hostSessionId, { status: "running" });
  registry.appendEvent(record.hostSessionId, {
    kind: "assistant_output",
    controllability: "controllable",
    payload: { text: "OK" }
  });
  const approval = registry.createApproval(record.hostSessionId, {
    riskLevel: "medium",
    actionType: "file",
    summary: "write file",
    controllability: "controllable"
  });
  registry.resolveApproval(approval.requestId, {
    decision: "approve",
    decidedBy: "human",
    controllability: "controllable"
  });
  unsubscribe();

  assert.equal(messages.some((message) => message.type === "session" && message.action === "created"), true);
  assert.equal(messages.some((message) => message.type === "session" && message.action === "updated"), true);
  assert.equal(messages.some((message) => message.type === "event" && message.event.kind === "assistant_output"), true);
  assert.equal(messages.some((message) => message.type === "approval" && message.action === "created"), true);
  assert.equal(messages.some((message) => message.type === "approval" && message.action === "resolved"), true);
});

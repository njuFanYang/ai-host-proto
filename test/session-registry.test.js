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

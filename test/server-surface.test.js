const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createExternalServer, createHostRuntime, createHostServer } = require("../src/server");
const { SessionRegistry } = require("../src/host/session-registry");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createStubRuntime(projectRoot) {
  const registry = new SessionRegistry({ projectRoot });
  const manager = {
    onSessionAvailable: null,
    refreshAllSessions() {
      return registry.listSessions();
    },
    refreshSession(hostSessionId) {
      return registry.getSession(hostSessionId);
    },
    async launchCliSession(input) {
      const record = registry.createSession({
        source: "cli",
        transport: "stream-json",
        workspaceRoot: input.cwd || projectRoot,
        runtime: {
          mode: "stream-json"
        }
      });
      registry.bindUpstreamSession(record.hostSessionId, `thread-${record.hostSessionId}`);
      registry.updateSession(record.hostSessionId, { status: "running" });
      return {
        record,
        terminalLaunchInfo: null
      };
    },
    async dispatchTransportMessage(hostSessionId, prompt) {
      return { ok: true, hostSessionId, prompt };
    },
    async handleApprovalDecision() {
      return { handled: false };
    }
  };

  return createHostRuntime({ projectRoot, registry, manager });
}

test("external surface excludes CLI launch endpoints", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const runtime = createStubRuntime(projectRoot);
  const session = runtime.registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "stream-json"
    }
  });
  runtime.registry.bindUpstreamSession(session.hostSessionId, "thread-surface-1");
  runtime.registry.updateSession(session.hostSessionId, { status: "running" });

  const internal = createHostServer(runtime);
  const external = createExternalServer(runtime);
  const internalAddress = await listen(internal.server);
  const externalAddress = await listen(external.server);
  const externalUrl = `http://127.0.0.1:${externalAddress.port}`;

  try {
    const health = await fetch(`${externalUrl}/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.surface, "external");

    const sessions = await fetch(`${externalUrl}/sessions`);
    const sessionsBody = await sessions.json();
    assert.equal(sessions.status, 200);
    assert.equal(sessionsBody.sessions.length, 1);

    const message = await fetch(`${externalUrl}/sessions/${encodeURIComponent(session.hostSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Reply with exactly SURFACE.",
        controllerId: "feishu-adapter",
        controllerType: "feishu"
      })
    });
    assert.equal(message.status, 202);

    const forbiddenLaunch = await fetch(`${externalUrl}/sessions/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot })
    });
    const forbiddenLaunchBody = await forbiddenLaunch.json();
    assert.equal(forbiddenLaunch.status, 404);
    assert.equal(forbiddenLaunchBody.surface, "external");
  } finally {
    await close(internal.server);
    await close(external.server);
  }
});

test("external surface exposes channel binding APIs for CLI sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const runtime = createStubRuntime(projectRoot);
  const session = runtime.registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "stream-json"
    }
  });
  runtime.registry.bindUpstreamSession(session.hostSessionId, "thread-surface-2");
  runtime.registry.updateSession(session.hostSessionId, { status: "running" });

  const internal = createHostServer(runtime);
  const external = createExternalServer(runtime);
  await listen(internal.server);
  const externalAddress = await listen(external.server);
  const externalUrl = `http://127.0.0.1:${externalAddress.port}`;

  try {
    const attach = await fetch(`${externalUrl}/channel-bindings/feishu/chat-9/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostSessionId: session.hostSessionId,
        conversationType: "group",
        mode: "control",
        attachedBy: "user-9",
        channelUserId: "open-user-9"
      })
    });
    const attachBody = await attach.json();
    assert.equal(attach.status, 200);
    assert.equal(attachBody.binding.activeHostSessionId, session.hostSessionId);
    assert.equal(attachBody.binding.mode, "control");

    const bindings = await fetch(`${externalUrl}/channel-bindings?channel=feishu`);
    const bindingsBody = await bindings.json();
    assert.equal(bindings.status, 200);
    assert.equal(bindingsBody.bindings.length, 1);

    const message = await fetch(`${externalUrl}/channel-bindings/feishu/chat-9/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Reply with exactly CHANNEL.",
        channelUserId: "open-user-9"
      })
    });
    const messageBody = await message.json();
    assert.equal(message.status, 202);
    assert.equal(messageBody.hostSessionId, session.hostSessionId);

    const watch = await fetch(`${externalUrl}/channel-bindings/feishu/chat-9/watch`);
    const watchBody = await watch.json();
    assert.equal(watch.status, 200);
    assert.equal(watchBody.binding.activeHostSessionId, session.hostSessionId);
    assert.equal(Array.isArray(watchBody.events), true);

    const detach = await fetch(`${externalUrl}/channel-bindings/feishu/chat-9/detach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelUserId: "open-user-9" })
    });
    const detachBody = await detach.json();
    assert.equal(detach.status, 200);
    assert.equal(detachBody.binding.activeHostSessionId, null);
  } finally {
    await close(internal.server);
    await close(external.server);
  }
});

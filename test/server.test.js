const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHostRuntime, createHostServer } = require("../src/server");
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
        transport: input.mode === "tty" ? "tty" : "exec-json",
        workspaceRoot: input.cwd || projectRoot,
        runtime: {
          mode: input.mode || "exec-json",
          sandbox: input.sandbox || null
        }
      });
      registry.updateSession(record.hostSessionId, { status: input.mode === "tty" ? "running" : "ended" });
      return {
        record,
        terminalLaunchInfo: input.mode === "tty" ? { mode: "tty", command: "stub" } : null
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

test("host server launches managed CLI sessions over HTTP", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const host = createHostServer(createStubRuntime(projectRoot));
  const address = await listen(host.server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await fetch(`${baseUrl}/sessions/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot, mode: "tty", prompt: "inspect" })
    });
    const body = await created.json();

    assert.equal(created.status, 201);
    assert.equal(body.session.source, "cli");
    assert.equal(body.session.transport, "tty");
    assert.equal(body.terminalLaunchInfo.mode, "tty");
  } finally {
    await close(host.server);
  }
});

test("host server exposes controller and input queue endpoints for CLI sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const runtime = createStubRuntime(projectRoot);
  const session = runtime.registry.createSession({
    source: "cli",
    transport: "exec-json",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "exec-json",
      sandbox: "read-only"
    }
  });
  runtime.registry.bindUpstreamSession(session.hostSessionId, "thread-http-cli-1");
  runtime.registry.updateSession(session.hostSessionId, { status: "running" });

  const host = createHostServer(runtime);
  const address = await listen(host.server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const attachResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.hostSessionId)}/controllers/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        controllerId: "feishu-demo",
        controllerType: "feishu",
        mode: "watch"
      })
    });
    const attachBody = await attachResponse.json();
    assert.equal(attachResponse.status, 200);
    assert.equal(attachBody.controller.controllerId, "feishu-demo");

    const messageResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.hostSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Reply with exactly SIXTH.",
        controllerId: "local-api",
        controllerType: "api"
      })
    });
    const messageBody = await messageResponse.json();
    assert.equal(messageResponse.status, 202);
    assert.equal(messageBody.input.controllerId, "local-api");

    const controllersResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.hostSessionId)}/controllers`);
    const controllersBody = await controllersResponse.json();
    assert.equal(controllersResponse.status, 200);
    assert.equal(controllersBody.controllers.some((controller) => controller.controllerId === "feishu-demo"), true);
    assert.equal(controllersBody.controllers.some((controller) => controller.controllerId === "local-api" && controller.mode === "active-write"), true);

    const inputsResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.hostSessionId)}/inputs`);
    const inputsBody = await inputsResponse.json();
    assert.equal(inputsResponse.status, 200);
    assert.equal(inputsBody.inputs.length, 1);
    assert.equal(inputsBody.inputs[0].status, "completed");
    assert.equal(inputsBody.inputs[0].result.prompt, "Reply with exactly SIXTH.");

    const conflictResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.hostSessionId)}/controllers/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        controllerId: "mobile-active",
        controllerType: "feishu",
        mode: "active-write"
      })
    });
    const conflictBody = await conflictResponse.json();
    assert.equal(conflictResponse.status, 409);
    assert.equal(conflictBody.code, "controller_conflict");
  } finally {
    await close(host.server);
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHostServer } = require("../src/server");

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

test("host server exposes wrapper command queue over HTTP", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const host = createHostServer({ projectRoot });
  const address = await listen(host.server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await fetch(`${baseUrl}/sessions/ide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot, mode: "wrapper-managed" })
    });
    const createdBody = await created.json();
    const hostSessionId = createdBody.session.hostSessionId;

    await fetch(`${baseUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/runtime`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        processId: process.pid,
        realCodex: "codex",
        argv: ["app-server"],
        proxyMode: "app-server"
      })
    });
    await fetch(`${baseUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "stdout",
        line: JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-http-1" } } })
      })
    });

    const messageResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Reply with exactly FIFTH." })
    });
    assert.equal(messageResponse.status, 202);

    const commandsResponse = await fetch(`${baseUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/commands`);
    const commandsBody = await commandsResponse.json();

    assert.equal(commandsResponse.status, 200);
    assert.equal(commandsBody.commands.length, 1);
    assert.equal(commandsBody.commands[0].kind, "start_turn");
    assert.equal(commandsBody.commands[0].payload.threadId, "thread-http-1");
    assert.equal(commandsBody.commands[0].payload.prompt, "Reply with exactly FIFTH.");

    const completeResponse = await fetch(`${baseUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/commands/${encodeURIComponent(commandsBody.commands[0].commandId)}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, leaseToken: commandsBody.commands[0].leaseToken, response: { turn: { id: "turn-http-1" } } })
    });
    const completeBody = await completeResponse.json();

    assert.equal(completeResponse.status, 200);
    assert.equal(completeBody.command.status, "completed");

    const eventsResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/events`);
    const eventsBody = await eventsResponse.json();
    assert.equal(eventsBody.events.some((event) => event.kind === "wrapper_command_completed"), true);
  } finally {
    await close(host.server);
  }
});

test("host server exposes controller and input queue endpoints", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const host = createHostServer({ projectRoot });
  const address = await listen(host.server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await fetch(`${baseUrl}/sessions/ide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projectRoot, mode: "wrapper-managed" })
    });
    const createdBody = await created.json();
    const hostSessionId = createdBody.session.hostSessionId;

    await fetch(`${baseUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/runtime`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        processId: process.pid,
        realCodex: "codex",
        argv: ["app-server"],
        proxyMode: "app-server"
      })
    });
    await fetch(`${baseUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "stdout",
        line: JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-http-2" } } })
      })
    });

    const attachResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/controllers/attach`, {
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

    const messageResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/messages`, {
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

    const controllersResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/controllers`);
    const controllersBody = await controllersResponse.json();
    assert.equal(controllersResponse.status, 200);
    assert.equal(controllersBody.controllers.some((controller) => controller.controllerId === "feishu-demo"), true);
    assert.equal(controllersBody.controllers.some((controller) => controller.controllerId === "local-api" && controller.mode === "active-write"), true);

    const inputsResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/inputs`);
    const inputsBody = await inputsResponse.json();
    assert.equal(inputsResponse.status, 200);
    assert.equal(inputsBody.inputs.length, 1);
    assert.equal(inputsBody.inputs[0].status, "completed");
    assert.deepEqual(inputsBody.inputs[0].result, {
      queued: true,
      commandId: inputsBody.inputs[0].result.commandId
    });

    const conflictResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(hostSessionId)}/controllers/attach`, {
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

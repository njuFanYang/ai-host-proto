const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionControlService } = require("../src/host/session-control-service");
const { SessionRegistry } = require("../src/host/session-registry");

function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const session = registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "stream-json"
    }
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  const calls = [];
  const manager = {
    onSessionAvailable: null,
    refreshSession(hostSessionId) {
      return registry.getSession(hostSessionId);
    },
    async dispatchTransportMessage(hostSessionId, prompt) {
      calls.push({ hostSessionId, prompt });
      return true;
    }
  };

  const service = new SessionControlService({ registry, manager });
  return { projectRoot, registry, session, manager, service, calls };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("SessionControlService enforces a single active-write controller unless takeover is requested", () => {
  const { service, session } = createHarness();

  const first = service.attachController(session.hostSessionId, {
    controllerId: "local-cli",
    controllerType: "cli",
    mode: "active-write"
  });

  assert.equal(first.mode, "active-write");
  assert.throws(() => {
    service.attachController(session.hostSessionId, {
      controllerId: "feishu-1",
      controllerType: "feishu",
      mode: "active-write"
    });
  }, /already has an active controller/);

  const second = service.attachController(session.hostSessionId, {
    controllerId: "feishu-1",
    controllerType: "feishu",
    mode: "active-write",
    takeover: true
  });
  const controllers = service.listControllers(session.hostSessionId);

  assert.equal(second.mode, "active-write");
  assert.equal(controllers.find((item) => item.controllerId === "local-cli").mode, "watch");
  assert.equal(controllers.find((item) => item.controllerId === "feishu-1").mode, "active-write");
});

test("SessionControlService blocks queued input during approval and resumes after approval is resolved", async () => {
  const { registry, service, session, calls } = createHarness();

  registry.updateSession(session.hostSessionId, { status: "waiting_approval" });
  const queued = await service.submitMessage(session.hostSessionId, "hello", {
    controllerId: "local-api",
    controllerType: "api"
  });

  assert.equal(queued.status, "blocked");
  assert.equal(calls.length, 0);

  registry.updateSession(session.hostSessionId, { status: "running" });
  await service.drainQueue(session.hostSessionId);

  const inputs = service.listInputs(session.hostSessionId);
  const resumed = inputs.find((item) => item.inputId === queued.inputId);
  const events = registry.listEvents(session.hostSessionId);

  assert.equal(calls.length, 1);
  assert.equal(resumed.status, "completed");
  assert.equal(events.some((event) => event.kind === "session_input_resumed"), true);
  assert.equal(events.some((event) => event.kind === "session_input_completed"), true);
});

test("SessionControlService holds later queued inputs until deferred transport becomes available again", async () => {
  const { registry, service, session, manager, calls } = createHarness();

  manager.dispatchTransportMessage = async (hostSessionId, prompt) => {
    calls.push({ hostSessionId, prompt });
    return { queued: true, commandId: `cmd-${calls.length}` };
  };

  const first = await service.submitMessage(session.hostSessionId, "first", {
    controllerId: "local-api",
    controllerType: "api"
  });
  const second = await service.submitMessage(session.hostSessionId, "second", {
    controllerId: "local-api",
    controllerType: "api"
  });
  await tick();

  let inputs = service.listInputs(session.hostSessionId);
  assert.equal(calls.length, 1);
  assert.equal(inputs.find((item) => item.inputId === first.inputId).status, "completed");
  assert.equal(inputs.find((item) => item.inputId === second.inputId).status, "queued");

  await manager.onSessionAvailable(session.hostSessionId);
  await tick();

  inputs = service.listInputs(session.hostSessionId);
  assert.equal(calls.length, 2);
  assert.equal(inputs.find((item) => item.inputId === second.inputId).status, "completed");
  assert.equal(registry.listEvents(session.hostSessionId).filter((event) => event.kind === "session_input_started").length, 2);
});

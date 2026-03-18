const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CodexCliManager } = require("../src/host/codex-cli");
const { SessionRegistry } = require("../src/host/session-registry");

test("CodexCliManager routes sdk mode through the sdk/thread compatibility transport", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });
  let calledWith = null;

  manager.appServerClient.launchSdkSession = async (input) => {
    calledWith = input;
    return {
      record: {
        hostSessionId: "host-cli-sdk-test"
      },
      terminalLaunchInfo: null
    };
  };

  const result = await manager.launchCliSession({
    mode: "sdk",
    cwd: projectRoot,
    prompt: "Reply with exactly OK."
  });

  assert.equal(calledWith.mode, "sdk");
  assert.equal(calledWith.cwd, projectRoot);
  assert.equal(result.record.hostSessionId, "host-cli-sdk-test");
});

test("CodexCliManager routes app-server mode through the direct CLI transport", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });
  let calledWith = null;

  manager.appServerClient.launchCliSession = async (input) => {
    calledWith = input;
    return {
      record: {
        hostSessionId: "host-cli-app-server-test"
      },
      terminalLaunchInfo: null
    };
  };

  const result = await manager.launchCliSession({
    mode: "app-server",
    cwd: projectRoot,
    prompt: "Reply with exactly OK."
  });

  assert.equal(calledWith.mode, "app-server");
  assert.equal(result.record.hostSessionId, "host-cli-app-server-test");
});

test("CodexCliManager dispatches resumable messages to sdk/thread sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });
  const session = registry.createSession({
    source: "cli",
    transport: "sdk/thread",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "sdk"
    }
  });
  registry.bindUpstreamSession(session.hostSessionId, "thread-sdk-1");
  registry.updateSession(session.hostSessionId, { status: "running" });

  let sent = null;
  manager.appServerClient.sendMessage = async (hostSessionId, prompt) => {
    sent = { hostSessionId, prompt };
    return true;
  };

  const result = await manager.dispatchTransportMessage(session.hostSessionId, "SECOND");

  assert.equal(result, true);
  assert.deepEqual(sent, {
    hostSessionId: session.hostSessionId,
    prompt: "SECOND"
  });
});

test("CodexCliManager rejects controllable message injection for tty sessions", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });
  const session = registry.createSession({
    source: "cli",
    transport: "tty",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "tty"
    }
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  await assert.rejects(() => manager.dispatchTransportMessage(session.hostSessionId, "nope"), /does not support controllable message injection/);
});


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ApprovalService } = require("../src/host/approval-service");
const { ChannelBindingRegistry } = require("../src/host/channel-binding-registry");
const { ChannelBindingService } = require("../src/host/channel-binding-service");
const { PolicyEngine } = require("../src/host/policy-engine");
const { SessionControlService } = require("../src/host/session-control-service");
const { SessionRegistry } = require("../src/host/session-registry");

function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const sessionRegistry = new SessionRegistry({ projectRoot });
  const bindingRegistry = new ChannelBindingRegistry({ projectRoot });
  const managerCalls = [];
  const manager = {
    onSessionAvailable: null,
    refreshSession(hostSessionId) {
      return sessionRegistry.getSession(hostSessionId);
    },
    async dispatchTransportMessage(hostSessionId, prompt) {
      managerCalls.push({ hostSessionId, prompt });
      return true;
    }
  };
  const sessionControl = new SessionControlService({ registry: sessionRegistry, manager });
  const approvalService = new ApprovalService({
    registry: sessionRegistry,
    policyEngine: new PolicyEngine()
  });
  const service = new ChannelBindingService({
    bindingRegistry,
    sessionRegistry,
    sessionControl,
    approvalService
  });

  const session = sessionRegistry.createSession({
    source: "cli",
    transport: "app-server",
    workspaceRoot: projectRoot,
    runtime: {
      mode: "app-server"
    }
  });
  sessionRegistry.updateSession(session.hostSessionId, { status: "running" });

  return { projectRoot, sessionRegistry, bindingRegistry, manager, managerCalls, sessionControl, service, session };
}

test("ChannelBindingRegistry persists conversation binding records across reload", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new ChannelBindingRegistry({ projectRoot });

  registry.attachBinding({
    channel: "feishu",
    conversationId: "chat-1",
    conversationType: "group",
    activeHostSessionId: "host-cli-1",
    mode: "control",
    pinnedSessionIds: ["host-cli-1"],
    activeControllerId: "channel:feishu:chat-1",
    activeControllerType: "channel:feishu",
    attachedBy: "user-1"
  });

  const restored = new ChannelBindingRegistry({ projectRoot });
  const binding = restored.getBinding("feishu", "chat-1");

  assert.equal(binding.activeHostSessionId, "host-cli-1");
  assert.equal(binding.mode, "control");
  assert.deepEqual(binding.pinnedSessionIds, ["host-cli-1"]);
});

test("ChannelBindingService attaches conversation-scoped control and routes messages to the active session", async () => {
  const { service, session, managerCalls, sessionRegistry } = createHarness();

  const binding = service.attachBinding("feishu", "chat-2", {
    hostSessionId: session.hostSessionId,
    conversationType: "group",
    mode: "control",
    attachedBy: "user-2",
    channelUserId: "open-user-2"
  });

  const result = await service.sendBoundMessage("feishu", "chat-2", "hello from feishu", {
    channelUserId: "open-user-2"
  });

  assert.equal(binding.activeHostSessionId, session.hostSessionId);
  assert.equal(binding.mode, "control");
  assert.equal(result.hostSessionId, session.hostSessionId);
  assert.equal(managerCalls.length, 1);
  assert.equal(managerCalls[0].prompt, "hello from feishu");

  const controllers = sessionRegistry.getSession(session.hostSessionId).metadata.sessionControl.controllers;
  assert.equal(controllers.some((controller) => controller.controllerId === "channel:feishu:chat-2" && controller.mode === "active-write"), true);
});

test("ChannelBindingService requires control mode before channel messages can be injected", async () => {
  const { service, session } = createHarness();

  service.attachBinding("feishu", "chat-3", {
    hostSessionId: session.hostSessionId,
    mode: "watch"
  });

  await assert.rejects(() => {
    return service.sendBoundMessage("feishu", "chat-3", "should fail");
  }, /not in control mode/);
});

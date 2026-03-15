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

test("CodexCliManager records wrapper proxy output and binds upstream thread", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });

  const prepared = await manager.launchIdeSession({ cwd: projectRoot });
  const hostSessionId = prepared.record.hostSessionId;

  await manager.recordWrapperEvent(hostSessionId, {
    direction: "stdout",
    line: JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-1" } } })
  });
  await manager.recordWrapperEvent(hostSessionId, {
    direction: "stdout",
    line: JSON.stringify({
      method: "codex/event/agent_message_content_delta",
      params: {
        msg: { thread_id: "thread-1", turn_id: "turn-1", item_id: "item-1", delta: "OK" }
      }
    })
  });
  await manager.recordWrapperEvent(hostSessionId, {
    direction: "stdout",
    line: JSON.stringify({
      method: "codex/event/item_completed",
      params: {
        msg: {
          thread_id: "thread-1",
          turn_id: "turn-1",
          item: {
            type: "AgentMessage",
            id: "msg-1",
            content: [{ type: "Text", text: "OK" }],
            phase: "final_answer"
          }
        }
      }
    })
  });

  const session = registry.getSession(hostSessionId);
  const events = registry.listEvents(hostSessionId);

  assert.equal(session.upstreamSessionId, "thread-1");
  assert.equal(events.some((event) => event.kind === "assistant_output_delta" && event.payload.text === "OK"), true);
  assert.equal(events.some((event) => event.kind === "assistant_output" && event.payload.text === "OK"), true);
});

test("CodexCliManager observes wrapper approval request and client response", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });

  const prepared = await manager.launchIdeSession({ cwd: projectRoot });
  const hostSessionId = prepared.record.hostSessionId;

  await manager.recordWrapperEvent(hostSessionId, {
    direction: "stdout",
    line: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { reason: "write file" }
    })
  });

  let approval = registry.listApprovals({ hostSessionId })[0];
  assert.equal(approval.status, "pending");

  await manager.recordWrapperEvent(hostSessionId, {
    direction: "stdin",
    line: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { decision: "accept" } }),
    relatedApprovalMethod: "item/fileChange/requestApproval"
  });

  approval = registry.getApproval(approval.requestId);
  const events = registry.listEvents(hostSessionId);
  assert.equal(approval.status, "resolved");
  assert.equal(approval.decision.decision, "approve");
  assert.equal(events.some((event) => event.kind === "approval_result_observed"), true);
});

test("CodexCliManager prepares wrapper-managed IDE sessions with experimental capabilities", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });

  const result = await manager.launchIdeSession({
    cwd: projectRoot,
    hostUrl: "http://127.0.0.1:7788"
  });

  const session = registry.getSession(result.record.hostSessionId);
  assert.equal(session.transport, "app-server");
  assert.equal(session.runtime.mode, "wrapper-managed");
  assert.equal(session.transportCapabilities.outputCollection, "limited");
  assert.equal(session.transportCapabilities.messageInjection, "conditional");
  assert.equal(session.transportCapabilities.autoHitl, "poc");
  assert.equal(result.wrapperLaunchInfo.env.AI_HOST_SESSION_ID, session.hostSessionId);
  assert.match(result.wrapperLaunchInfo.wrapperPath, /codex-wrapper\.cmd$/);
});

test("CodexCliManager tracks wrapper-managed runtime updates and completion", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });

  const prepared = await manager.launchIdeSession({ cwd: projectRoot });
  const hostSessionId = prepared.record.hostSessionId;

  await manager.registerWrapperSession({
    hostSessionId,
    cwd: projectRoot,
    argv: ["chat"]
  });

  await manager.updateWrapperRuntime(hostSessionId, {
    processId: process.pid,
    realCodex: "codex",
    argv: ["chat"],
    launchedAt: "2026-03-15T00:00:00.000Z"
  });

  const running = manager.refreshSession(hostSessionId);
  assert.equal(running.status, "running");
  assert.equal(running.runtime.wrapperReported, true);
  assert.equal(running.runtime.processId, process.pid);
  assert.equal(running.metadata.argv[0], "chat");

  await manager.markWrapperCompleted(hostSessionId, {
    exitCode: 0,
    signal: null
  });

  const ended = registry.getSession(hostSessionId);
  const events = registry.listEvents(hostSessionId);
  assert.equal(ended.status, "ended");
  assert.equal(events.some((event) => event.kind === "wrapper_runtime_reported"), true);
  assert.equal(events.at(-1).kind, "session_ended");
});

test("CodexCliManager ends wrapper-managed sessions when the wrapped process disappears", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new CodexCliManager({ registry, projectRoot });

  const prepared = await manager.launchIdeSession({ cwd: projectRoot });
  const hostSessionId = prepared.record.hostSessionId;

  await manager.registerWrapperSession({
    hostSessionId,
    cwd: projectRoot,
    argv: ["chat"]
  });

  await manager.updateWrapperRuntime(hostSessionId, {
    processId: 999999,
    realCodex: "codex",
    argv: ["chat"]
  });

  const refreshed = manager.refreshSession(hostSessionId);
  const lastEvent = registry.listEvents(hostSessionId).at(-1);

  assert.equal(refreshed.status, "ended");
  assert.equal(lastEvent.kind, "session_ended");
  assert.equal(lastEvent.payload.reason, "wrapper_process_not_running");
});

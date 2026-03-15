const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAppServerEnv,
  buildApprovalSummary,
  extractTurnSnapshot,
  inferApprovalActionType,
  inferApprovalRisk,
  isApprovalMethod,
  isRetryableThreadReadError,
  mapApprovalDecisionToRpcResult,
  mapCompletedItemEvent,
  mapThreadItemEvent
} = require("../src/host/app-server-client");

test("app-server helpers build inherited or overridden environment", () => {
  const inherited = buildAppServerEnv(null);
  const overridden = buildAppServerEnv('E:\\tmp\\codex-home');

  assert.equal(typeof inherited, 'object');
  assert.equal(overridden.CODEX_HOME, 'E:\\tmp\\codex-home');
});

test("app-server helpers classify approval methods", () => {
  assert.equal(isApprovalMethod("item/commandExecution/requestApproval"), true);
  assert.equal(isApprovalMethod("item/fileChange/requestApproval"), true);
  assert.equal(isApprovalMethod("item/permissions/requestApproval"), true);
  assert.equal(isApprovalMethod("item/tool/requestUserInput"), false);

  assert.equal(inferApprovalRisk("item/commandExecution/requestApproval"), "high");
  assert.equal(inferApprovalRisk("item/fileChange/requestApproval"), "medium");
  assert.equal(inferApprovalActionType("item/permissions/requestApproval"), "permissions");
});

test("app-server helpers build readable approval summaries", () => {
  assert.equal(
    buildApprovalSummary("item/commandExecution/requestApproval", { command: "git status" }),
    "git status"
  );
  assert.equal(
    buildApprovalSummary("item/fileChange/requestApproval", { reason: "needs write access" }),
    "needs write access"
  );
  assert.equal(
    buildApprovalSummary("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }),
    JSON.stringify({ permissions: { network: { enabled: true } } }.permissions)
  );
});

test("app-server helpers treat rpc request id 0 as valid", () => {
  const rawRequest = { rpcRequestId: 0, method: 'item/fileChange/requestApproval', params: {} };
  assert.equal(rawRequest.rpcRequestId === undefined || rawRequest.rpcRequestId === null || !rawRequest.method, false);
});

test("app-server helpers map approval decisions into rpc results", () => {
  assert.deepEqual(
    mapApprovalDecisionToRpcResult("item/commandExecution/requestApproval", {}, { decision: "approve" }),
    { ok: true, result: { decision: "accept" } }
  );
  assert.deepEqual(
    mapApprovalDecisionToRpcResult("item/fileChange/requestApproval", {}, { decision: "deny" }),
    { ok: true, result: { decision: "decline" } }
  );
  assert.deepEqual(
    mapApprovalDecisionToRpcResult(
      "item/permissions/requestApproval",
      { permissions: { network: { enabled: true } } },
      { decision: "approve" }
    ),
    { ok: true, result: { permissions: { network: { enabled: true } }, scope: "turn" } }
  );
  assert.equal(
    mapApprovalDecisionToRpcResult("item/permissions/requestApproval", {}, { decision: "deny" }).ok,
    false
  );
});

test("app-server helpers detect retryable thread/read errors", () => {
  assert.equal(isRetryableThreadReadError(new Error("failed to load rollout because session file is empty")), true);
  assert.equal(isRetryableThreadReadError(new Error("ordinary failure")), false);
});

test("app-server helpers ignore completed user message items", () => {
  assert.equal(
    mapCompletedItemEvent({
      item: {
        type: "userMessage",
        id: "u1"
      }
    }),
    null
  );
});

test("app-server helpers map completed agent messages", () => {
  const assistant = mapCompletedItemEvent({
    item: {
      type: "agentMessage",
      text: "hello"
    }
  });
  const tool = mapCompletedItemEvent({
    item: {
      type: "commandExecution",
      command: "dir"
    }
  });

  assert.equal(assistant.kind, "assistant_output");
  assert.equal(assistant.payload.text, "hello");
  assert.equal(tool.kind, "tool_result");
});

test("app-server helpers extract unseen turn items from thread/read", () => {
  const seen = new Set(["user-1"]);
  const snapshot = extractTurnSnapshot({
    thread: {
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", id: "user-1" },
            { type: "agentMessage", id: "assistant-1", text: "OK" }
          ]
        }
      ]
    }
  }, "turn-1", seen);

  assert.equal(snapshot.turnFound, true);
  assert.equal(snapshot.turnStatus, "completed");
  assert.equal(snapshot.newItems.length, 1);
  assert.equal(snapshot.newItems[0].id, "assistant-1");
  assert.equal(seen.has("assistant-1"), true);
});

test("app-server helpers map thread/read items to host events", () => {
  const assistant = mapThreadItemEvent({
    type: "agentMessage",
    id: "assistant-1",
    text: "OK"
  }, "turn-1");
  const user = mapThreadItemEvent({
    type: "userMessage",
    id: "user-1"
  }, "turn-1");
  const tool = mapThreadItemEvent({
    type: "commandExecution",
    id: "cmd-1",
    command: "dir"
  }, "turn-1");

  assert.equal(assistant.kind, "assistant_output");
  assert.equal(assistant.payload.turnId, "turn-1");
  assert.equal(user, null);
  assert.equal(tool.kind, "tool_result");
  assert.equal(tool.payload.turnId, "turn-1");
});

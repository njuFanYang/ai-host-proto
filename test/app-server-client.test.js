const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildApprovalSummary,
  inferApprovalActionType,
  inferApprovalRisk,
  isApprovalMethod,
  mapApprovalDecisionToRpcResult,
  mapCompletedItemEvent
} = require("../src/host/app-server-client");

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

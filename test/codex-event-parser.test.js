const test = require("node:test");
const assert = require("node:assert/strict");

const { mapCodexJsonlLine } = require("../src/host/codex-event-parser");

test("mapCodexJsonlLine maps thread.started to deferred binding", () => {
  const result = mapCodexJsonlLine(
    JSON.stringify({
      type: "thread.started",
      thread_id: "thread-123"
    })
  );

  assert.equal(result.sessionPatch.upstreamSessionId, "thread-123");
  assert.equal(result.event.kind, "session_started");
});

test("mapCodexJsonlLine maps agent messages to assistant output", () => {
  const result = mapCodexJsonlLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: "OK"
      }
    })
  );

  assert.equal(result.event.kind, "assistant_output");
  assert.equal(result.event.payload.text, "OK");
});

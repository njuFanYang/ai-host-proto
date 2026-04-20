const test = require("node:test");
const assert = require("node:assert/strict");

const { mapClaudeStreamJsonLine } = require("../src/host/claude-code-event-parser");

test("mapClaudeStreamJsonLine binds upstream session id from init event", () => {
  const result = mapClaudeStreamJsonLine(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-sess-1",
      cwd: "/tmp",
      tools: ["Bash"],
      model: "claude-opus-4-7"
    })
  );

  assert.equal(result.sessionPatch.upstreamSessionId, "claude-sess-1");
  assert.equal(result.sessionPatch.registrationState, "bound");
  assert.equal(result.event.kind, "session_started");
});

test("mapClaudeStreamJsonLine maps assistant text blocks to assistant_output", () => {
  const result = mapClaudeStreamJsonLine(
    JSON.stringify({
      type: "assistant",
      session_id: "claude-sess-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    })
  );

  assert.equal(result.event.kind, "assistant_output");
  assert.equal(result.event.payload.text, "hello");
});

test("mapClaudeStreamJsonLine maps tool_use blocks to tool_call", () => {
  const result = mapClaudeStreamJsonLine(
    JSON.stringify({
      type: "assistant",
      session_id: "claude-sess-1",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls" }
        }]
      }
    })
  );

  assert.equal(result.event.kind, "tool_call");
  assert.equal(result.event.payload.name, "Bash");
  assert.equal(result.event.payload.toolUseId, "toolu_1");
  assert.deepEqual(result.event.payload.input, { command: "ls" });
});

test("mapClaudeStreamJsonLine maps user tool_result blocks", () => {
  const result = mapClaudeStreamJsonLine(
    JSON.stringify({
      type: "user",
      session_id: "claude-sess-1",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "file contents",
          is_error: false
        }]
      }
    })
  );

  assert.equal(result.event.kind, "tool_result");
  assert.equal(result.event.payload.toolUseId, "toolu_1");
  assert.equal(result.event.payload.isError, false);
});

test("mapClaudeStreamJsonLine maps successful result to turn_completed", () => {
  const result = mapClaudeStreamJsonLine(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1234,
      num_turns: 2,
      result: "done",
      session_id: "claude-sess-1",
      total_cost_usd: 0.01
    })
  );

  assert.equal(result.event.kind, "turn_completed");
  assert.equal(result.sessionPatch.status, "running");
});

test("mapClaudeStreamJsonLine maps error result to error event", () => {
  const result = mapClaudeStreamJsonLine(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "claude-sess-1"
    })
  );

  assert.equal(result.event.kind, "error");
  assert.equal(result.sessionPatch.status, "failed");
});

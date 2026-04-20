function mapClaudeStreamJsonLine(line) {
  const parsed = JSON.parse(line);
  const type = parsed.type;

  if (type === "system" && parsed.subtype === "init") {
    const patch = { registrationState: "bound" };
    if (parsed.session_id) {
      patch.upstreamSessionId = parsed.session_id;
    }
    return {
      sessionPatch: patch,
      event: {
        kind: "session_started",
        controllability: "controllable",
        payload: parsed
      }
    };
  }

  if (type === "system") {
    return {
      event: {
        kind: "system_event",
        controllability: "observed",
        payload: parsed
      }
    };
  }

  if (type === "assistant") {
    return mapAssistantMessage(parsed);
  }

  if (type === "user") {
    return mapUserMessage(parsed);
  }

  if (type === "result") {
    const isError = Boolean(parsed.is_error);
    return {
      sessionPatch: { status: isError ? "failed" : "running" },
      event: {
        kind: isError ? "error" : "turn_completed",
        controllability: "controllable",
        payload: parsed
      }
    };
  }

  return {
    event: {
      kind: "raw_event",
      controllability: "observed",
      payload: parsed
    }
  };
}

function mapAssistantMessage(parsed) {
  const message = parsed.message || {};
  const blocks = Array.isArray(message.content) ? message.content : [];

  if (blocks.length === 1) {
    return { event: mapAssistantBlock(blocks[0], parsed) };
  }

  return {
    event: {
      kind: "assistant_message",
      controllability: "controllable",
      payload: {
        blocks,
        raw: parsed
      }
    }
  };
}

function mapAssistantBlock(block, parsed) {
  if (!block || typeof block !== "object") {
    return {
      kind: "assistant_message",
      controllability: "controllable",
      payload: { block, raw: parsed }
    };
  }

  if (block.type === "text") {
    return {
      kind: "assistant_output",
      controllability: "controllable",
      payload: {
        text: block.text || "",
        raw: parsed
      }
    };
  }

  if (block.type === "thinking") {
    return {
      kind: "assistant_thinking",
      controllability: "observed",
      payload: {
        text: block.thinking || block.text || "",
        raw: parsed
      }
    };
  }

  if (block.type === "tool_use") {
    return {
      kind: "tool_call",
      controllability: "controllable",
      payload: {
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        raw: parsed
      }
    };
  }

  return {
    kind: "assistant_message",
    controllability: "controllable",
    payload: { block, raw: parsed }
  };
}

function mapUserMessage(parsed) {
  const message = parsed.message || {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const first = blocks[0] || null;

  if (first && first.type === "tool_result") {
    return {
      event: {
        kind: "tool_result",
        controllability: "controllable",
        payload: {
          toolUseId: first.tool_use_id,
          isError: Boolean(first.is_error),
          content: first.content,
          raw: parsed
        }
      }
    };
  }

  if (first && first.type === "text") {
    return {
      event: {
        kind: "user_input_echo",
        controllability: "observed",
        payload: {
          text: first.text || "",
          raw: parsed
        }
      }
    };
  }

  return {
    event: {
      kind: "raw_user_message",
      controllability: "observed",
      payload: parsed
    }
  };
}

module.exports = {
  mapClaudeStreamJsonLine
};

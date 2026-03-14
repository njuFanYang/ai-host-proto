function mapCodexJsonlLine(line) {
  const parsed = JSON.parse(line);
  const type = parsed.type;

  if (type === "thread.started") {
    return {
      sessionPatch: {
        upstreamSessionId: parsed.thread_id,
        registrationState: "bound"
      },
      event: {
        kind: "session_started",
        controllability: "controllable",
        payload: parsed
      }
    };
  }

  if (type === "turn.started") {
    return {
      event: {
        kind: "turn_started",
        controllability: "controllable",
        payload: parsed
      }
    };
  }

  if (type === "turn.completed") {
    return {
      event: {
        kind: "turn_completed",
        controllability: "controllable",
        payload: parsed
      }
    };
  }

  if (type === "turn.failed") {
    return {
      sessionPatch: { status: "failed" },
      event: {
        kind: "error",
        controllability: "controllable",
        payload: parsed
      }
    };
  }

  if (type === "item.completed") {
    return mapItemCompleted(parsed);
  }

  return {
    event: {
      kind: "raw_event",
      controllability: "controllable",
      payload: parsed
    }
  };
}

function mapItemCompleted(parsed) {
  const item = parsed.item || {};

  if (item.type === "agent_message") {
    return {
      event: {
        kind: "assistant_output",
        controllability: "controllable",
        payload: {
          text: item.text || "",
          raw: parsed
        }
      }
    };
  }

  return {
    event: {
      kind: "tool_result",
      controllability: "controllable",
      payload: parsed
    }
  };
}

module.exports = {
  mapCodexJsonlLine
};

const EVENT_WINDOW = 5;
const ASSISTANT_TEXT_LIMIT = 800;

function initialCardState({ hostSessionId, cwd, startedAt, title }) {
  return {
    hostSessionId,
    cwd: cwd || null,
    startedAt: startedAt || null,
    title: title || null,
    status: "running",
    lastAssistantText: "",
    lastAssistantAt: null,
    recentEvents: [],
    pendingApproval: null,
    endedAt: null,
    endedCode: null,
    failureReason: null,
    toolCount: 0
  };
}

function ingestEvent(state, event) {
  if (!event || !event.kind) return state;
  const kind = event.kind;
  const payload = event.payload || {};
  const ts = event.timestamp || new Date().toISOString();

  if (kind === "assistant_output") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text) {
      state.lastAssistantText = text;
      state.lastAssistantAt = ts;
    }
    return state;
  }

  if (kind === "tool_call") {
    state.toolCount += 1;
    pushRecent(state, { kind, summary: formatToolCallCompact(payload), ts });
    return state;
  }

  if (kind === "tool_result") {
    if (payload.isError) {
      pushRecent(state, { kind, summary: `❌ ${truncate(summarizeContent(payload.content), 60)}`, ts });
    }
    return state;
  }

  if (kind === "error") {
    pushRecent(state, { kind, summary: `⚠️ ${truncate(payload.message || safeJson(payload), 80)}`, ts });
    return state;
  }

  if (kind === "session_ended") {
    state.status = payload.code === 0 ? "ended" : "failed";
    state.endedAt = ts;
    state.endedCode = payload.code;
    return state;
  }

  if (kind === "session_started") {
    state.startedAt = state.startedAt || ts;
    return state;
  }

  return state;
}

function ingestSessionUpdate(state, session) {
  if (!session) return state;
  if (state.status === "ended" || state.status === "failed") {
    return state; // do not revive a terminated session
  }
  if (session.status === "waiting_approval") {
    state.status = "waiting_approval";
  } else if (session.status === "running" && state.status !== "waiting_approval") {
    state.status = "running";
  } else if (session.status === "failed") {
    state.status = "failed";
    state.failureReason = session.failureReason || null;
  } else if (session.status === "ended") {
    state.status = "ended";
  }
  return state;
}

function ingestApproval(state, approvalMessage) {
  const approval = approvalMessage && approvalMessage.approval;
  if (!approval) return state;

  if (approvalMessage.action === "created" && approval.status === "pending") {
    state.pendingApproval = {
      requestId: approval.requestId,
      riskLevel: approval.riskLevel,
      actionType: approval.actionType,
      summary: approval.summary,
      rawRequest: approval.rawRequest,
      createdAt: approval.createdAt
    };
    state.status = "waiting_approval";
    return state;
  }

  if (approvalMessage.action === "resolved") {
    if (state.pendingApproval && state.pendingApproval.requestId === approval.requestId) {
      state.pendingApproval = null;
    }
    if (state.status === "waiting_approval") {
      state.status = state.endedAt ? (state.endedCode === 0 ? "ended" : "failed") : "running";
    }
    return state;
  }

  return state;
}

function buildSessionCard(state) {
  const header = {
    template: headerColor(state),
    title: {
      tag: "plain_text",
      content: buildTitle(state)
    }
  };

  const elements = [];

  elements.push({
    tag: "div",
    fields: buildHeaderFields(state).map((pair) => ({
      is_short: true,
      text: { tag: "lark_md", content: `**${pair.label}**\n${pair.value}` }
    }))
  });

  if (state.pendingApproval) {
    elements.push({ tag: "hr" });
    elements.push(...buildApprovalBlock(state));
  }

  if (state.lastAssistantText) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: truncate(state.lastAssistantText, ASSISTANT_TEXT_LIMIT) }
    });
  }

  if (state.recentEvents.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: state.recentEvents
          .slice(-EVENT_WINDOW)
          .map((e) => `• ${escape(e.summary)}`)
          .join("\n")
      }
    });
  }

  elements.push({ tag: "hr" });
  elements.push(buildActionBlock(state));

  return {
    config: { wide_screen_mode: true },
    header,
    elements
  };
}

function buildHeaderFields(state) {
  const fields = [];
  fields.push({ label: "status", value: `\`${state.status}\`` });
  if (state.cwd) {
    fields.push({ label: "cwd", value: `\`${truncate(state.cwd, 60)}\`` });
  }
  if (state.toolCount > 0) {
    fields.push({ label: "tool calls", value: `\`${state.toolCount}\`` });
  }
  if (state.endedAt) {
    fields.push({ label: "ended", value: state.endedCode == null ? "—" : `\`exit ${state.endedCode}\`` });
  }
  return fields;
}

function buildApprovalBlock(state) {
  const approval = state.pendingApproval;
  const raw = approval.rawRequest || {};
  const lines = [
    `**🔔 需要审批** · risk=\`${approval.riskLevel || "medium"}\``,
    `${escape(approval.summary || approval.actionType || "")}`
  ];
  if (raw.tool_name) {
    lines.push(`tool: \`${raw.tool_name}\``);
  }
  if (raw.tool_input) {
    const inp = typeof raw.tool_input === "string" ? raw.tool_input : safeJson(raw.tool_input);
    lines.push(`input: \`${truncate(inp, 240)}\``);
  }

  return [
    { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "Approve" },
          type: "primary",
          value: {
            cmd: "approval_decision",
            decision: "approve",
            requestId: approval.requestId,
            hostSessionId: state.hostSessionId
          }
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "Deny" },
          type: "danger",
          value: {
            cmd: "approval_decision",
            decision: "deny",
            requestId: approval.requestId,
            hostSessionId: state.hostSessionId
          }
        }
      ]
    }
  ];
}

function buildActionBlock(state) {
  const running = state.status !== "ended" && state.status !== "failed";
  const actions = [];

  if (running) {
    actions.push({
      tag: "button",
      text: { tag: "plain_text", content: "Stop" },
      type: "danger",
      value: { cmd: "stop_session", hostSessionId: state.hostSessionId }
    });
  }

  actions.push({
    tag: "button",
    text: { tag: "plain_text", content: "Detach" },
    type: "default",
    value: { cmd: "detach_binding", hostSessionId: state.hostSessionId }
  });

  actions.push({
    tag: "button",
    text: { tag: "plain_text", content: "Log" },
    type: "default",
    value: { cmd: "full_log", hostSessionId: state.hostSessionId }
  });

  return { tag: "action", actions };
}

function buildTitle(state) {
  const emoji = statusEmoji(state.status);
  const id = shortId(state.hostSessionId);
  if (state.title) {
    return `${emoji} ${truncate(state.title, 50)} · ${id}`;
  }
  return `${emoji} Claude session · ${id}`;
}

function statusEmoji(status) {
  if (status === "running") return "🟢";
  if (status === "waiting_approval") return "🟡";
  if (status === "ended") return "⚪";
  if (status === "failed") return "🔴";
  return "⚫";
}

function headerColor(state) {
  if (state.pendingApproval) return "orange";
  if (state.status === "running") return "blue";
  if (state.status === "waiting_approval") return "orange";
  if (state.status === "ended") return "grey";
  if (state.status === "failed") return "red";
  return "grey";
}

function pushRecent(state, entry) {
  state.recentEvents.push(entry);
  if (state.recentEvents.length > EVENT_WINDOW * 3) {
    state.recentEvents.splice(0, state.recentEvents.length - EVENT_WINDOW * 3);
  }
}

function formatToolCallCompact(payload) {
  const name = payload.name || "tool";
  const input = payload.input || {};

  if (name === "Bash" && typeof input.command === "string") {
    return `🔧 \`${truncate(input.command, 80)}\``;
  }
  if ((name === "Read" || name === "Grep" || name === "Glob" || name === "LS") && typeof input.file_path === "string") {
    return `📖 ${name} \`${shortPath(input.file_path)}\``;
  }
  if ((name === "Write" || name === "Edit" || name === "NotebookEdit") && typeof input.file_path === "string") {
    return `✏️ ${name} \`${shortPath(input.file_path)}\``;
  }
  if (name === "WebFetch" && typeof input.url === "string") {
    return `🌐 \`${truncate(input.url, 80)}\``;
  }
  if (name === "TodoWrite") {
    return "📝 更新 todos";
  }
  if (name === "Task" || name === "Agent") {
    const desc = typeof input.description === "string" ? input.description : name;
    return `🤖 ${truncate(desc, 80)}`;
  }
  return `🔧 ${name}`;
}

function summarizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : safeJson(block)))
      .join(" ");
  }
  return safeJson(content);
}

function shortId(id) {
  if (!id) return "";
  return String(id).replace(/^host-cli-/, "").slice(0, 8);
}

function shortPath(p) {
  const s = String(p || "");
  if (s.length <= 40) return s;
  const parts = s.split(/[\\/]/);
  if (parts.length <= 3) return truncate(s, 40);
  return `…${parts.slice(-2).join("/")}`;
}

function safeJson(value) {
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function truncate(text, max) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function escape(text) {
  return String(text == null ? "" : text).replace(/`/g, "\\`");
}

module.exports = {
  initialCardState,
  ingestEvent,
  ingestSessionUpdate,
  ingestApproval,
  buildSessionCard,
  formatToolCallCompact,
  statusEmoji,
  shortId
};

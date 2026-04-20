const {
  initialCardState,
  ingestEvent,
  ingestSessionUpdate,
  ingestApproval,
  buildSessionCard
} = require("./session-card");

const DEFAULT_DEBOUNCE_MS = 300;

class FeishuOutboundDispatcher {
  constructor(options) {
    this.client = options.client;
    this.bindingRegistry = options.bindingRegistry;
    this.sessionRegistry = options.sessionRegistry;
    this.logger = options.logger || console;
    this.debounceMs = options.debounceMs != null ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
    this.unsubscribe = null;
    this.states = new Map();        // hostSessionId → state
    this.messageIds = new Map();    // hostSessionId → feishu card message_id
    this.flushTimers = new Map();   // hostSessionId → timeout handle
    this.flushPromises = new Map(); // hostSessionId → Promise (serialize flushes)
  }

  start() {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.sessionRegistry.subscribe((msg) => {
      void this.dispatch(msg);
    });
  }

  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
  }

  async dispatch(msg) {
    try {
      if (!msg || !msg.hostSessionId) {
        return;
      }

      const binding = this.findBinding(msg.hostSessionId);
      if (!binding) {
        return;
      }

      const state = this.ensureState(msg.hostSessionId, binding);

      if (msg.type === "event") {
        ingestEvent(state, msg.event);
      } else if (msg.type === "session") {
        ingestSessionUpdate(state, msg.session);
      } else if (msg.type === "approval") {
        ingestApproval(state, msg);
      } else {
        return;
      }

      this.scheduleFlush(msg.hostSessionId, binding);
    } catch (error) {
      this.logger.error(`[feishu] outbound dispatch error: ${error.message}`);
    }
  }

  ensureState(hostSessionId, binding) {
    let state = this.states.get(hostSessionId);
    if (state) {
      return state;
    }
    const session = this.sessionRegistry.getSession(hostSessionId);
    state = initialCardState({
      hostSessionId,
      cwd: session ? session.workspaceRoot : (binding && binding.metadata && binding.metadata.cwd) || null,
      startedAt: session ? session.createdAt : null,
      title: binding && binding.metadata ? binding.metadata.title || null : null
    });
    this.states.set(hostSessionId, state);
    return state;
  }

  scheduleFlush(hostSessionId, binding) {
    const existing = this.flushTimers.get(hostSessionId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.flushTimers.delete(hostSessionId);
      void this.flush(hostSessionId, binding);
    }, this.debounceMs);

    this.flushTimers.set(hostSessionId, timer);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async flush(hostSessionId, binding) {
    const prev = this.flushPromises.get(hostSessionId);
    const run = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(() =>
      this.flushOnce(hostSessionId, binding)
    );
    this.flushPromises.set(hostSessionId, run);
    try {
      await run;
    } finally {
      if (this.flushPromises.get(hostSessionId) === run) {
        this.flushPromises.delete(hostSessionId);
      }
    }
  }

  async flushOnce(hostSessionId, binding) {
    const state = this.states.get(hostSessionId);
    if (!state) {
      return;
    }

    const activeBinding = this.findBinding(hostSessionId) || binding;
    if (!activeBinding) {
      return;
    }

    const card = buildSessionCard(state);
    const messageId = this.messageIds.get(hostSessionId);

    try {
      if (messageId) {
        await this.client.updateCard(messageId, card);
      } else {
        const response = await this.sendToBinding(activeBinding, { card });
        const newId = extractMessageId(response);
        if (newId) {
          this.messageIds.set(hostSessionId, newId);
        }
      }
    } catch (error) {
      this.logger.warn(`[feishu] session card update failed: ${error.message}`);
      if (messageId && isStaleMessageError(error)) {
        this.messageIds.delete(hostSessionId);
      }
    }
  }

  async sendToBinding(binding, options) {
    if (typeof this.client.sendToBinding === "function") {
      return this.client.sendToBinding(binding, options);
    }
    const chatId = (binding.metadata && binding.metadata.chatId) || binding.conversationId;
    const anchor = binding.metadata && binding.metadata.anchorMessageId;
    if (options.text != null) {
      if (anchor && typeof this.client.replyText === "function") {
        return this.client.replyText(anchor, options.text);
      }
      return this.client.sendText(chatId, options.text);
    }
    if (options.card != null) {
      if (anchor && typeof this.client.replyCard === "function") {
        return this.client.replyCard(anchor, options.card);
      }
      return this.client.sendCard(chatId, options.card);
    }
    throw new Error("sendToBinding requires text or card");
  }

  findBinding(hostSessionId) {
    const bindings = this.bindingRegistry.listBindings({ channel: "feishu" });
    return bindings.find((binding) => binding.activeHostSessionId === hostSessionId && binding.mode !== "watch-off") || null;
  }

  async emitFullLog(binding, hostSessionId) {
    const events = this.sessionRegistry.listEvents(hostSessionId);
    if (!events.length) {
      return this.sendToBinding(binding, { text: `session ${hostSessionId} 没有事件` });
    }
    const lines = events.slice(-40).map((ev) => formatLogLine(ev));
    const text = truncate(lines.join("\n"), 3500);
    return this.sendToBinding(binding, { text });
  }
}

function extractMessageId(response) {
  if (!response || typeof response !== "object") return null;
  const data = response.data || response;
  if (data && typeof data === "object" && data.message_id) return data.message_id;
  return null;
}

function isStaleMessageError(error) {
  const code = error && error.response && error.response.data && error.response.data.code;
  return code === 230020 || code === 230001; // not found / message deleted
}

function formatLogLine(ev) {
  const ts = ev.timestamp || "";
  const kind = ev.kind || "event";
  const payload = ev.payload || {};
  let summary = "";
  if (kind === "assistant_output") summary = truncate(payload.text || "", 120);
  else if (kind === "tool_call") summary = `${payload.name} ${truncate(safeJson(payload.input), 80)}`;
  else if (kind === "tool_result") summary = payload.isError ? "error" : "ok";
  else if (kind === "error") summary = truncate(payload.message || safeJson(payload), 120);
  else summary = truncate(safeJson(payload), 120);
  return `[${ts}] ${kind}  ${summary}`;
}

function safeJson(value) {
  if (value == null) return "";
  try { return JSON.stringify(value); } catch (_err) { return String(value); }
}

function truncate(text, max) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

module.exports = {
  FeishuOutboundDispatcher
};

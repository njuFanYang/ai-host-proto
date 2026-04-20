const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FeishuOutboundDispatcher } = require("../src/host/channels/feishu/outbound");
const { ChannelBindingRegistry } = require("../src/host/channel-binding-registry");
const { SessionRegistry } = require("../src/host/session-registry");

function createStubClient() {
  return {
    calls: [],
    async sendText(chatId, text) {
      this.calls.push({ kind: "text", chatId, text });
      return { data: { message_id: `msg-${this.calls.length}` } };
    },
    async sendCard(chatId, card) {
      this.calls.push({ kind: "card", chatId, card });
      return { data: { message_id: `card-${this.calls.length}` } };
    },
    async replyText(messageId, text) {
      this.calls.push({ kind: "reply_text", messageId, text });
      return { data: { message_id: `reply-${this.calls.length}` } };
    },
    async replyCard(messageId, card) {
      this.calls.push({ kind: "reply_card", messageId, card });
      return { data: { message_id: `reply-card-${this.calls.length}` } };
    },
    async updateCard(messageId, card) {
      this.calls.push({ kind: "card_update", messageId, card });
      return { data: { message_id: messageId } };
    },
    async sendToBinding(binding, options) {
      const anchor = binding && binding.metadata && binding.metadata.anchorMessageId;
      const chatId = (binding && binding.metadata && binding.metadata.chatId) || binding.conversationId;
      if (options.text != null) {
        return anchor ? this.replyText(anchor, options.text) : this.sendText(chatId, options.text);
      }
      if (options.card != null) {
        return anchor ? this.replyCard(anchor, options.card) : this.sendCard(chatId, options.card);
      }
      throw new Error("stub sendToBinding requires text or card");
    }
  };
}

function createHarness(options = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const sessionRegistry = new SessionRegistry({ projectRoot });
  const bindingRegistry = new ChannelBindingRegistry({ projectRoot });
  const client = createStubClient();
  const dispatcher = new FeishuOutboundDispatcher({
    client,
    bindingRegistry,
    sessionRegistry,
    debounceMs: options.debounceMs != null ? options.debounceMs : 10,
    logger: { log() {}, warn() {}, error() {} }
  });

  const session = sessionRegistry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot,
    runtime: { mode: "stream-json" }
  });
  sessionRegistry.updateSession(session.hostSessionId, { status: "running" });

  bindingRegistry.attachBinding({
    channel: "feishu",
    conversationId: options.conversationId || "oc_chat",
    conversationType: "p2p",
    activeHostSessionId: session.hostSessionId,
    mode: "control",
    pinnedSessionIds: [session.hostSessionId],
    activeControllerId: "channel:feishu:oc_chat",
    activeControllerType: "channel:feishu",
    metadata: options.bindingMetadata || {}
  });

  dispatcher.start();
  return { projectRoot, sessionRegistry, bindingRegistry, session, client, dispatcher };
}

function waitForCall(client, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const match = client.calls.find(predicate);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timeout waiting for feishu call"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("sends initial session card after first event", async () => {
  const harness = createHarness();
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "hello from claude" }
    });

    const sent = await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");
    assert.ok(sent.card && sent.card.elements, "card has elements");
    assert.match(JSON.stringify(sent.card), /hello from claude/);
  } finally {
    harness.dispatcher.stop();
  }
});

test("card title uses binding metadata.title when available", async () => {
  const harness = createHarness({
    bindingMetadata: { title: "帮我看看 package.json" }
  });
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "ok" }
    });
    const sent = await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");
    const title = sent.card.header.title.content;
    assert.match(title, /帮我看看 package\.json/);
  } finally {
    harness.dispatcher.stop();
  }
});

test("assistant_output does not duplicate into recent events", async () => {
  const harness = createHarness();
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "single reply" }
    });
    await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");

    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "tool_call",
      controllability: "controllable",
      payload: { name: "Read", input: { file_path: "/tmp/x" } }
    });
    const upd = await waitForCall(harness.client, (c) => c.kind === "card_update");
    const serialized = JSON.stringify(upd.card);
    const occurrences = (serialized.match(/single reply/g) || []).length;
    assert.equal(occurrences, 1, `assistant output appears once, got ${occurrences}`);
  } finally {
    harness.dispatcher.stop();
  }
});

test("updates existing card in place instead of sending new one", async () => {
  const harness = createHarness();
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "first" }
    });
    await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");

    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "tool_call",
      controllability: "controllable",
      payload: { name: "Bash", input: { command: "ls" } }
    });

    const updated = await waitForCall(harness.client, (c) => c.kind === "card_update");
    assert.match(updated.messageId, /^card-\d+$|^reply-card-\d+$/);
    assert.match(JSON.stringify(updated.card), /🔧/);
    // should still contain assistant text
    assert.match(JSON.stringify(updated.card), /first/);

    // No second fresh card was sent.
    const cardSends = harness.client.calls.filter((c) => c.kind === "card" || c.kind === "reply_card");
    assert.equal(cardSends.length, 1);
  } finally {
    harness.dispatcher.stop();
  }
});

test("debounces multiple rapid events into one update", async () => {
  const harness = createHarness({ debounceMs: 50 });
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "msg-1" }
    });
    await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");

    for (let i = 0; i < 5; i += 1) {
      harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
        kind: "tool_call",
        controllability: "controllable",
        payload: { name: "Read", input: { file_path: `/tmp/${i}.txt` } }
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const updates = harness.client.calls.filter((c) => c.kind === "card_update");
    // debounce collapses rapid events; expect 1 update, not 5
    assert.ok(updates.length <= 2, `expected ≤2 updates, got ${updates.length}`);
  } finally {
    harness.dispatcher.stop();
  }
});

test("session card includes approval block with buttons when pending", async () => {
  const harness = createHarness();
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "preparing" }
    });
    await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");

    const approval = harness.sessionRegistry.createApproval(harness.session.hostSessionId, {
      riskLevel: "high",
      actionType: "Bash",
      summary: "rm -rf /tmp/x",
      rawRequest: { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }
    });

    const updated = await waitForCall(harness.client, (c) =>
      c.kind === "card_update" && JSON.stringify(c.card).includes("Approve")
    );

    const json = JSON.stringify(updated.card);
    assert.match(json, /Approve/);
    assert.match(json, /Deny/);
    assert.match(json, new RegExp(approval.requestId));
    assert.match(json, /waiting_approval/);
  } finally {
    harness.dispatcher.stop();
  }
});

test("approval resolved collapses back to normal card", async () => {
  const harness = createHarness();
  try {
    const approval = harness.sessionRegistry.createApproval(harness.session.hostSessionId, {
      riskLevel: "high",
      actionType: "Bash",
      summary: "cmd"
    });
    await waitForCall(harness.client, (c) =>
      c.kind === "card" || c.kind === "reply_card"
    );

    harness.sessionRegistry.resolveApproval(approval.requestId, {
      decision: "approve",
      decidedBy: "human"
    });

    const updated = await waitForCall(harness.client, (c) =>
      c.kind === "card_update" && !JSON.stringify(c.card).includes("Approve")
    );
    assert.ok(updated);
  } finally {
    harness.dispatcher.stop();
  }
});

test("uses reply API when binding has anchorMessageId", async () => {
  const harness = createHarness({
    conversationId: "oc_chat:om_root_X",
    bindingMetadata: { chatId: "oc_chat", anchorMessageId: "om_root_X" }
  });
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "threaded" }
    });

    const sent = await waitForCall(harness.client, (c) => c.kind === "reply_card" || c.kind === "card");
    assert.equal(sent.kind, "reply_card");
    assert.equal(sent.messageId, "om_root_X");
  } finally {
    harness.dispatcher.stop();
  }
});

test("session ended without output still produces a final card update", async () => {
  const harness = createHarness();
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "working" }
    });
    await waitForCall(harness.client, (c) => c.kind === "card" || c.kind === "reply_card");

    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "session_ended",
      controllability: "observed",
      payload: { code: 0 }
    });

    const updated = await waitForCall(harness.client, (c) =>
      c.kind === "card_update" && /ended/.test(JSON.stringify(c.card))
    );
    assert.ok(updated);
  } finally {
    harness.dispatcher.stop();
  }
});

test("emitFullLog sends a log text message to binding", async () => {
  const harness = createHarness();
  try {
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "assistant_output",
      controllability: "controllable",
      payload: { text: "first reply" }
    });
    harness.sessionRegistry.appendEvent(harness.session.hostSessionId, {
      kind: "tool_call",
      controllability: "controllable",
      payload: { name: "Bash", input: { command: "ls" } }
    });

    const binding = harness.bindingRegistry.getBinding("feishu", "oc_chat");
    await harness.dispatcher.emitFullLog(binding, harness.session.hostSessionId);

    const logText = harness.client.calls.find((c) => c.kind === "text" || c.kind === "reply_text");
    assert.ok(logText);
    assert.match(logText.text, /assistant_output/);
    assert.match(logText.text, /tool_call/);
  } finally {
    harness.dispatcher.stop();
  }
});

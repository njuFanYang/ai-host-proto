const test = require("node:test");
const assert = require("node:assert/strict");

const { FeishuInboundGateway, extractText, stripMentions } = require("../src/host/channels/feishu/inbound");

test("extractText unwraps text message content", () => {
  const text = extractText({
    message_type: "text",
    content: JSON.stringify({ text: "hello" })
  });
  assert.equal(text, "hello");
});

test("extractText strips @ mentions", () => {
  const text = extractText({
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 ping" })
  });
  assert.equal(text, "ping");
});

test("stripMentions removes inline user tokens", () => {
  assert.equal(stripMentions("@_user_42 go"), "go");
});

test("FeishuInboundGateway routes text to channelBindingService in control mode", async () => {
  const calls = [];
  const channelBindingService = {
    sessionRegistry: { getSession: () => ({ hostSessionId: "host-1", status: "running" }) },
    getBinding: () => ({ activeHostSessionId: "host-1", mode: "control" }),
    sendBoundMessage: async (channel, conversationId, text, meta) => {
      calls.push({ channel, conversationId, text, meta });
      return { ok: true };
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" })
    },
    sender: { sender_id: { open_id: "ou_1" } }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "feishu");
  assert.equal(calls[0].conversationId, "oc_1");
  assert.equal(calls[0].text, "hello");
  assert.equal(calls[0].meta.channelUserId, "ou_1");
});

test("FeishuInboundGateway detaches stale binding and re-provisions when session is gone", async () => {
  const detachCalls = [];
  const attachCalls = [];
  const sendCalls = [];
  const sessionStore = new Map();
  const channelBindingService = {
    sessionRegistry: {
      getSession: (id) => sessionStore.get(id) || null,
      listSessions: () => Array.from(sessionStore.values()).reverse()
    },
    getBinding: () => ({ activeHostSessionId: "host-missing", mode: "control" }),
    sendBoundMessage: async () => {
      sendCalls.push(1);
      throw new Error("should not be called");
    },
    detachBinding: (channel, conversationId, input) => {
      detachCalls.push({ channel, conversationId, input });
      return { ok: true };
    },
    attachBinding: (channel, conversationId, input) => {
      attachCalls.push({ channel, conversationId, input });
      return { ok: true };
    }
  };

  const managerCalls = [];
  const manager = {
    launchCliSession: async (input) => {
      managerCalls.push(input);
      sessionStore.set("host-new", { hostSessionId: "host-new", status: "running" });
      return { record: sessionStore.get("host-new"), terminalLaunchInfo: null };
    }
  };

  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    autoSession: { cwd: "E:/workspace" },
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_stale",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hi again" })
    },
    sender: { sender_id: { open_id: "ou_1" } }
  });

  assert.equal(detachCalls.length, 1);
  assert.equal(detachCalls[0].conversationId, "oc_stale");
  assert.equal(managerCalls.length, 1);
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].input.hostSessionId, "host-new");
  assert.equal(sendCalls.length, 0);
});

test("FeishuInboundGateway ignores unbound chats when auto-session disabled", async () => {
  let called = false;
  const channelBindingService = {
    getBinding: () => null,
    sendBoundMessage: async () => {
      called = true;
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_unknown",
      message_type: "text",
      content: JSON.stringify({ text: "hello" })
    },
    sender: {}
  });

  assert.equal(called, false);
});

test("FeishuInboundGateway auto-provisions session and binding when configured", async () => {
  const sessions = [];
  const bindings = [];
  const sessionRegistry = {
    listSessions: () => sessions.slice().reverse()
  };
  const channelBindingService = {
    sessionRegistry,
    getBinding: () => null,
    sendBoundMessage: async () => {
      throw new Error("should not be called when no binding exists");
    },
    attachBinding: (channel, conversationId, input) => {
      const record = { channel, conversationId, ...input };
      bindings.push(record);
      return record;
    }
  };

  const managerCalls = [];
  const manager = {
    launchCliSession: async (input) => {
      managerCalls.push(input);
      sessions.push({ hostSessionId: "host-auto-1", status: "running", runtime: { mode: "stream-json" } });
      return { record: sessions[sessions.length - 1], terminalLaunchInfo: null };
    }
  };

  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    autoSession: { cwd: "E:/workspace", permissionMode: "default" },
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_new",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "start something" })
    },
    sender: { sender_id: { open_id: "ou_user" } }
  });

  assert.equal(managerCalls.length, 1);
  assert.equal(managerCalls[0].cwd, "E:/workspace");
  assert.equal(managerCalls[0].prompt, "start something");
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].conversationId, "oc_new");
  assert.equal(bindings[0].hostSessionId, "host-auto-1");
  assert.equal(bindings[0].mode, "control");
  assert.equal(bindings[0].metadata.autoProvisioned, true);
});

test("FeishuInboundGateway debounces concurrent auto-provision for the same chat", async () => {
  const sessions = [];
  const channelBindingService = {
    sessionRegistry: { listSessions: () => sessions.slice().reverse() },
    getBinding: () => null,
    sendBoundMessage: async () => {},
    attachBinding: () => ({})
  };

  let launches = 0;
  const manager = {
    launchCliSession: async () => {
      launches += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      sessions.push({ hostSessionId: `host-${launches}`, status: "running", runtime: {} });
      return {};
    }
  };

  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    autoSession: { cwd: "E:/workspace" },
    logger: { log() {}, warn() {}, error() {} }
  });

  await Promise.all([
    gateway.handleMessage({
      message: { chat_id: "oc_dup", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "a" }) },
      sender: {}
    }),
    gateway.handleMessage({
      message: { chat_id: "oc_dup", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "b" }) },
      sender: {}
    })
  ]);

  assert.equal(launches, 1);
});

test("FeishuInboundGateway resolves approvals from card actions and returns a toast", async () => {
  const resolveCalls = [];
  const approvalService = {
    resolveApproval: async (requestId, input) => {
      resolveCalls.push({ requestId, input });
      return { ok: true };
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService: {},
    approvalService,
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await gateway.handleCardAction({
    operator: { open_id: "ou_user" },
    action: {
      value: {
        action: "approval_decision",
        decision: "deny",
        requestId: "approval-1",
        hostSessionId: "host-1"
      }
    }
  });

  assert.equal(resolveCalls.length, 1);
  assert.equal(resolveCalls[0].requestId, "approval-1");
  assert.equal(resolveCalls[0].input.decision, "deny");
  assert.equal(resolveCalls[0].input.decidedBy, "human");
  assert.ok(result && result.toast);
  assert.equal(result.toast.type, "success");
});

test("FeishuInboundGateway text command /detach detaches current binding", async () => {
  const detached = [];
  const channelBindingService = {
    sessionRegistry: { getSession: () => ({ hostSessionId: "host-1", status: "running" }), listSessions: () => [] },
    getBinding: () => ({ channel: "feishu", conversationId: "oc_chat", activeHostSessionId: "host-1", mode: "control" }),
    sendBoundMessage: async () => { throw new Error("should not send"); },
    detachBinding: (channel, conversationId) => {
      detached.push({ channel, conversationId });
      return { ok: true };
    },
    attachBinding: () => { throw new Error("no attach"); }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      message_id: "om_1",
      content: JSON.stringify({ text: "/detach" })
    },
    sender: {}
  });

  assert.equal(detached.length, 1);
  assert.equal(detached[0].conversationId, "oc_chat");
});

test("FeishuInboundGateway text command /stop stops the active session", async () => {
  const stopped = [];
  const channelBindingService = {
    sessionRegistry: { getSession: () => ({}), listSessions: () => [] },
    getBinding: () => ({ channel: "feishu", conversationId: "oc_chat", activeHostSessionId: "host-1", mode: "control" }),
    sendBoundMessage: async () => {},
    attachBinding: () => { throw new Error("no attach"); }
  };
  const manager = {
    stopSession: (id) => { stopped.push(id); return true; }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      message_id: "om_1",
      content: JSON.stringify({ text: "/stop" })
    },
    sender: {}
  });

  assert.deepEqual(stopped, ["host-1"]);
});

test("FeishuInboundGateway auto-provision stores first prompt as title in binding metadata", async () => {
  const bindings = [];
  const sessionStore = new Map();
  const channelBindingService = {
    sessionRegistry: {
      getSession: (id) => sessionStore.get(id) || null,
      listSessions: () => Array.from(sessionStore.values()).reverse()
    },
    getBinding: () => null,
    sendBoundMessage: async () => {},
    attachBinding: (channel, conversationId, input) => {
      const rec = { channel, conversationId, ...input };
      bindings.push(rec);
      return rec;
    }
  };
  let hostId = 0;
  const manager = {
    launchCliSession: async () => {
      hostId += 1;
      const hostSessionId = `host-${hostId}`;
      sessionStore.set(hostSessionId, { hostSessionId });
      return { record: sessionStore.get(hostSessionId), terminalLaunchInfo: null };
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    autoSession: { cwd: "E:/workspace" },
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_new",
      chat_type: "p2p",
      message_type: "text",
      message_id: "om_root",
      content: JSON.stringify({ text: "帮我看看 package.json" })
    },
    sender: {}
  });

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].metadata.title, "帮我看看 package.json");
});

test("FeishuInboundGateway provisions separate sessions for different Feishu threads", async () => {
  const sessionStore = new Map();
  const bindings = [];
  const channelBindingService = {
    sessionRegistry: {
      getSession: (id) => sessionStore.get(id) || null,
      listSessions: () => Array.from(sessionStore.values()).reverse()
    },
    getBinding: (_channel, conversationId) => {
      return bindings.find((b) => b.conversationId === conversationId) || null;
    },
    sendBoundMessage: async () => {
      throw new Error("routed to wrong session");
    },
    attachBinding: (channel, conversationId, input) => {
      const record = { channel, conversationId, ...input };
      bindings.push(record);
      sessionStore.set(input.hostSessionId, { hostSessionId: input.hostSessionId, status: "running" });
      return record;
    }
  };

  let launchCount = 0;
  const manager = {
    launchCliSession: async () => {
      launchCount += 1;
      const hostSessionId = `host-${launchCount}`;
      sessionStore.set(hostSessionId, { hostSessionId, status: "running" });
      return { record: sessionStore.get(hostSessionId), terminalLaunchInfo: null };
    }
  };

  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    autoSession: { cwd: "E:/workspace" },
    threadIsolation: true,
    logger: { log() {}, warn() {}, error() {} }
  });

  // First root message — starts thread A.
  await gateway.handleMessage({
    message: {
      chat_id: "oc_main",
      chat_type: "p2p",
      message_type: "text",
      message_id: "om_root_A",
      content: JSON.stringify({ text: "start A" })
    },
    sender: { sender_id: { open_id: "ou_user" } }
  });

  // Second independent root message — starts thread B.
  await gateway.handleMessage({
    message: {
      chat_id: "oc_main",
      chat_type: "p2p",
      message_type: "text",
      message_id: "om_root_B",
      content: JSON.stringify({ text: "start B" })
    },
    sender: { sender_id: { open_id: "ou_user" } }
  });

  assert.equal(launchCount, 2, "two sessions should be launched");
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].conversationId, "oc_main:om_root_A");
  assert.equal(bindings[1].conversationId, "oc_main:om_root_B");
  assert.equal(bindings[0].metadata.anchorMessageId, "om_root_A");
  assert.equal(bindings[1].metadata.anchorMessageId, "om_root_B");
  assert.equal(bindings[0].metadata.chatId, "oc_main");
});

test("FeishuInboundGateway falls back to chat-level binding when threadIsolation disabled", async () => {
  const bindings = [];
  const sessionStore = new Map();
  const channelBindingService = {
    sessionRegistry: {
      getSession: (id) => sessionStore.get(id) || null,
      listSessions: () => Array.from(sessionStore.values()).reverse()
    },
    getBinding: (_channel, conversationId) => {
      return bindings.find((b) => b.conversationId === conversationId) || null;
    },
    sendBoundMessage: async () => { throw new Error("unexpected"); },
    attachBinding: (channel, conversationId, input) => {
      const rec = { channel, conversationId, ...input };
      bindings.push(rec);
      return rec;
    }
  };

  let launchCount = 0;
  const manager = {
    launchCliSession: async () => {
      launchCount += 1;
      const hostSessionId = `host-${launchCount}`;
      sessionStore.set(hostSessionId, { hostSessionId });
      return { record: sessionStore.get(hostSessionId), terminalLaunchInfo: null };
    }
  };

  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    manager,
    autoSession: { cwd: "E:/workspace" },
    threadIsolation: false,
    logger: { log() {}, warn() {}, error() {} }
  });

  await gateway.handleMessage({
    message: {
      chat_id: "oc_flat",
      chat_type: "p2p",
      message_type: "text",
      message_id: "om_1",
      content: JSON.stringify({ text: "hi" })
    },
    sender: {}
  });

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].conversationId, "oc_flat");
});

test("FeishuInboundGateway stops session when stop_session card action fires", async () => {
  const stopped = [];
  const manager = {
    stopSession: (id) => {
      stopped.push(id);
      return true;
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService: {},
    approvalService: {},
    manager,
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await gateway.handleCardAction({
    operator: { open_id: "ou_user" },
    action: {
      value: { cmd: "stop_session", hostSessionId: "host-1" }
    }
  });

  assert.deepEqual(result, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, ["host-1"]);
});

test("FeishuInboundGateway detaches binding via card action and schedules side-effect", async () => {
  const detached = [];
  const channelBindingService = {
    bindingRegistry: {
      listBindings: () => [
        { channel: "feishu", conversationId: "oc_chat", activeHostSessionId: "host-1", mode: "control" }
      ]
    },
    detachBinding: (channel, conversationId) => {
      detached.push({ channel, conversationId });
      return { ok: true };
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await gateway.handleCardAction({
    action: { value: { cmd: "detach_binding", hostSessionId: "host-1" } }
  });

  assert.deepEqual(result, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(detached, [{ channel: "feishu", conversationId: "oc_chat" }]);
});

test("FeishuInboundGateway full_log card action triggers emitFullLog", async () => {
  const logCalls = [];
  const outboundDispatcher = {
    emitFullLog: async (binding, hostSessionId) => {
      logCalls.push({ binding, hostSessionId });
    }
  };
  const channelBindingService = {
    bindingRegistry: {
      listBindings: () => [
        { channel: "feishu", conversationId: "oc_chat", activeHostSessionId: "host-1", mode: "control" }
      ]
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService,
    approvalService: {},
    outboundDispatcher,
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await gateway.handleCardAction({
    action: { value: { cmd: "full_log", hostSessionId: "host-1" } }
  });

  assert.deepEqual(result, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].hostSessionId, "host-1");
});

test("FeishuInboundGateway returns error toast when resolveApproval throws", async () => {
  const approvalService = {
    resolveApproval: async () => {
      throw new Error("boom");
    }
  };
  const gateway = new FeishuInboundGateway({
    appId: "a",
    appSecret: "b",
    channelBindingService: {},
    approvalService,
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await gateway.handleCardAction({
    action: {
      value: {
        action: "approval_decision",
        decision: "approve",
        requestId: "approval-missing"
      }
    }
  });

  assert.ok(result && result.toast);
  assert.equal(result.toast.type, "error");
});

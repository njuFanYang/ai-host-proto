const lark = require("@larksuiteoapi/node-sdk");

class FeishuInboundGateway {
  constructor(options) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.channelBindingService = options.channelBindingService;
    this.approvalService = options.approvalService;
    this.manager = options.manager || null;
    this.autoSession = options.autoSession || null;
    this.threadIsolation = options.threadIsolation !== false;
    this.logger = options.logger || console;
    this.encryptKey = options.encryptKey || undefined;
    this.verificationToken = options.verificationToken || undefined;
    this.wsClient = options.wsClient || null;
    this.eventDispatcher = options.eventDispatcher || null;
    this.onMessage = options.onMessage || null;
    this.onCardAction = options.onCardAction || null;
    this.pendingAutoSessions = new Map();
    this.outboundDispatcher = options.outboundDispatcher || null;
  }

  buildDispatcher() {
    const dispatcher = new lark.EventDispatcher({
      encryptKey: this.encryptKey,
      verificationToken: this.verificationToken,
      loggerLevel: lark.LoggerLevel.info
    });

    dispatcher.register({
      "im.message.receive_v1": async (data) => this.handleMessage(data),
      "card.action.trigger": async (data) => this.handleCardAction(data)
    });

    return dispatcher;
  }

  async start() {
    if (!this.eventDispatcher) {
      this.eventDispatcher = this.buildDispatcher();
    }

    if (!this.wsClient) {
      this.wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: lark.LoggerLevel.info
      });
    }

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.logger.log("[feishu] long-connection started, NO_PROXY=" + (process.env.NO_PROXY || "(none)"));
  }

  async stop() {
    if (this.wsClient && typeof this.wsClient.close === "function") {
      try {
        await this.wsClient.close();
      } catch (_error) {
        // ignore
      }
    }
  }

  async handleMessage(event) {
    try {
      const message = event && event.message ? event.message : {};
      const sender = event && event.sender ? event.sender : {};
      const chatId = message.chat_id;
      const chatType = message.chat_type || "p2p";
      const channelUserId = sender.sender_id ? (sender.sender_id.open_id || sender.sender_id.user_id || null) : null;
      const text = extractText(message);
      const messageId = message.message_id || null;
      const rootMessageId = message.root_id || messageId;
      const conversationId = this.threadIsolation && chatId && rootMessageId
        ? `${chatId}:${rootMessageId}`
        : chatId;

      this.logger.log(`[feishu] received message chat=${chatId} type=${chatType} user=${channelUserId} msgType=${message.message_type} textLen=${text.length} thread=${rootMessageId}`);

      if (!chatId || !text) {
        this.logger.warn(`[feishu] skipping message (chatId=${chatId} textLen=${text.length})`);
        return;
      }

      if (await this.tryHandleApprovalCommand(chatId, text, channelUserId)) {
        return;
      }

      if (await this.tryHandleSessionCommand(chatId, conversationId, text, channelUserId)) {
        return;
      }

      if (typeof this.onMessage === "function") {
        await this.onMessage({ chatId, chatType, conversationId, rootMessageId, messageId, channelUserId, text, raw: event });
        return;
      }

      const binding = this.channelBindingService.getBinding("feishu", conversationId);
      const sessionRegistry = this.channelBindingService.sessionRegistry;
      const boundSessionExists = Boolean(binding && binding.activeHostSessionId && sessionRegistry && sessionRegistry.getSession(binding.activeHostSessionId));

      if (binding && binding.mode === "control" && boundSessionExists) {
        this.logger.log(`[feishu] routing to existing session ${binding.activeHostSessionId}`);
        try {
          await this.channelBindingService.sendBoundMessage("feishu", conversationId, text, {
            channelUserId
          });
        } catch (error) {
          this.logger.error(`[feishu] sendBoundMessage failed for ${conversationId}: ${error.message}`);
        }
        return;
      }

      if (binding && !boundSessionExists) {
        this.logger.warn(`[feishu] binding for ${conversationId} pointed to missing session ${binding.activeHostSessionId}; detaching and re-provisioning`);
        try {
          this.channelBindingService.detachBinding("feishu", conversationId, {});
        } catch (detachError) {
          this.logger.warn(`[feishu] detach failed: ${detachError.message}`);
        }
      }

      if (!this.manager || !this.autoSession || !this.autoSession.cwd) {
        this.logger.warn(`[feishu] no binding for ${conversationId} and auto-session disabled (manager=${!!this.manager}, autoCwd=${this.autoSession && this.autoSession.cwd})`);
        return;
      }

      this.logger.log(`[feishu] auto-provisioning session for ${conversationId} in ${this.autoSession.cwd}`);
      await this.autoProvision({ chatId, conversationId, chatType, channelUserId, rootMessageId, firstPrompt: text });
    } catch (error) {
      this.logger.error(`[feishu] inbound handler error: ${error.message}`);
    }
  }

  async tryHandleApprovalCommand(chatId, text, channelUserId) {
    const match = /^\s*\/(approve|deny)\s+([a-z0-9-]{4,})\s*$/i.exec(text);
    if (!match) {
      return false;
    }

    const decision = match[1].toLowerCase() === "deny" ? "deny" : "approve";
    const needle = match[2].toLowerCase();

    if (!this.approvalService) {
      return false;
    }

    const approvals = this.approvalService.listApprovals({ status: "pending" });
    const target = approvals.find((a) => {
      if (!a || !a.requestId) return false;
      const id = a.requestId.toLowerCase();
      return id === needle || id.endsWith(needle);
    });

    if (!target) {
      this.logger.warn(`[feishu] /${decision} ${needle} matched no pending approval`);
      return true;
    }

    try {
      await this.approvalService.resolveApproval(target.requestId, {
        decision,
        decidedBy: "human",
        reason: `feishu_text:${channelUserId || ""}`
      });
      this.logger.log(`[feishu] approval ${target.requestId} resolved via text: ${decision}`);
    } catch (error) {
      this.logger.error(`[feishu] failed to resolve approval ${target.requestId}: ${error.message}`);
    }
    return true;
  }

  async tryHandleSessionCommand(chatId, conversationId, text, channelUserId) {
    const match = /^\s*\/(stop|detach|log|help)\s*$/i.exec(text);
    if (!match) {
      return false;
    }
    const cmd = match[1].toLowerCase();

    if (cmd === "help") {
      this.logger.log(`[feishu] /help command for ${conversationId}`);
      return true;
    }

    const binding = this.channelBindingService.getBinding("feishu", conversationId)
      || (conversationId !== chatId ? this.channelBindingService.getBinding("feishu", chatId) : null);
    if (!binding || !binding.activeHostSessionId) {
      this.logger.warn(`[feishu] /${cmd} — no active binding for ${conversationId}`);
      return true;
    }

    if (cmd === "stop") {
      if (this.manager && typeof this.manager.stopSession === "function") {
        this.manager.stopSession(binding.activeHostSessionId);
      }
      return true;
    }

    if (cmd === "detach") {
      try {
        this.channelBindingService.detachBinding(binding.channel, binding.conversationId, {});
      } catch (error) {
        this.logger.warn(`[feishu] /detach failed: ${error.message}`);
      }
      return true;
    }

    if (cmd === "log") {
      if (this.outboundDispatcher && typeof this.outboundDispatcher.emitFullLog === "function") {
        this.outboundDispatcher
          .emitFullLog(binding, binding.activeHostSessionId)
          .catch((error) => this.logger.warn(`[feishu] /log failed: ${error.message}`));
      }
      return true;
    }

    return false;
  }

  async autoProvision(input) {
    // Backwards-compat: accept either positional form or the new object form.
    const params = typeof input === "object" && input !== null && !Array.isArray(input)
      ? input
      : { chatId: arguments[0], chatType: arguments[1], channelUserId: arguments[2], firstPrompt: arguments[3] };

    const { chatId, chatType = "p2p", channelUserId, firstPrompt, rootMessageId = null } = params;
    const conversationId = params.conversationId || chatId;
    const dedupeKey = conversationId;

    if (this.pendingAutoSessions.has(dedupeKey)) {
      this.logger.log(`[feishu] auto-session already pending for ${dedupeKey}`);
      return;
    }
    this.pendingAutoSessions.set(dedupeKey, Date.now());

    try {
      const launch = this.manager.launchCliSession({
        cwd: this.autoSession.cwd,
        permissionMode: this.autoSession.permissionMode || "default",
        model: this.autoSession.model || undefined,
        prompt: firstPrompt
      });

      await Promise.race([
        launch.catch((error) => {
          this.logger.error(`[feishu] auto-session run failed for ${dedupeKey}: ${error.message}`);
        }),
        waitForNewSession(this.channelBindingService, chatType)
      ]);

      const newest = this.findNewestSession();
      if (!newest) {
        this.logger.error(`[feishu] auto-session started but no session record surfaced for ${dedupeKey}`);
        return;
      }

      this.channelBindingService.attachBinding("feishu", conversationId, {
        hostSessionId: newest.hostSessionId,
        conversationType: chatType,
        mode: "control",
        attachedBy: channelUserId || "feishu-auto",
        channelUserId,
        metadata: {
          autoProvisioned: true,
          chatId,
          anchorMessageId: rootMessageId || null,
          threadIsolation: this.threadIsolation,
          title: (firstPrompt || "").trim().slice(0, 80) || null
        }
      });

      this.logger.log(`[feishu] auto-attached ${conversationId} to session ${newest.hostSessionId}`);
    } catch (error) {
      this.logger.error(`[feishu] auto-provision failed for ${dedupeKey}: ${error.message}`);
    } finally {
      this.pendingAutoSessions.delete(dedupeKey);
    }
  }

  findNewestSession() {
    if (!this.channelBindingService || !this.channelBindingService.sessionRegistry) {
      return null;
    }
    const sessions = this.channelBindingService.sessionRegistry.listSessions();
    return sessions[0] || null;
  }

  async handleCardAction(event) {
    try {
      if (typeof this.onCardAction === "function") {
        const result = await this.onCardAction(event);
        return result || toast("info", "");
      }

      const value = event && event.action ? event.action.value : null;
      const cmd = value && (value.cmd || value.action);
      if (!value || !cmd) {
        return toast("info", "");
      }
      const operatorId = event && event.operator ? event.operator.open_id || "" : "";

      if (cmd === "approval_decision" && value.requestId) {
        const decision = value.decision === "deny" ? "deny" : "approve";
        await this.approvalService.resolveApproval(value.requestId, {
          decision,
          decidedBy: "human",
          reason: `feishu_card:${operatorId}`
        });
        return toast("success", decision === "approve" ? "已批准" : "已拒绝");
      }

      if (cmd === "detach_binding" && value.hostSessionId) {
        const binding = this.findBindingByHostSessionId(value.hostSessionId);
        if (!binding) {
          return {};
        }
        setImmediate(() => {
          try {
            this.channelBindingService.detachBinding(binding.channel, binding.conversationId, {});
          } catch (error) {
            this.logger.warn(`[feishu] detach failed: ${error.message}`);
          }
        });
        return {};
      }

      if (cmd === "full_log" && value.hostSessionId) {
        if (!this.outboundDispatcher || typeof this.outboundDispatcher.emitFullLog !== "function") {
          return {};
        }
        const binding = this.findBindingByHostSessionId(value.hostSessionId);
        if (!binding) {
          return {};
        }
        setImmediate(() => {
          this.outboundDispatcher.emitFullLog(binding, value.hostSessionId)
            .catch((error) => this.logger.warn(`[feishu] emitFullLog failed: ${error.message}`));
        });
        return {};
      }

      if (cmd === "stop_session" && value.hostSessionId) {
        if (!this.manager || typeof this.manager.stopSession !== "function") {
          return {};
        }
        setImmediate(() => {
          try {
            this.manager.stopSession(value.hostSessionId);
          } catch (error) {
            this.logger.warn(`[feishu] stopSession failed: ${error.message}`);
          }
        });
        return {};
      }

      return toast("info", "");
    } catch (error) {
      this.logger.error(`[feishu] card action error: ${error.message}`);
      return toast("error", "处理失败，请重试");
    }
  }

  findBindingByHostSessionId(hostSessionId) {
    if (!this.channelBindingService || !this.channelBindingService.bindingRegistry) {
      return null;
    }
    const bindings = this.channelBindingService.bindingRegistry.listBindings({ channel: "feishu" });
    return bindings.find((b) => b.activeHostSessionId === hostSessionId) || null;
  }
}

function toast(type, content) {
  return {
    toast: {
      type,
      content: content || ""
    }
  };
}

function waitForNewSession(channelBindingService, _chatType) {
  // Let the manager kick off the registry.createSession call before we
  // introspect listSessions. A zero-delay tick is enough because ClaudeCodeManager
  // creates the record synchronously at the top of launchStreamJsonSession.
  return new Promise((resolve) => setImmediate(resolve));
}

function extractText(message) {
  if (!message || !message.content) {
    return "";
  }

  try {
    const parsed = typeof message.content === "string" ? JSON.parse(message.content) : message.content;
    if (message.message_type === "text" && typeof parsed.text === "string") {
      return stripMentions(parsed.text);
    }

    if (message.message_type === "post" && parsed.content) {
      return flattenPost(parsed);
    }
  } catch (_error) {
    // fall through
  }

  return "";
}

function stripMentions(text) {
  return String(text).replace(/@_user_\d+\s*/g, "").trim();
}

function flattenPost(parsed) {
  const segments = [];
  const body = parsed.content || parsed;
  if (!Array.isArray(body)) {
    return "";
  }
  for (const line of body) {
    if (!Array.isArray(line)) continue;
    for (const node of line) {
      if (node && typeof node === "object" && typeof node.text === "string") {
        segments.push(node.text);
      }
    }
    segments.push("\n");
  }
  return segments.join("").trim();
}

module.exports = {
  FeishuInboundGateway,
  extractText,
  stripMentions
};

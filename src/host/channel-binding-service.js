class ChannelBindingService {
  constructor(options) {
    this.bindingRegistry = options.bindingRegistry;
    this.sessionRegistry = options.sessionRegistry;
    this.sessionControl = options.sessionControl;
    this.approvalService = options.approvalService;
  }

  listBindings(filter = {}) {
    return this.bindingRegistry.listBindings(filter);
  }

  getBinding(channel, conversationId) {
    return this.bindingRegistry.getBinding(channel, conversationId);
  }

  attachBinding(channel, conversationId, input = {}) {
    const session = this.requireSession(input.hostSessionId);
    const controller = this.attachController(session.hostSessionId, channel, conversationId, input);
    const mode = normalizeBindingMode(input.mode);
    const record = this.bindingRegistry.attachBinding({
      channel,
      conversationId,
      conversationType: input.conversationType || "p2p",
      activeHostSessionId: session.hostSessionId,
      mode,
      pinnedSessionIds: input.pin === false ? [] : [session.hostSessionId],
      attachedBy: input.attachedBy || null,
      activeControllerId: controller.controllerId,
      activeControllerType: controller.controllerType,
      channelUserId: input.channelUserId || null,
      metadata: input.metadata || {}
    });

    this.sessionRegistry.appendEvent(session.hostSessionId, {
      kind: "channel_binding_attached",
      controllability: "controllable",
      payload: {
        channel,
        conversationId,
        mode,
        controllerId: controller.controllerId,
        controllerType: controller.controllerType,
        attachedBy: input.attachedBy || null,
        channelUserId: input.channelUserId || null
      }
    });
    return record;
  }

  switchBinding(channel, conversationId, input = {}) {
    const current = this.bindingRegistry.getBinding(channel, conversationId);
    if (current && current.activeHostSessionId && current.activeHostSessionId !== input.hostSessionId && current.activeControllerId) {
      this.sessionControl.detachController(current.activeHostSessionId, current.activeControllerId);
      this.sessionRegistry.appendEvent(current.activeHostSessionId, {
        kind: "channel_binding_switched_away",
        controllability: "controllable",
        payload: {
          channel,
          conversationId,
          previousHostSessionId: current.activeHostSessionId,
          nextHostSessionId: input.hostSessionId || null
        }
      });
    }

    return this.attachBinding(channel, conversationId, input);
  }

  detachBinding(channel, conversationId, input = {}) {
    const current = this.bindingRegistry.getBinding(channel, conversationId);
    if (!current) {
      return null;
    }

    if (current.activeHostSessionId && current.activeControllerId) {
      this.sessionControl.detachController(current.activeHostSessionId, current.activeControllerId);
      this.sessionRegistry.appendEvent(current.activeHostSessionId, {
        kind: "channel_binding_detached",
        controllability: "controllable",
        payload: {
          channel,
          conversationId,
          controllerId: current.activeControllerId,
          controllerType: current.activeControllerType,
          channelUserId: input.channelUserId || null
        }
      });
    }

    return this.bindingRegistry.detachBinding(channel, conversationId, {
      channelUserId: input.channelUserId || null,
      metadata: input.metadata || {}
    });
  }

  async sendBoundMessage(channel, conversationId, prompt, input = {}) {
    const binding = this.requireActiveBinding(channel, conversationId);
    if (binding.mode !== "control") {
      const error = new Error(`Binding ${channel}/${conversationId} is not in control mode`);
      error.statusCode = 409;
      error.code = "binding_not_in_control_mode";
      throw error;
    }

    const record = await this.sessionControl.submitMessage(binding.activeHostSessionId, prompt, {
      controllerId: binding.activeControllerId,
      controllerType: binding.activeControllerType,
      mode: "active-write",
      metadata: {
        channel,
        conversationId,
        channelUserId: input.channelUserId || null,
        attachedBy: binding.attachedBy || null
      }
    });

    return {
      binding,
      hostSessionId: binding.activeHostSessionId,
      input: record
    };
  }

  getWatchSnapshot(channel, conversationId, input = {}) {
    const binding = this.bindingRegistry.getBinding(channel, conversationId);
    if (!binding) {
      const error = new Error(`Unknown binding: ${channel}/${conversationId}`);
      error.statusCode = 404;
      throw error;
    }

    const hostSessionId = binding.activeHostSessionId;
    const session = hostSessionId ? this.sessionRegistry.getSession(hostSessionId) : null;
    return {
      binding,
      session,
      events: hostSessionId ? this.sessionRegistry.listEvents(hostSessionId).slice(-(input.limitEvents || 20)) : [],
      approvals: hostSessionId ? this.approvalService.listApprovals({ hostSessionId }) : []
    };
  }

  requireActiveBinding(channel, conversationId) {
    const binding = this.bindingRegistry.getBinding(channel, conversationId);
    if (!binding || !binding.activeHostSessionId) {
      const error = new Error(`Binding ${channel}/${conversationId} has no active session`);
      error.statusCode = 409;
      error.code = "binding_not_attached";
      throw error;
    }
    return binding;
  }

  requireSession(hostSessionId) {
    const session = this.sessionRegistry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }
    return session;
  }

  attachController(hostSessionId, channel, conversationId, input) {
    const mode = normalizeBindingMode(input.mode);
    const controllerId = input.controllerId || `channel:${channel}:${conversationId}`;
    const controllerType = input.controllerType || `channel:${channel}`;
    return this.sessionControl.attachController(hostSessionId, {
      controllerId,
      controllerType,
      mode: mode === "control" ? "active-write" : "watch",
      takeover: Boolean(input.takeover),
      metadata: {
        channel,
        conversationId,
        channelUserId: input.channelUserId || null,
        attachedBy: input.attachedBy || null,
        ...(input.metadata || {})
      }
    });
  }
}

function normalizeBindingMode(mode) {
  return mode === "control" ? "control" : "watch";
}

module.exports = {
  ChannelBindingService
};

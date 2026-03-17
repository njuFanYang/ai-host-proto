const { createId } = require("./utils");

class SessionControlService {
  constructor(options) {
    this.registry = options.registry;
    this.manager = options.manager;
    this.draining = new Set();

    if (this.manager) {
      this.manager.onSessionAvailable = (hostSessionId) => {
        this.clearAvailabilityGate(hostSessionId);
        void this.drainQueue(hostSessionId);
      };
    }
  }

  listControllers(hostSessionId) {
    const session = this.getSessionOrThrow(hostSessionId);
    return this.getControlState(session).controllers.slice();
  }

  attachController(hostSessionId, input = {}) {
    const session = this.getSessionOrThrow(hostSessionId);
    const state = this.getControlState(session);
    const controllerId = input.controllerId || createId("controller");
    const controllerType = input.controllerType || "local-api";
    const mode = input.mode || "watch";
    const takeover = Boolean(input.takeover);
    const now = new Date().toISOString();
    const active = state.controllers.find((controller) => controller.mode === "active-write") || null;

    if (mode === "active-write" && active && active.controllerId !== controllerId && !takeover) {
      const error = new Error(`Session ${hostSessionId} already has an active controller: ${active.controllerId}`);
      error.statusCode = 409;
      error.code = "controller_conflict";
      throw error;
    }

    if (mode === "active-write" && active && active.controllerId !== controllerId) {
      active.mode = "watch";
      active.updatedAt = now;
    }

    let controller = state.controllers.find((entry) => entry.controllerId === controllerId) || null;
    const existing = Boolean(controller);
    if (!controller) {
      controller = {
        controllerId,
        controllerType,
        mode,
        attachedAt: now,
        updatedAt: now,
        metadata: input.metadata || {}
      };
      state.controllers.push(controller);
    } else {
      controller.controllerType = controllerType;
      controller.mode = mode;
      controller.updatedAt = now;
      controller.metadata = {
        ...(controller.metadata || {}),
        ...(input.metadata || {})
      };
    }

    this.saveControlState(hostSessionId, session, state);
    this.registry.appendEvent(hostSessionId, {
      kind: existing ? "controller_mode_changed" : "controller_attached",
      controllability: "controllable",
      payload: {
        controllerId,
        controllerType,
        mode,
        takeover
      }
    });
    return { ...controller };
  }

  detachController(hostSessionId, controllerId) {
    const session = this.getSessionOrThrow(hostSessionId);
    const state = this.getControlState(session);
    const index = state.controllers.findIndex((entry) => entry.controllerId === controllerId);
    if (index < 0) {
      return null;
    }

    const [controller] = state.controllers.splice(index, 1);
    this.saveControlState(hostSessionId, session, state);
    this.registry.appendEvent(hostSessionId, {
      kind: "controller_detached",
      controllability: "controllable",
      payload: {
        controllerId: controller.controllerId,
        controllerType: controller.controllerType,
        mode: controller.mode
      }
    });
    return { ...controller };
  }

  listInputs(hostSessionId) {
    const session = this.getSessionOrThrow(hostSessionId);
    return this.getControlState(session).inputs.slice();
  }

  async submitMessage(hostSessionId, prompt, input = {}) {
    const session = this.getSessionOrThrow(hostSessionId);
    if (!prompt) {
      const error = new Error("missing_prompt");
      error.statusCode = 400;
      throw error;
    }

    const controller = this.ensureActiveWriteController(hostSessionId, input.controller || input);
    const latestSession = this.registry.getSession(hostSessionId) || session;
    const state = this.getControlState(latestSession);
    const blocked = latestSession.status === "waiting_approval";
    const queueItem = {
      inputId: createId("input"),
      prompt,
      controllerId: controller.controllerId,
      controllerType: controller.controllerType,
      status: blocked ? "blocked" : "queued",
      blockedReason: blocked ? "approval_pending" : null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      attempts: 0,
      lastError: null,
      result: null
    };

    state.inputs.push(queueItem);
    this.saveControlState(hostSessionId, latestSession, state);
    this.registry.appendEvent(hostSessionId, {
      kind: blocked ? "session_input_blocked" : "session_input_queued",
      controllability: "controllable",
      payload: {
        inputId: queueItem.inputId,
        controllerId: queueItem.controllerId,
        controllerType: queueItem.controllerType,
        blockedReason: queueItem.blockedReason
      }
    });

    if (!blocked && !state.waitingForAvailability) {
      void this.drainQueue(hostSessionId);
    }

    return { ...queueItem };
  }

  async drainQueue(hostSessionId) {
    if (this.draining.has(hostSessionId)) {
      return false;
    }

    this.draining.add(hostSessionId);
    try {
      while (true) {
        const session = this.manager.refreshSession(hostSessionId) || this.registry.getSession(hostSessionId);
        if (!session) {
          return false;
        }

        const state = this.getControlState(session);
        if (state.waitingForAvailability) {
          return false;
        }

        if (session.status !== "waiting_approval") {
          let resumed = false;
          for (const item of state.inputs) {
            if (item.status === "blocked" && item.blockedReason === "approval_pending") {
              item.status = "queued";
              item.blockedReason = null;
              resumed = true;
              this.registry.appendEvent(hostSessionId, {
                kind: "session_input_resumed",
                controllability: "controllable",
                payload: {
                  inputId: item.inputId,
                  controllerId: item.controllerId,
                  controllerType: item.controllerType,
                  reason: "approval_resolved"
                }
              });
            }
          }
          if (resumed) {
            this.saveControlState(hostSessionId, session, state);
          }
        }

        if (session.status === "waiting_approval") {
          return false;
        }

        const next = state.inputs
          .filter((item) => item.status === "queued")
          .sort(sortInputs)[0] || null;
        if (!next) {
          return true;
        }

        next.status = "executing";
        next.startedAt = new Date().toISOString();
        next.attempts += 1;
        next.blockedReason = null;
        next.lastError = null;
        this.saveControlState(hostSessionId, session, state);
        this.registry.appendEvent(hostSessionId, {
          kind: "session_input_started",
          controllability: "controllable",
          payload: {
            inputId: next.inputId,
            controllerId: next.controllerId,
            controllerType: next.controllerType,
            attempts: next.attempts
          }
        });

        try {
          const result = await this.manager.dispatchTransportMessage(hostSessionId, next.prompt);
          next.status = "completed";
          next.completedAt = new Date().toISOString();
          next.result = normalizeDispatchResult(result);

          if (isDeferredTransportResult(next.result)) {
            state.waitingForAvailability = true;
            state.waitingReason = "transport_busy";
            state.waitingSince = next.completedAt;
          }

          this.saveControlState(hostSessionId, this.registry.getSession(hostSessionId), state);
          this.registry.appendEvent(hostSessionId, {
            kind: "session_input_completed",
            controllability: "controllable",
            payload: {
              inputId: next.inputId,
              controllerId: next.controllerId,
              controllerType: next.controllerType,
              result: next.result
            }
          });

          if (isDeferredTransportResult(next.result)) {
            return true;
          }
        } catch (error) {
          const currentSession = this.registry.getSession(hostSessionId);
          if (isRetryableDispatchError(error)) {
            next.status = currentSession && currentSession.status === "waiting_approval" ? "blocked" : "queued";
            next.blockedReason = next.status === "blocked" ? "approval_pending" : null;
            next.lastError = error.message;
            this.saveControlState(hostSessionId, currentSession || session, state);
            this.registry.appendEvent(hostSessionId, {
              kind: next.status === "blocked" ? "session_input_blocked" : "session_input_requeued",
              controllability: "controllable",
              payload: {
                inputId: next.inputId,
                controllerId: next.controllerId,
                controllerType: next.controllerType,
                blockedReason: next.blockedReason,
                reason: error.message
              }
            });
            return false;
          }

          next.status = "failed";
          next.completedAt = new Date().toISOString();
          next.lastError = error.message;
          this.saveControlState(hostSessionId, currentSession || session, state);
          this.registry.appendEvent(hostSessionId, {
            kind: "session_input_failed",
            controllability: "controllable",
            payload: {
              inputId: next.inputId,
              controllerId: next.controllerId,
              controllerType: next.controllerType,
              error: error.message
            }
          });
        }
      }
    } finally {
      this.draining.delete(hostSessionId);
    }
  }

  clearAvailabilityGate(hostSessionId) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      return false;
    }

    const state = this.getControlState(session);
    if (!state.waitingForAvailability) {
      return false;
    }

    state.waitingForAvailability = false;
    state.waitingReason = null;
    state.waitingSince = null;
    this.saveControlState(hostSessionId, session, state);
    this.registry.appendEvent(hostSessionId, {
      kind: "session_input_resumed",
      controllability: "controllable",
      payload: {
        reason: "transport_available"
      }
    });
    return true;
  }

  ensureActiveWriteController(hostSessionId, input = {}) {
    const controllerId = input.controllerId || "local-api";
    const controllerType = input.controllerType || "local-api";
    const mode = input.mode || "active-write";
    return this.attachController(hostSessionId, {
      controllerId,
      controllerType,
      mode,
      takeover: Boolean(input.takeover),
      metadata: input.metadata || {}
    });
  }

  getSessionOrThrow(hostSessionId) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }
    return session;
  }

  getControlState(session) {
    const sessionControl = session.metadata && session.metadata.sessionControl
      ? session.metadata.sessionControl
      : {};
    return {
      controllers: Array.isArray(sessionControl.controllers)
        ? sessionControl.controllers.map((controller) => ({ ...controller }))
        : [],
      inputs: Array.isArray(sessionControl.inputs)
        ? sessionControl.inputs.map((input) => ({ ...input }))
        : [],
      waitingForAvailability: Boolean(sessionControl.waitingForAvailability),
      waitingReason: sessionControl.waitingReason || null,
      waitingSince: sessionControl.waitingSince || null
    };
  }

  saveControlState(hostSessionId, session, state) {
    const active = state.controllers.find((controller) => controller.mode === "active-write") || null;
    const sortedControllers = state.controllers.slice().sort(sortControllers);
    const sortedInputs = state.inputs.slice().sort(sortInputs);
    const metadata = {
      ...(session.metadata || {}),
      sessionControl: {
        controllers: sortedControllers,
        inputs: sortedInputs,
        waitingForAvailability: Boolean(state.waitingForAvailability),
        waitingReason: state.waitingReason || null,
        waitingSince: state.waitingSince || null
      },
      controllerState: {
        activeControllerId: active ? active.controllerId : null,
        attachedControllerIds: sortedControllers.map((controller) => controller.controllerId)
      },
      inputQueueState: {
        queued: sortedInputs.filter((input) => input.status === "queued").length,
        blocked: sortedInputs.filter((input) => input.status === "blocked").length,
        executing: sortedInputs.filter((input) => input.status === "executing").length,
        completed: sortedInputs.filter((input) => input.status === "completed").length,
        failed: sortedInputs.filter((input) => input.status === "failed").length,
        awaitingAvailability: Boolean(state.waitingForAvailability),
        lastInputId: sortedInputs.length > 0 ? sortedInputs[sortedInputs.length - 1].inputId : null
      }
    };

    this.registry.updateSession(hostSessionId, { metadata });
  }
}

function isRetryableDispatchError(error) {
  if (!error) {
    return false;
  }

  if (error.statusCode !== 409) {
    return false;
  }

  return /already running|in-flight turn|not bound|not connected|waiting approval/i.test(error.message);
}

function normalizeDispatchResult(result) {
  if (result === true || result === false || result === null || result === undefined) {
    return { ok: Boolean(result) };
  }

  if (typeof result === "object") {
    return result;
  }

  return { value: result };
}

function isDeferredTransportResult(result) {
  return Boolean(result) && result.queued === true;
}

function sortInputs(left, right) {
  if (left.createdAt === right.createdAt) {
    return left.inputId < right.inputId ? -1 : 1;
  }
  return left.createdAt < right.createdAt ? -1 : 1;
}

function sortControllers(left, right) {
  if (left.mode === right.mode) {
    return left.attachedAt < right.attachedAt ? -1 : 1;
  }
  if (left.mode === "active-write") {
    return -1;
  }
  if (right.mode === "active-write") {
    return 1;
  }
  return left.mode < right.mode ? -1 : 1;
}

module.exports = {
  SessionControlService
};

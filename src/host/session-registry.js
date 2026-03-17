const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const {
  createHostSessionId,
  createId,
  ensureDir,
  nowIso,
  resolveDataRoot
} = require("./utils");

class SessionRegistry {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.dataRoot = options.dataRoot || resolveDataRoot(this.projectRoot);
    this.sessionsDir = path.join(this.dataRoot, "sessions");
    ensureDir(this.sessionsDir);
    this.records = new Map();
    this.events = new Map();
    this.approvals = new Map();
    this.wrapperCommands = new Map();
    this.stream = new EventEmitter();
    this.stream.setMaxListeners(0);
    this.loadPersistedSessions();
  }

  subscribe(listener) {
    this.stream.on("message", listener);
    return () => {
      this.stream.off("message", listener);
    };
  }

  createSession(input) {
    const hostSessionId = createHostSessionId(input.source);
    const timestamp = nowIso();
    const record = {
      hostSessionId,
      source: input.source,
      transport: input.transport,
      upstreamSessionId: null,
      workspaceRoot: input.workspaceRoot,
      status: "starting",
      registrationState: "pending_upstream",
      createdAt: timestamp,
      lastActivityAt: timestamp,
      controlMode: "managed",
      runtime: input.runtime || {},
      metadata: input.metadata || {},
      transportCapabilities: input.transportCapabilities || defaultCapabilities(input.transport)
    };

    this.records.set(hostSessionId, record);
    this.events.set(hostSessionId, []);
    this.wrapperCommands.set(hostSessionId, new Map());
    this.persistSession(hostSessionId);
    this.emitMessage({
      type: "session",
      action: "created",
      hostSessionId,
      session: { ...record }
    });
    return record;
  }

  getSession(hostSessionId) {
    return this.records.get(hostSessionId) || null;
  }

  listSessions() {
    return Array.from(this.records.values()).sort((left, right) =>
      left.createdAt < right.createdAt ? 1 : -1
    );
  }

  updateSession(hostSessionId, patch) {
    const record = this.getSession(hostSessionId);
    if (!record) {
      return null;
    }

    Object.assign(record, patch, { lastActivityAt: nowIso() });
    this.persistSession(hostSessionId);
    this.emitMessage({
      type: "session",
      action: "updated",
      hostSessionId,
      session: { ...record }
    });
    return record;
  }

  bindUpstreamSession(hostSessionId, upstreamSessionId) {
    return this.updateSession(hostSessionId, {
      upstreamSessionId,
      registrationState: "bound"
    });
  }

  failRegistration(hostSessionId, reason) {
    return this.updateSession(hostSessionId, {
      registrationState: "failed",
      status: "failed",
      failureReason: reason
    });
  }

  appendEvent(hostSessionId, input) {
    const record = this.getSession(hostSessionId);
    if (!record) {
      return null;
    }

    const event = {
      eventId: createId("event"),
      hostSessionId,
      kind: input.kind,
      controllability: input.controllability || "observed",
      timestamp: nowIso(),
      payload: input.payload || {}
    };

    this.events.get(hostSessionId).push(event);
    record.lastActivityAt = event.timestamp;
    this.persistSession(hostSessionId);
    this.emitMessage({
      type: "event",
      hostSessionId,
      event: { ...event }
    });
    return event;
  }

  listEvents(hostSessionId) {
    return (this.events.get(hostSessionId) || []).slice();
  }

  enqueueWrapperCommand(hostSessionId, input = {}) {
    const session = this.getSession(hostSessionId);
    if (!session) {
      return null;
    }

    const command = {
      commandId: createId("wrappercmd"),
      hostSessionId,
      kind: input.kind,
      payload: input.payload || {},
      status: "queued",
      createdAt: nowIso(),
      claimedAt: null,
      leaseExpiresAt: null,
      leaseToken: null,
      retryCount: 0,
      maxRetries: Number.isInteger(input.maxRetries) ? input.maxRetries : 3,
      lastError: null,
      completedAt: null,
      result: null
    };

    this.getWrapperCommandMap(hostSessionId).set(command.commandId, command);
    this.persistSession(hostSessionId);
    this.appendEvent(hostSessionId, {
      kind: "wrapper_command_queued",
      controllability: input.controllability || "controllable",
      payload: {
        commandId: command.commandId,
        kind: command.kind,
        retryCount: command.retryCount,
        maxRetries: command.maxRetries
      }
    });
    return { ...command };
  }

  claimWrapperCommands(hostSessionId, options = {}) {
    const session = this.getSession(hostSessionId);
    if (!session) {
      return [];
    }

    const now = resolveNow(options.now);
    this.requeueExpiredWrapperCommands(hostSessionId, {
      now,
      reason: options.expiryReason || "lease_expired"
    });

    const leaseMs = Number.isFinite(options.leaseMs) ? Math.max(1, Number(options.leaseMs)) : 30000;
    const queued = Array.from(this.getWrapperCommandMap(hostSessionId).values())
      .filter((command) => command.status === "queued")
      .sort(sortByCreatedAt);

    const claimed = [];
    for (const command of queued) {
      const leaseToken = createId("wrapperlease");
      const claimedAt = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      Object.assign(command, {
        status: "leased",
        claimedAt,
        leaseExpiresAt,
        leaseToken,
        lastError: null
      });
      claimed.push({ ...command });
      this.appendEvent(hostSessionId, {
        kind: "wrapper_command_leased",
        controllability: "controllable",
        payload: {
          commandId: command.commandId,
          kind: command.kind,
          leaseToken,
          claimedAt,
          leaseExpiresAt,
          retryCount: command.retryCount
        }
      });
    }

    if (claimed.length > 0) {
      this.persistSession(hostSessionId);
    }

    return claimed;
  }

  completeWrapperCommand(hostSessionId, commandId, input = {}) {
    const command = this.getWrapperCommandMap(hostSessionId).get(commandId) || null;
    if (!command) {
      return null;
    }

    const leaseToken = input.leaseToken || null;
    if ((command.status === "completed" || command.status === "failed" || command.status === "abandoned") &&
      (!leaseToken || command.leaseToken === leaseToken)) {
      return { ...command };
    }

    if (command.status !== "leased") {
      const error = new Error(`Wrapper command ${commandId} is not currently leased`);
      error.statusCode = 409;
      error.code = "wrapper_command_not_leased";
      throw error;
    }

    if (!leaseToken || command.leaseToken !== leaseToken) {
      const error = new Error(`Stale wrapper command lease: ${commandId}`);
      error.statusCode = 409;
      error.code = "stale_wrapper_command_lease";
      throw error;
    }

    command.status = input && input.ok === false ? "failed" : "completed";
    command.completedAt = nowIso();
    command.result = input || {};
    command.lastError = input && input.ok === false
      ? extractCommandError(input)
      : null;
    command.leaseExpiresAt = null;

    this.persistSession(hostSessionId);
    this.appendEvent(hostSessionId, {
      kind: command.status === "failed" ? "wrapper_command_failed" : "wrapper_command_completed",
      controllability: "controllable",
      payload: {
        commandId,
        kind: command.kind,
        leaseToken: command.leaseToken,
        ok: command.status !== "failed",
        result: input || {}
      }
    });

    return { ...command };
  }

  requeueExpiredWrapperCommands(hostSessionId, options = {}) {
    const session = this.getSession(hostSessionId);
    if (!session) {
      return [];
    }

    const now = resolveNow(options.now);
    const reason = options.reason || "lease_expired";
    const changed = [];

    for (const command of Array.from(this.getWrapperCommandMap(hostSessionId).values()).sort(sortByCreatedAt)) {
      if (command.status !== "leased" || !command.leaseExpiresAt) {
        continue;
      }

      if (Date.parse(command.leaseExpiresAt) > now.getTime()) {
        continue;
      }

      if (command.retryCount < command.maxRetries) {
        command.status = "queued";
        command.retryCount += 1;
        command.claimedAt = null;
        command.leaseExpiresAt = null;
        command.leaseToken = null;
        command.lastError = reason;
        changed.push({ ...command });
        this.appendEvent(hostSessionId, {
          kind: "wrapper_command_requeued",
          controllability: "controllable",
          payload: {
            commandId: command.commandId,
            kind: command.kind,
            retryCount: command.retryCount,
            maxRetries: command.maxRetries,
            reason
          }
        });
        continue;
      }

      command.status = "abandoned";
      command.completedAt = now.toISOString();
      command.lastError = reason;
      command.leaseExpiresAt = null;
      changed.push({ ...command });
      this.appendEvent(hostSessionId, {
        kind: "wrapper_command_abandoned",
        controllability: "controllable",
        payload: {
          commandId: command.commandId,
          kind: command.kind,
          retryCount: command.retryCount,
          maxRetries: command.maxRetries,
          reason
        }
      });
    }

    if (changed.length > 0) {
      this.persistSession(hostSessionId);
    }

    return changed;
  }

  getWrapperCommand(hostSessionId, commandId) {
    const command = this.getWrapperCommandMap(hostSessionId).get(commandId) || null;
    return command ? { ...command } : null;
  }

  listWrapperCommands(hostSessionId, filter = {}) {
    let commands = Array.from(this.getWrapperCommandMap(hostSessionId).values());
    if (filter.status) {
      commands = commands.filter((command) => command.status === filter.status);
    }
    return commands.sort(sortByCreatedAt).map((command) => ({ ...command }));
  }

  createApproval(hostSessionId, input) {
    const session = this.getSession(hostSessionId);
    if (!session) {
      return null;
    }

    const request = {
      requestId: createId("approval"),
      hostSessionId,
      riskLevel: input.riskLevel || "medium",
      actionType: input.actionType || "unknown",
      summary: input.summary || "",
      rawRequest: input.rawRequest || {},
      status: "pending",
      createdAt: nowIso()
    };

    this.approvals.set(request.requestId, request);
    this.updateSession(hostSessionId, {
      status: "waiting_approval"
    });
    this.appendEvent(hostSessionId, {
      kind: "approval_request",
      controllability: input.controllability || "observed",
      payload: request
    });
    this.emitMessage({
      type: "approval",
      action: "created",
      hostSessionId,
      approval: { ...request }
    });
    return request;
  }

  getApproval(requestId) {
    return this.approvals.get(requestId) || null;
  }

  listApprovals(filter = {}) {
    let approvals = Array.from(this.approvals.values());

    if (filter.hostSessionId) {
      approvals = approvals.filter((approval) => approval.hostSessionId === filter.hostSessionId);
    }

    if (filter.status) {
      approvals = approvals.filter((approval) => approval.status === filter.status);
    }

    return approvals.sort((left, right) =>
      left.createdAt < right.createdAt ? 1 : -1
    );
  }

  resolveApproval(requestId, decision) {
    const approval = this.getApproval(requestId);
    if (!approval) {
      return null;
    }

    approval.status = "resolved";
    approval.decision = decision;
    approval.resolvedAt = nowIso();
    this.updateSession(approval.hostSessionId, {
      status: decision.decision === "deny" ? "failed" : "running"
    });
    this.appendEvent(approval.hostSessionId, {
      kind: "approval_result",
      controllability: decision.controllability || "observed",
      payload: {
        requestId,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        reason: decision.reason || null
      }
    });
    this.emitMessage({
      type: "approval",
      action: "resolved",
      hostSessionId: approval.hostSessionId,
      approval: { ...approval }
    });
    return approval;
  }

  persistSession(hostSessionId) {
    const record = this.getSession(hostSessionId);
    if (!record) {
      return;
    }

    const filePath = path.join(this.sessionsDir, `${hostSessionId}.json`);
    const payload = {
      record,
      events: this.listEvents(hostSessionId),
      wrapperCommands: this.listWrapperCommands(hostSessionId)
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  }

  loadPersistedSessions() {
    const files = fs
      .readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(this.sessionsDir, file.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || !parsed.record || !parsed.record.hostSessionId) {
          continue;
        }

        const hostSessionId = parsed.record.hostSessionId;
        this.records.set(hostSessionId, parsed.record);
        this.events.set(hostSessionId, Array.isArray(parsed.events) ? parsed.events : []);
        this.wrapperCommands.set(hostSessionId, rebuildWrapperCommandMap(parsed.wrapperCommands));
        this.rebuildApprovalsFromEvents(hostSessionId);
      } catch (_error) {
        // Ignore corrupt session files and keep loading the rest.
      }
    }
  }

  rebuildApprovalsFromEvents(hostSessionId) {
    const events = this.listEvents(hostSessionId);
    for (const event of events) {
      if (event.kind === 'approval_request' && event.payload && event.payload.requestId) {
        this.approvals.set(event.payload.requestId, {
          ...event.payload
        });
      }

      if (event.kind === 'approval_result' && event.payload && event.payload.requestId) {
        const approval = this.approvals.get(event.payload.requestId);
        if (!approval) {
          continue;
        }

        approval.status = 'resolved';
        approval.decision = {
          decision: event.payload.decision,
          decidedBy: event.payload.decidedBy,
          reason: event.payload.reason || null
        };
      }
    }
  }

  emitMessage(message) {
    this.stream.emit("message", message);
  }

  getWrapperCommandMap(hostSessionId) {
    let commands = this.wrapperCommands.get(hostSessionId);
    if (!commands) {
      commands = new Map();
      this.wrapperCommands.set(hostSessionId, commands);
    }
    return commands;
  }
}

function rebuildWrapperCommandMap(rawCommands) {
  const commands = new Map();
  for (const command of Array.isArray(rawCommands) ? rawCommands : []) {
    if (!command || !command.commandId) {
      continue;
    }

    commands.set(command.commandId, {
      commandId: command.commandId,
      hostSessionId: command.hostSessionId || null,
      kind: command.kind || "unknown",
      payload: command.payload || {},
      status: command.status || "queued",
      createdAt: command.createdAt || nowIso(),
      claimedAt: command.claimedAt || null,
      leaseExpiresAt: command.leaseExpiresAt || null,
      leaseToken: command.leaseToken || null,
      retryCount: Number.isInteger(command.retryCount) ? command.retryCount : 0,
      maxRetries: Number.isInteger(command.maxRetries) ? command.maxRetries : 3,
      lastError: command.lastError || null,
      completedAt: command.completedAt || null,
      result: command.result || null
    });
  }
  return commands;
}

function resolveNow(input) {
  if (input instanceof Date) {
    return input;
  }

  if (typeof input === "string" || typeof input === "number") {
    const date = new Date(input);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

function sortByCreatedAt(left, right) {
  if (left.createdAt === right.createdAt) {
    return left.commandId < right.commandId ? -1 : 1;
  }
  return left.createdAt < right.createdAt ? -1 : 1;
}

function extractCommandError(input) {
  if (input.error && typeof input.error.message === "string") {
    return input.error.message;
  }

  if (typeof input.error === "string") {
    return input.error;
  }

  return "wrapper_command_failed";
}

function defaultCapabilities(transport) {
  switch (transport) {
    case "exec-json":
      return {
        sessionRegistration: "supported",
        outputCollection: "complete",
        messageInjection: "supported",
        autoHitl: "supported"
      };
    case "sdk/thread":
      return {
        sessionRegistration: "supported",
        outputCollection: "complete",
        messageInjection: "supported",
        autoHitl: "supported"
      };
    case "app-server":
      return {
        sessionRegistration: "supported",
        outputCollection: "complete",
        messageInjection: "supported",
        autoHitl: "poc"
      };
    case "tty":
    default:
      return {
        sessionRegistration: "supported",
        outputCollection: "limited",
        messageInjection: "conditional",
        autoHitl: "conditional"
      };
  }
}

module.exports = {
  SessionRegistry,
  defaultCapabilities
};

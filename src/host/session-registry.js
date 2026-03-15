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
      events: this.listEvents(hostSessionId)
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

const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const { ensureDir, safeJsonParse } = require("./utils");

class CodexAppServerClient {
  constructor(options) {
    this.registry = options.registry;
    this.projectRoot = options.projectRoot;
    this.spawnFn = options.spawnFn || spawn;
    this.connections = new Map();
    this.onSessionAvailable = options.onSessionAvailable || null;
    this.codexHome = options.codexHome || process.env.AI_HOST_CODEX_HOME || process.env.CODEX_HOME || null;
    if (this.codexHome) {
      ensureDir(this.codexHome);
    }
  }

  async launchCliSession(input) {
    return this.launchRpcSession(input, {
      source: "cli",
      transport: "app-server",
      runtimeMode: "app-server",
      metadata: {
        experimental: true
      }
    });
  }

  async launchSdkSession(input) {
    return this.launchRpcSession(input, {
      source: "cli",
      transport: "sdk/thread",
      runtimeMode: "sdk",
      metadata: {
        experimental: true,
        compatibilityShim: "app-server"
      }
    });
  }

  async launchRpcSession(input, options) {
    const workspaceRoot = input.cwd || this.projectRoot;
    const record = this.registry.createSession({
      source: options.source || "cli",
      transport: options.transport,
      workspaceRoot,
      runtime: {
        mode: options.runtimeMode,
        sandbox: input.sandbox || "read-only",
        model: input.model || null,
        profile: input.profile || null
      },
      metadata: options.metadata || {}
    });

    await this.connect(record.hostSessionId, {
      cwd: workspaceRoot,
      sandbox: record.runtime.sandbox,
      model: record.runtime.model,
      profile: record.runtime.profile
    });

    if (input.prompt) {
      this.registry.appendEvent(record.hostSessionId, {
        kind: "user_input",
        controllability: "controllable",
        payload: {
          text: input.prompt,
          resumed: false
        }
      });
      await this.startTurn(record.hostSessionId, input.prompt);
    }

    return {
      record: this.registry.getSession(record.hostSessionId),
      terminalLaunchInfo: null
    };
  }

  refreshSession(hostSessionId) {
    const session = this.registry.getSession(hostSessionId);
    if (!isManagedRpcSession(session)) {
      return session;
    }

    const connection = this.connections.get(hostSessionId);
    if (connection && !connection.exited) {
      if (session.status === "starting") {
        this.registry.updateSession(hostSessionId, { status: "running" });
      }
      return this.registry.getSession(hostSessionId);
    }

    if (session.status === "running" || session.status === "waiting_approval" || session.status === "starting") {
      this.registry.updateSession(hostSessionId, { status: "ended" });
      this.registry.appendEvent(hostSessionId, {
        kind: "session_ended",
        controllability: "observed",
        payload: {
          reason: "app_server_not_connected"
        }
      });
    }

    return this.registry.getSession(hostSessionId);
  }

  async sendMessage(hostSessionId, prompt) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    if (!isManagedRpcSession(session)) {
      return false;
    }

    if (!session.upstreamSessionId) {
      const error = new Error(`Session ${hostSessionId} is not bound to an upstream session yet`);
      error.statusCode = 409;
      throw error;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "user_input",
      controllability: "controllable",
      payload: {
        text: prompt,
        resumed: true
      }
    });

    await this.startTurn(hostSessionId, prompt);
    return true;
  }

  async handleApprovalDecision(approval, input) {
    const session = this.registry.getSession(approval.hostSessionId);
    if (!isManagedRpcSession(session)) {
      return { handled: false };
    }

    const connection = this.connections.get(approval.hostSessionId);
    if (!connection || connection.exited) {
      return {
        handled: true,
        ok: false,
        error: "session_not_connected"
      };
    }

    const rawRequest = approval.rawRequest || {};
    if (rawRequest.rpcRequestId === undefined || rawRequest.rpcRequestId === null || !rawRequest.method) {
      return {
        handled: true,
        ok: false,
        error: "needs-human-fallback"
      };
    }

    const mapped = mapApprovalDecisionToRpcResult(rawRequest.method, rawRequest.params || {}, input);
    if (!mapped.ok) {
      return {
        handled: true,
        ok: false,
        error: mapped.error
      };
    }

    connection.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: rawRequest.rpcRequestId,
      result: mapped.result
    })}\n`);

    this.registry.appendEvent(approval.hostSessionId, {
      kind: "approval_result_upstream",
      controllability: "controllable",
      payload: {
        requestId: approval.requestId,
        rpcRequestId: rawRequest.rpcRequestId,
        method: rawRequest.method,
        decision: input.decision || "escalate"
      }
    });

    return {
      handled: true,
      ok: true
    };
  }

  async connect(hostSessionId, input) {
    const child = this.spawnFn("cmd.exe", ["/d", "/s", "/c", "codex", "app-server"], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildAppServerEnv(this.codexHome)
    });

    const connection = {
      child,
      nextRequestId: 0,
      pending: new Map(),
      initialized: false,
      exited: false,
      inFlightTurn: false,
      currentTurnId: null,
      pollTimer: null,
      pollAttempts: 0,
      seenItemIds: new Set()
    };
    this.connections.set(hostSessionId, connection);

    this.registry.updateSession(hostSessionId, {
      status: "running",
      runtime: {
        ...(this.registry.getSession(hostSessionId).runtime || {}),
        processId: child.pid,
        launchedAt: new Date().toISOString(),
        codexHome: this.codexHome || null
      }
    });

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      this.handleStdoutLine(hostSessionId, line);
    });

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      this.registry.appendEvent(hostSessionId, {
        kind: "stderr",
        controllability: "observed",
        payload: { line }
      });
    });

    child.on("error", (error) => {
      connection.exited = true;
      this.stopPolling(connection);
      this.rejectPending(connection, error);
      this.registry.failRegistration(hostSessionId, error.message);
      this.registry.appendEvent(hostSessionId, {
        kind: "error",
        controllability: "observed",
        payload: {
          message: error.message
        }
      });
    });

    child.on("exit", (code, signal) => {
      connection.exited = true;
      connection.inFlightTurn = false;
      this.stopPolling(connection);
      this.rejectPending(connection, new Error(`codex app-server exited with code ${code}`));
      this.registry.updateSession(hostSessionId, {
        status: code === 0 ? "ended" : "failed"
      });
      this.registry.appendEvent(hostSessionId, {
        kind: "session_ended",
        controllability: "observed",
        payload: { code, signal }
      });
    });

    await this.sendRpc(hostSessionId, "initialize", {
      clientInfo: {
        name: "ai-host-proto",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.sendNotification(hostSessionId, "initialized");
    connection.initialized = true;

    const started = await this.sendRpc(hostSessionId, "thread/start", {
      cwd: input.cwd,
      sandbox: input.sandbox || "read-only",
      approvalPolicy: "on-request",
      model: input.model || undefined,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });

    const threadId = started && started.thread && started.thread.id;
    if (!threadId) {
      const error = new Error("app-server thread/start did not return a thread id");
      error.statusCode = 502;
      throw error;
    }

    this.registry.bindUpstreamSession(hostSessionId, threadId);
    if (typeof this.onSessionAvailable === "function") {
      void this.onSessionAvailable(hostSessionId);
    }
    this.registry.appendEvent(hostSessionId, {
      kind: "session_started",
      controllability: "controllable",
      payload: started
    });
  }

  async startTurn(hostSessionId, prompt) {
    const session = this.registry.getSession(hostSessionId);
    const connection = this.connections.get(hostSessionId);
    if (!session || !connection || connection.exited) {
      const error = new Error(`Session ${hostSessionId} is not connected to app-server`);
      error.statusCode = 409;
      throw error;
    }

    if (connection.inFlightTurn) {
      const error = new Error(`Session ${hostSessionId} already has an in-flight turn`);
      error.statusCode = 409;
      throw error;
    }

    connection.inFlightTurn = true;
    connection.currentTurnId = null;
    connection.pollAttempts = 0;
    connection.seenItemIds.clear();

    try {
      const response = await this.sendRpc(hostSessionId, "turn/start", {
        threadId: session.upstreamSessionId,
        input: [
          {
            type: "text",
            text: prompt
          }
        ]
      });

      connection.currentTurnId = response && response.turn ? response.turn.id : null;
      this.startPolling(hostSessionId);
    } catch (error) {
      connection.inFlightTurn = false;
      throw error;
    }
  }

  startPolling(hostSessionId) {
    const connection = this.connections.get(hostSessionId);
    if (!connection || connection.exited) {
      return;
    }

    this.stopPolling(connection);
    connection.pollTimer = setTimeout(() => {
      this.pollTurnState(hostSessionId).catch((error) => {
        this.handlePollError(hostSessionId, error);
      });
    }, 1500);
  }

  stopPolling(connection) {
    if (connection && connection.pollTimer) {
      clearTimeout(connection.pollTimer);
      connection.pollTimer = null;
    }
  }

  async pollTurnState(hostSessionId) {
    const session = this.registry.getSession(hostSessionId);
    const connection = this.connections.get(hostSessionId);
    if (!session || !connection || connection.exited || !connection.inFlightTurn || !session.upstreamSessionId) {
      return;
    }

    connection.pollAttempts += 1;
    const readResult = await this.sendRpc(hostSessionId, "thread/read", {
      threadId: session.upstreamSessionId,
      includeTurns: true
    });

    const snapshot = extractTurnSnapshot(readResult, connection.currentTurnId, connection.seenItemIds);
    if (snapshot.turnFound) {
      this.applyTurnSnapshot(hostSessionId, snapshot);
    }

    if (!snapshot.turnFound || snapshot.turnStatus === "inProgress") {
      if (connection.pollAttempts >= 20) {
        connection.inFlightTurn = false;
        this.stopPolling(connection);
        this.registry.appendEvent(hostSessionId, {
          kind: "turn_stalled",
          controllability: "observed",
          payload: {
            turnId: connection.currentTurnId,
            pollAttempts: connection.pollAttempts
          }
        });
        return;
      }

      this.startPolling(hostSessionId);
    }
  }

  handlePollError(hostSessionId, error) {
    const connection = this.connections.get(hostSessionId);
    if (!connection || connection.exited || !connection.inFlightTurn) {
      return;
    }

    const retryable = isRetryableThreadReadError(error);
    this.registry.appendEvent(hostSessionId, {
      kind: retryable ? "thread_read_retry" : "error",
      controllability: "observed",
      payload: {
        message: error.message,
        pollAttempts: connection.pollAttempts,
        retryable
      }
    });

    if (retryable && connection.pollAttempts < 20) {
      this.startPolling(hostSessionId);
      return;
    }

    connection.inFlightTurn = false;
    this.stopPolling(connection);
    if (typeof this.onSessionAvailable === "function") {
      void this.onSessionAvailable(hostSessionId);
    }
  }

  applyTurnSnapshot(hostSessionId, snapshot) {
    const connection = this.connections.get(hostSessionId);

    for (const item of snapshot.newItems) {
      const mapped = mapThreadItemEvent(item, snapshot.turnId);
      if (mapped) {
        this.registry.appendEvent(hostSessionId, mapped);
      }
    }

    if (snapshot.turnStatus === "completed") {
      if (connection) {
        connection.inFlightTurn = false;
        this.stopPolling(connection);
      }
      this.registry.updateSession(hostSessionId, { status: "running" });
      if (typeof this.onSessionAvailable === "function") {
        void this.onSessionAvailable(hostSessionId);
      }
      this.registry.appendEvent(hostSessionId, {
        kind: "turn_completed",
        controllability: "controllable",
        payload: {
          turnId: snapshot.turnId,
          source: "thread_read"
        }
      });
      return;
    }

    if (snapshot.turnStatus === "failed" || snapshot.turnStatus === "interrupted") {
      if (connection) {
        connection.inFlightTurn = false;
        this.stopPolling(connection);
      }
      this.registry.updateSession(hostSessionId, { status: snapshot.turnStatus === "failed" ? "failed" : "running" });
      if (typeof this.onSessionAvailable === "function") {
        void this.onSessionAvailable(hostSessionId);
      }
      this.registry.appendEvent(hostSessionId, {
        kind: snapshot.turnStatus === "failed" ? "error" : "turn_interrupted",
        controllability: "controllable",
        payload: {
          turnId: snapshot.turnId,
          error: snapshot.turnError || null,
          source: "thread_read"
        }
      });
    }
  }

  handleStdoutLine(hostSessionId, line) {
    const parsed = safeJsonParse(line);
    if (!parsed.ok) {
      this.registry.appendEvent(hostSessionId, {
        kind: "raw_stdout",
        controllability: "observed",
        payload: { line }
      });
      return;
    }

    const message = parsed.value;
    if (message && Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      this.resolvePending(hostSessionId, message);
      return;
    }

    if (message && message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.handleServerRequest(hostSessionId, message);
      return;
    }

    if (message && message.method) {
      this.handleNotification(hostSessionId, message);
      return;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "raw_event",
      controllability: "observed",
      payload: message
    });
  }

  handleNotification(hostSessionId, message) {
    switch (message.method) {
      case "thread/started":
        if (message.params && message.params.thread && message.params.thread.id) {
          this.registry.bindUpstreamSession(hostSessionId, message.params.thread.id);
        }
        if (typeof this.onSessionAvailable === "function") {
          void this.onSessionAvailable(hostSessionId);
        }
        this.registry.appendEvent(hostSessionId, {
          kind: "session_started",
          controllability: "controllable",
          payload: message.params || {}
        });
        return;
      case "turn/started": {
        const connection = this.connections.get(hostSessionId);
        if (connection && message.params && message.params.turn && message.params.turn.id) {
          connection.currentTurnId = message.params.turn.id;
        }
        this.registry.updateSession(hostSessionId, { status: "running" });
        this.registry.appendEvent(hostSessionId, {
          kind: "turn_started",
          controllability: "controllable",
          payload: message.params || {}
        });
        return;
      }
      case "turn/completed": {
        const connection = this.connections.get(hostSessionId);
        if (connection) {
          connection.inFlightTurn = false;
          this.stopPolling(connection);
        }
        this.registry.updateSession(hostSessionId, { status: "running" });
        if (typeof this.onSessionAvailable === "function") {
          void this.onSessionAvailable(hostSessionId);
        }
        this.registry.appendEvent(hostSessionId, {
          kind: "turn_completed",
          controllability: "controllable",
          payload: message.params || {}
        });
        return;
      }
      case "item/agentMessage/delta":
        this.registry.appendEvent(hostSessionId, {
          kind: "assistant_output_delta",
          controllability: "controllable",
          payload: {
            text: message.params && message.params.delta ? message.params.delta : "",
            raw: message.params || {}
          }
        });
        return;
      case "item/completed": {
        const connection = this.connections.get(hostSessionId);
        const item = message.params && message.params.item ? message.params.item : null;
        if (connection && item && item.id) {
          connection.seenItemIds.add(item.id);
        }
        const mapped = mapCompletedItemEvent(message.params || {});
        if (mapped) {
          this.registry.appendEvent(hostSessionId, mapped);
        }
        return;
      }
      case "thread/compacted":
        this.registry.appendEvent(hostSessionId, {
          kind: "context_compacted",
          controllability: "controllable",
          payload: message.params || {}
        });
        return;
      case "error": {
        const connection = this.connections.get(hostSessionId);
        if (connection) {
          connection.inFlightTurn = false;
          this.stopPolling(connection);
        }
        this.registry.updateSession(hostSessionId, { status: "failed" });
        if (typeof this.onSessionAvailable === "function") {
          void this.onSessionAvailable(hostSessionId);
        }
        this.registry.appendEvent(hostSessionId, {
          kind: "error",
          controllability: "controllable",
          payload: message.params || {}
        });
        return;
      }
      default:
        this.registry.appendEvent(hostSessionId, {
          kind: "raw_event",
          controllability: "controllable",
          payload: message
        });
    }
  }

  handleServerRequest(hostSessionId, message) {
    if (isApprovalMethod(message.method)) {
      const approval = this.registry.createApproval(hostSessionId, {
        riskLevel: inferApprovalRisk(message.method),
        actionType: inferApprovalActionType(message.method),
        summary: buildApprovalSummary(message.method, message.params || {}),
        rawRequest: {
          rpcRequestId: message.id,
          method: message.method,
          params: message.params || {}
        },
        controllability: "controllable"
      });

      this.registry.appendEvent(hostSessionId, {
        kind: "approval_request_observed",
        controllability: "controllable",
        payload: {
          requestId: approval.requestId,
          method: message.method
        }
      });
      return;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "server_request",
      controllability: "controllable",
      payload: message
    });

    this.connections.get(hostSessionId).child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unhandled server request: ${message.method}`
      }
    })}\n`);
  }

  sendNotification(hostSessionId, method, params) {
    const connection = this.connections.get(hostSessionId);
    if (!connection || connection.exited) {
      return false;
    }

    connection.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    })}\n`);
    return true;
  }

  sendRpc(hostSessionId, method, params) {
    const connection = this.connections.get(hostSessionId);
    if (!connection || connection.exited) {
      const error = new Error(`Session ${hostSessionId} is not connected to app-server`);
      error.statusCode = 409;
      throw error;
    }

    const id = ++connection.nextRequestId;
    connection.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })}\n`);

    return new Promise((resolve, reject) => {
      connection.pending.set(id, { resolve, reject, method });
    });
  }

  resolvePending(hostSessionId, message) {
    const connection = this.connections.get(hostSessionId);
    if (!connection) {
      return;
    }

    const pending = connection.pending.get(message.id);
    if (!pending) {
      this.registry.appendEvent(hostSessionId, {
        kind: "raw_rpc_response",
        controllability: "observed",
        payload: message
      });
      return;
    }

    connection.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || `RPC ${pending.method} failed`);
      error.statusCode = 502;
      pending.reject(error);
      return;
    }

    pending.resolve(message.result);
  }

  rejectPending(connection, error) {
    for (const pending of connection.pending.values()) {
      pending.reject(error);
    }
    connection.pending.clear();
  }
}

function isManagedRpcSession(session) {
  return Boolean(session) && (
    (session.transport === "app-server" && session.runtime && session.runtime.mode === "app-server") ||
    (session.transport === "sdk/thread" && session.runtime && session.runtime.mode === "sdk")
  );
}

function buildAppServerEnv(codexHome) {
  if (!codexHome) {
    return {
      ...process.env
    };
  }

  return {
    ...process.env,
    CODEX_HOME: codexHome
  };
}

function extractTurnSnapshot(readResult, currentTurnId, seenItemIds) {
  const turns = readResult && readResult.thread && Array.isArray(readResult.thread.turns)
    ? readResult.thread.turns
    : [];
  const turn = turns.find((entry) => entry.id === currentTurnId) || null;
  if (!turn) {
    return {
      turnFound: false,
      turnId: currentTurnId,
      turnStatus: null,
      turnError: null,
      newItems: []
    };
  }

  const newItems = [];
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (!item || !item.id || seenItemIds.has(item.id)) {
      continue;
    }
    seenItemIds.add(item.id);
    newItems.push(item);
  }

  return {
    turnFound: true,
    turnId: turn.id,
    turnStatus: turn.status || null,
    turnError: turn.error || null,
    newItems
  };
}

function mapThreadItemEvent(item, turnId) {
  if (!item || item.type === "userMessage") {
    return null;
  }

  if (item.type === "agentMessage") {
    return {
      kind: "assistant_output",
      controllability: "controllable",
      payload: {
        text: item.text || "",
        turnId,
        raw: item
      }
    };
  }

  if (item.type === "plan") {
    return {
      kind: "plan_output",
      controllability: "controllable",
      payload: {
        text: item.text || "",
        turnId,
        raw: item
      }
    };
  }

  if (item.type === "reasoning") {
    return {
      kind: "reasoning_output",
      controllability: "controllable",
      payload: {
        summary: item.summary || [],
        content: item.content || [],
        turnId,
        raw: item
      }
    };
  }

  return {
    kind: "tool_result",
    controllability: "controllable",
    payload: {
      turnId,
      item
    }
  };
}

function isRetryableThreadReadError(error) {
  if (!error || !error.message) {
    return false;
  }

  return error.message.includes("empty session file") ||
    error.message.includes("state db discrepancy") ||
    error.message.includes("failed to load rollout");
}

function mapCompletedItemEvent(params) {
  const item = params.item || {};
  if (!item || item.type === "userMessage") {
    return null;
  }

  if (item.type === "agentMessage") {
    return {
      kind: "assistant_output",
      controllability: "controllable",
      payload: {
        text: item.text || "",
        raw: params
      }
    };
  }

  return {
    kind: "tool_result",
    controllability: "controllable",
    payload: params
  };
}

function isApprovalMethod(method) {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval";
}

function inferApprovalRisk(method) {
  switch (method) {
    case "item/permissions/requestApproval":
      return "high";
    case "item/fileChange/requestApproval":
      return "medium";
    case "item/commandExecution/requestApproval":
    default:
      return "high";
  }
}

function inferApprovalActionType(method) {
  switch (method) {
    case "item/fileChange/requestApproval":
      return "file_change";
    case "item/permissions/requestApproval":
      return "permissions";
    case "item/commandExecution/requestApproval":
    default:
      return "command_execution";
  }
}

function buildApprovalSummary(method, params) {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return params.command || params.reason || "command execution approval requested";
    case "item/fileChange/requestApproval":
      return params.reason || params.grantRoot || "file change approval requested";
    case "item/permissions/requestApproval":
      return params.reason || JSON.stringify(params.permissions || {});
    default:
      return method;
  }
}

function mapApprovalDecisionToRpcResult(method, params, input) {
  const decision = input.decision || "escalate";
  if (decision === "escalate") {
    return { ok: false, error: "needs-human-fallback" };
  }

  if (method === "item/commandExecution/requestApproval") {
    return {
      ok: true,
      result: {
        decision: decision === "approve" ? "accept" : "decline"
      }
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      ok: true,
      result: {
        decision: decision === "approve" ? "accept" : "decline"
      }
    };
  }

  if (method === "item/permissions/requestApproval" && decision === "approve") {
    return {
      ok: true,
      result: {
        permissions: params.permissions || {},
        scope: "turn"
      }
    };
  }

  return { ok: false, error: "needs-human-fallback" };
}

module.exports = {
  CodexAppServerClient,
  buildAppServerEnv,
  buildApprovalSummary,
  extractTurnSnapshot,
  inferApprovalActionType,
  inferApprovalRisk,
  isApprovalMethod,
  isRetryableThreadReadError,
  mapApprovalDecisionToRpcResult,
  mapCompletedItemEvent,
  mapThreadItemEvent
};





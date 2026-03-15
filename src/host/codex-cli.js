const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const {
  buildApprovalSummary,
  inferApprovalActionType,
  inferApprovalRisk,
  isApprovalMethod,
  mapApprovalDecisionToRpcResult,
  mapCompletedItemEvent,
  CodexAppServerClient
} = require("./app-server-client");
const { mapCodexJsonlLine } = require("./codex-event-parser");
const { createId, safeJsonParse } = require("./utils");

class CodexCliManager {
  constructor(options) {
    this.registry = options.registry;
    this.projectRoot = options.projectRoot;
    this.activeRuns = new Map();
    this.wrapperCommands = new Map();
    this.wrapperPath = path.join(this.projectRoot, "bin", "codex-wrapper.cmd");
    this.appServerClient = new CodexAppServerClient({
      registry: this.registry,
      projectRoot: this.projectRoot
    });
  }

  async launchCliSession(input) {
    const mode = input.mode || "exec-json";
    if (mode === "sdk") {
      return this.appServerClient.launchSdkSession(input);
    }

    if (mode === "tty") {
      return this.launchTtySession(input);
    }

    if (mode === "app-server") {
      return this.appServerClient.launchCliSession(input);
    }

    return this.launchExecJsonSession(input);
  }

  refreshSession(hostSessionId) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      return null;
    }

    if (session.transport === "tty") {
      return this.refreshTtySession(session);
    }

    if (session.transport === "exec-json") {
      if (this.activeRuns.has(hostSessionId)) {
        this.registry.updateSession(hostSessionId, { status: "running" });
        return this.registry.getSession(hostSessionId);
      }

      return this.refreshDetachedProcessSession(session);
    }

    if ((session.transport === "app-server" && session.runtime.mode === "app-server") ||
      (session.transport === "sdk/thread" && session.runtime.mode === "sdk")) {
      return this.appServerClient.refreshSession(hostSessionId);
    }

    if (session.transport === "app-server" && session.runtime.mode === "wrapper-managed") {
      return this.refreshWrapperManagedSession(session);
    }

    return session;
  }

  refreshAllSessions() {
    return this.registry.listSessions().map((session) => this.refreshSession(session.hostSessionId));
  }

  async sendMessage(hostSessionId, prompt) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    if ((session.transport === "app-server" && session.runtime.mode === "app-server") ||
      (session.transport === "sdk/thread" && session.runtime.mode === "sdk")) {
      return this.appServerClient.sendMessage(hostSessionId, prompt);
    }

    if (session.transport === "app-server" && session.runtime.mode === "wrapper-managed") {
      return this.sendWrapperManagedMessage(session, prompt);
    }

    if (session.transport !== "exec-json") {
      const error = new Error(`Session ${hostSessionId} does not support controllable message injection`);
      error.statusCode = 409;
      throw error;
    }

    if (!session.upstreamSessionId) {
      const error = new Error(`Session ${hostSessionId} is not bound to an upstream session yet`);
      error.statusCode = 409;
      throw error;
    }

    if (this.activeRuns.has(hostSessionId)) {
      const error = new Error(`Session ${hostSessionId} is already running`);
      error.statusCode = 409;
      throw error;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "user_input",
      controllability: "controllable",
      payload: { text: prompt, resumed: true }
    });

    return this.runExecJson(hostSessionId, {
      prompt,
      cwd: session.workspaceRoot,
      sandbox: session.runtime.sandbox,
      skipGitRepoCheck: session.runtime.skipGitRepoCheck !== false,
      model: session.runtime.model,
      profile: session.runtime.profile,
      search: Boolean(session.runtime.search),
      resumeSessionId: session.upstreamSessionId
    });
  }

  async handleApprovalDecision(approval, input) {
    const session = this.registry.getSession(approval.hostSessionId);
    if (isWrapperManagedProxySession(session) && approval.rawRequest && approval.rawRequest.source === "wrapper-proxy") {
      return this.handleWrapperApprovalDecision(session, approval, input);
    }

    return this.appServerClient.handleApprovalDecision(approval, input);
  }

  claimWrapperCommands(hostSessionId) {
    const queue = this.ensureWrapperCommandQueue(hostSessionId);
    const commands = queue.pending.splice(0);
    for (const command of commands) {
      command.status = "dispatched";
      command.dispatchedAt = new Date().toISOString();
      queue.inFlight.set(command.commandId, command);
    }
    return commands;
  }

  completeWrapperCommand(hostSessionId, commandId, input) {
    const queue = this.ensureWrapperCommandQueue(hostSessionId);
    const command = queue.inFlight.get(commandId) || null;
    if (!command) {
      const error = new Error(`Unknown wrapper command: ${commandId}`);
      error.statusCode = 404;
      throw error;
    }

    queue.inFlight.delete(commandId);
    command.status = input && input.ok === false ? "failed" : "completed";
    command.completedAt = new Date().toISOString();
    command.result = input || {};

    this.registry.appendEvent(hostSessionId, {
      kind: command.status === "failed" ? "wrapper_command_failed" : "wrapper_command_completed",
      controllability: "controllable",
      payload: {
        commandId,
        kind: command.kind,
        ok: command.status !== "failed",
        result: input || {}
      }
    });

    return command;
  }

  async launchIdeSession(input) {
    const mode = input.mode || "wrapper-managed";
    if (mode !== "wrapper-managed") {
      const error = new Error(`Unsupported IDE mode: ${mode}`);
      error.statusCode = 400;
      throw error;
    }

    const workspaceRoot = input.cwd || this.projectRoot;
    const hostUrl = input.hostUrl || "http://127.0.0.1:7788";
    const record = this.registry.createSession({
      source: "ide",
      transport: "app-server",
      workspaceRoot,
      runtime: {
        mode,
        wrapperPath: this.wrapperPath
      },
      metadata: {
        experimental: true
      },
      transportCapabilities: wrapperManagedCapabilities()
    });

    this.registry.appendEvent(record.hostSessionId, {
      kind: "wrapper_launch_prepared",
      controllability: "observed",
      payload: {
        mode,
        experimental: true,
        wrapperPath: this.wrapperPath,
        note: "Wrapper-managed IDE sessions are experimental in this prototype."
      }
    });

    return {
      record,
      wrapperLaunchInfo: {
        wrapperPath: this.wrapperPath,
        hostUrl,
        workspaceRoot,
        env: {
          AI_HOST_URL: hostUrl,
          AI_HOST_SESSION_ID: record.hostSessionId
        }
      }
    };
  }

  async registerWrapperSession(input) {
    const workspaceRoot = input.cwd || this.projectRoot;
    let record = null;

    if (input.hostSessionId) {
      record = this.registry.getSession(input.hostSessionId);
    }

    if (!record) {
      record = this.registry.createSession({
        source: "ide",
        transport: "app-server",
        workspaceRoot,
        runtime: {
          mode: "wrapper-managed"
        },
        metadata: {
          argv: input.argv || []
        },
        transportCapabilities: wrapperManagedCapabilities()
      });
    }

    this.registry.updateSession(record.hostSessionId, {
      status: "running",
      workspaceRoot,
      metadata: {
        ...(record.metadata || {}),
        argv: input.argv || []
      }
    });
    this.registry.appendEvent(record.hostSessionId, {
      kind: "session_started",
      controllability: "observed",
      payload: {
        source: "wrapper",
        argv: input.argv || []
      }
    });

    return record;
  }

  async updateWrapperRuntime(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown wrapper session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const runtime = {
      ...(session.runtime || {}),
      processId: input.processId || null,
      realCodex: input.realCodex || null,
      proxyMode: input.proxyMode || null,
      launchedAt: input.launchedAt || new Date().toISOString(),
      wrapperReported: true
    };

    this.registry.updateSession(hostSessionId, {
      status: "running",
      runtime,
      metadata: {
        ...(session.metadata || {}),
        argv: Array.isArray(input.argv) ? input.argv : ((session.metadata && session.metadata.argv) || [])
      }
    });
    this.registry.appendEvent(hostSessionId, {
      kind: "wrapper_runtime_reported",
      controllability: "observed",
      payload: {
        processId: runtime.processId,
        realCodex: runtime.realCodex,
        proxyMode: runtime.proxyMode,
        argv: Array.isArray(input.argv) ? input.argv : []
      }
    });

    return this.registry.getSession(hostSessionId);
  }

  sendWrapperManagedMessage(session, prompt) {
    if (!isWrapperManagedProxySession(session)) {
      const error = new Error(`Session ${session.hostSessionId} does not support wrapper-managed message injection`);
      error.statusCode = 409;
      throw error;
    }

    if (!session.upstreamSessionId) {
      const error = new Error(`Session ${session.hostSessionId} is not bound to an upstream session yet`);
      error.statusCode = 409;
      throw error;
    }

    this.registry.appendEvent(session.hostSessionId, {
      kind: "user_input",
      controllability: "controllable",
      payload: {
        text: prompt,
        resumed: true,
        transport: "wrapper-managed"
      }
    });

    const command = this.enqueueWrapperCommand(session.hostSessionId, {
      kind: "start_turn",
      payload: {
        threadId: session.upstreamSessionId,
        prompt
      }
    });

    return {
      queued: true,
      commandId: command.commandId
    };
  }

  handleWrapperApprovalDecision(session, approval, input) {
    const rawRequest = approval.rawRequest || {};
    const mapped = mapApprovalDecisionToRpcResult(rawRequest.method, rawRequest.params || {}, input);
    if (!mapped.ok) {
      return {
        handled: true,
        ok: false,
        error: mapped.error
      };
    }

    const command = this.enqueueWrapperCommand(session.hostSessionId, {
      kind: "approval_response",
      payload: {
        rpcRequestId: rawRequest.rpcRequestId,
        method: rawRequest.method,
        result: mapped.result
      }
    });

    this.registry.appendEvent(session.hostSessionId, {
      kind: "approval_result_upstream",
      controllability: "controllable",
      payload: {
        requestId: approval.requestId,
        rpcRequestId: rawRequest.rpcRequestId,
        method: rawRequest.method,
        decision: input.decision || "escalate",
        commandId: command.commandId,
        transport: "wrapper-managed"
      }
    });

    return {
      handled: true,
      ok: true,
      commandId: command.commandId
    };
  }

  enqueueWrapperCommand(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown wrapper session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const queue = this.ensureWrapperCommandQueue(hostSessionId);
    const command = {
      commandId: createId("wrappercmd"),
      kind: input.kind,
      payload: input.payload || {},
      status: "queued",
      createdAt: new Date().toISOString()
    };

    queue.pending.push(command);
    this.registry.appendEvent(hostSessionId, {
      kind: "wrapper_command_queued",
      controllability: "controllable",
      payload: {
        commandId: command.commandId,
        kind: command.kind
      }
    });

    return command;
  }

  ensureWrapperCommandQueue(hostSessionId) {
    let queue = this.wrapperCommands.get(hostSessionId);
    if (!queue) {
      queue = {
        pending: [],
        inFlight: new Map()
      };
      this.wrapperCommands.set(hostSessionId, queue);
    }
    return queue;
  }

  async recordWrapperEvent(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown wrapper session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const direction = input.direction || "stdout";
    if (direction === "stderr") {
      this.registry.appendEvent(hostSessionId, {
        kind: "stderr",
        controllability: "observed",
        payload: {
          line: input.line || "",
          source: "wrapper-proxy"
        }
      });
      return this.registry.getSession(hostSessionId);
    }

    const parsed = input.message || safeJsonParse(input.line || "");
    const message = parsed && parsed.ok === false
      ? null
      : (parsed && Object.prototype.hasOwnProperty.call(parsed, "value") ? parsed.value : parsed);

    if (!message) {
      this.registry.appendEvent(hostSessionId, {
        kind: direction === "stdin" ? "raw_stdin" : "raw_stdout",
        controllability: "observed",
        payload: {
          line: input.line || "",
          source: "wrapper-proxy"
        }
      });
      return this.registry.getSession(hostSessionId);
    }

    if (direction === "stdin") {
      this.recordWrapperClientMessage(hostSessionId, message, input);
      return this.registry.getSession(hostSessionId);
    }

    this.recordWrapperServerMessage(hostSessionId, message);
    return this.registry.getSession(hostSessionId);
  }

  recordWrapperClientMessage(hostSessionId, message, input) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method && input.relatedApprovalMethod) {
      const approval = this.findPendingApprovalByRpcRequestId(hostSessionId, message.id);
      if (approval) {
        this.registry.resolveApproval(approval.requestId, {
          decision: inferObservedApprovalDecision(message),
          decidedBy: "client",
          reason: "wrapper_proxy_observed",
          controllability: "observed"
        });
      }

      this.registry.appendEvent(hostSessionId, {
        kind: "approval_result_observed",
        controllability: "observed",
        payload: {
          rpcRequestId: message.id,
          method: input.relatedApprovalMethod,
          result: message.result || null,
          error: message.error || null
        }
      });
      return;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "client_message_observed",
      controllability: "observed",
      payload: message
    });
  }

  recordWrapperServerMessage(hostSessionId, message) {
    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      if (isApprovalMethod(message.method)) {
        const approval = this.registry.createApproval(hostSessionId, {
          riskLevel: inferApprovalRisk(message.method),
          actionType: inferApprovalActionType(message.method),
          summary: buildApprovalSummary(message.method, message.params || {}),
          rawRequest: {
            rpcRequestId: message.id,
            method: message.method,
            params: message.params || {},
            source: "wrapper-proxy"
          },
          controllability: "observed"
        });
        this.registry.appendEvent(hostSessionId, {
          kind: "approval_request_observed",
          controllability: "observed",
          payload: {
            requestId: approval.requestId,
            method: message.method,
            rpcRequestId: message.id,
            source: "wrapper-proxy"
          }
        });
        return;
      }

      this.registry.appendEvent(hostSessionId, {
        kind: "server_request",
        controllability: "observed",
        payload: {
          source: "wrapper-proxy",
          message
        }
      });
      return;
    }

    if (message.method) {
      this.applyWrapperNotification(hostSessionId, message);
      return;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "raw_rpc_response",
      controllability: "observed",
      payload: {
        source: "wrapper-proxy",
        message
      }
    });
  }

  applyWrapperNotification(hostSessionId, message) {
    const method = message.method;
    const params = message.params || {};

    if (method === "thread/started" && params.thread && params.thread.id) {
      this.registry.bindUpstreamSession(hostSessionId, params.thread.id);
      this.registry.appendEvent(hostSessionId, {
        kind: "session_started",
        controllability: "observed",
        payload: {
          source: "wrapper-proxy",
          thread: params.thread
        }
      });
      return;
    }

    if (method === "turn/started") {
      this.registry.updateSession(hostSessionId, { status: "running" });
      this.registry.appendEvent(hostSessionId, {
        kind: "turn_started",
        controllability: "observed",
        payload: params
      });
      return;
    }

    if (method === "turn/completed" || method === "codex/event/task_complete") {
      this.registry.updateSession(hostSessionId, { status: "running" });
      this.registry.appendEvent(hostSessionId, {
        kind: "turn_completed",
        controllability: "observed",
        payload: params
      });
      return;
    }

    if (method === "item/agentMessage/delta") {
      this.registry.appendEvent(hostSessionId, {
        kind: "assistant_output_delta",
        controllability: "observed",
        payload: {
          text: params.delta || "",
          raw: params
        }
      });
      return;
    }

    if (method === "codex/event/agent_message_content_delta") {
      const msg = params.msg || {};
      this.registry.appendEvent(hostSessionId, {
        kind: "assistant_output_delta",
        controllability: "observed",
        payload: {
          text: msg.delta || "",
          raw: {
            threadId: msg.thread_id || null,
            turnId: msg.turn_id || null,
            itemId: msg.item_id || null,
            delta: msg.delta || ""
          }
        }
      });
      return;
    }

    if (method === "item/completed" || method === "codex/event/item_completed") {
      const mapped = mapCompletedItemEvent(normalizeWrapperCompletedParams(message));
      if (mapped) {
        mapped.controllability = "observed";
        this.registry.appendEvent(hostSessionId, mapped);
        return;
      }
    }

    if (method === "thread/compacted") {
      this.registry.appendEvent(hostSessionId, {
        kind: "context_compacted",
        controllability: "observed",
        payload: params
      });
      return;
    }

    if (method === "error") {
      this.registry.updateSession(hostSessionId, { status: "failed" });
      this.registry.appendEvent(hostSessionId, {
        kind: "error",
        controllability: "observed",
        payload: params
      });
      return;
    }

    this.registry.appendEvent(hostSessionId, {
      kind: "raw_event",
      controllability: "observed",
      payload: {
        source: "wrapper-proxy",
        message
      }
    });
  }

  findPendingApprovalByRpcRequestId(hostSessionId, rpcRequestId) {
    return this.registry.listApprovals({ hostSessionId, status: "pending" }).find((approval) => {
      return approval.rawRequest && approval.rawRequest.rpcRequestId === rpcRequestId;
    }) || null;
  }

  async markWrapperCompleted(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown wrapper session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    this.registry.updateSession(hostSessionId, {
      status: input.exitCode === 0 ? "ended" : "failed"
    });
    this.registry.appendEvent(hostSessionId, {
      kind: "session_ended",
      controllability: "observed",
      payload: {
        exitCode: input.exitCode,
        signal: input.signal || null
      }
    });

    return session;
  }

  launchTtySession(input) {
    const workspaceRoot = input.cwd || this.projectRoot;
    const prompt = input.prompt || "";
    const record = this.registry.createSession({
      source: "cli",
      transport: "tty",
      workspaceRoot,
      runtime: {
        mode: "tty",
        sandbox: input.sandbox || "workspace-write"
      }
    });

    const command = buildTtyStartCommand(workspaceRoot, prompt);
    const child = spawn(command, {
      cwd: workspaceRoot,
      shell: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    this.registry.updateSession(record.hostSessionId, {
      status: "running",
      runtime: {
        ...(record.runtime || {}),
        processId: child.pid,
        launchedAt: new Date().toISOString(),
        command
      }
    });
    this.registry.appendEvent(record.hostSessionId, {
      kind: "session_started",
      controllability: "observed",
      payload: {
        mode: "tty",
        command
      }
    });

    if (prompt) {
      this.registry.appendEvent(record.hostSessionId, {
        kind: "user_input",
        controllability: "observed",
        payload: {
          text: prompt
        }
      });
    }

    return {
      record,
      terminalLaunchInfo: {
        mode: "tty",
        command
      }
    };
  }

  async launchExecJsonSession(input) {
    const workspaceRoot = input.cwd || this.projectRoot;
    const record = this.registry.createSession({
      source: "cli",
      transport: "exec-json",
      workspaceRoot,
      runtime: {
        mode: "exec-json",
        sandbox: input.sandbox || "read-only",
        skipGitRepoCheck: input.skipGitRepoCheck !== false,
        model: input.model || null,
        profile: input.profile || null,
        search: Boolean(input.search)
      }
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
    }

    await this.runExecJson(record.hostSessionId, {
      prompt: input.prompt || "",
      cwd: workspaceRoot,
      sandbox: record.runtime.sandbox,
      skipGitRepoCheck: record.runtime.skipGitRepoCheck,
      model: record.runtime.model,
      profile: record.runtime.profile,
      search: record.runtime.search,
      resumeSessionId: null
    });

    return {
      record: this.registry.getSession(record.hostSessionId),
      terminalLaunchInfo: null
    };
  }

  runExecJson(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const args = buildExecArgs(input);
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "codex", ...args], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.activeRuns.set(hostSessionId, child);
    this.registry.updateSession(hostSessionId, {
      status: "running",
      runtime: {
        ...(session.runtime || {}),
        processId: child.pid,
        launchedAt: new Date().toISOString()
      }
    });

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      const parsed = safeJsonParse(line);
      if (!parsed.ok) {
        this.registry.appendEvent(hostSessionId, {
          kind: "raw_stdout",
          controllability: "observed",
          payload: { line }
        });
        return;
      }

      const mapped = mapCodexJsonlLine(line);
      if (mapped.sessionPatch && mapped.sessionPatch.upstreamSessionId) {
        this.registry.bindUpstreamSession(hostSessionId, mapped.sessionPatch.upstreamSessionId);
      } else if (mapped.sessionPatch) {
        this.registry.updateSession(hostSessionId, mapped.sessionPatch);
      }

      if (mapped.event) {
        this.registry.appendEvent(hostSessionId, mapped.event);
      }
    });

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      this.registry.appendEvent(hostSessionId, {
        kind: "stderr",
        controllability: "observed",
        payload: { line }
      });
    });

    return new Promise((resolve, reject) => {
      child.on("error", (error) => {
        this.activeRuns.delete(hostSessionId);
        this.registry.failRegistration(hostSessionId, error.message);
        this.registry.appendEvent(hostSessionId, {
          kind: "error",
          controllability: "observed",
          payload: {
            message: error.message
          }
        });
        reject(error);
      });

      child.on("exit", (code, signal) => {
        this.activeRuns.delete(hostSessionId);
        const status = code === 0 ? "ended" : "failed";
        this.registry.updateSession(hostSessionId, { status });
        this.registry.appendEvent(hostSessionId, {
          kind: "session_ended",
          controllability: "observed",
          payload: { code, signal }
        });

        if (code === 0) {
          resolve(this.registry.getSession(hostSessionId));
          return;
        }

        const error = new Error(`codex exited with code ${code}`);
        error.statusCode = 502;
        reject(error);
      });
    });
  }

  refreshDetachedProcessSession(session) {
    const processId = session.runtime && session.runtime.processId;
    if (!processId) {
      return session;
    }

    const isAlive = processExists(processId);
    if (isAlive) {
      if (session.status !== "running") {
        this.registry.updateSession(session.hostSessionId, { status: "running" });
      }
      return this.registry.getSession(session.hostSessionId);
    }

    if (session.status === "running" || session.status === "starting" || session.status === "waiting_approval") {
      this.registry.updateSession(session.hostSessionId, { status: "ended" });
      this.registry.appendEvent(session.hostSessionId, {
        kind: "session_ended",
        controllability: "observed",
        payload: {
          reason: "process_not_running",
          processId
        }
      });
    }

    return this.registry.getSession(session.hostSessionId);
  }

  refreshWrapperManagedSession(session) {
    const processId = session.runtime && session.runtime.processId;
    if (!processId) {
      return session;
    }

    const isAlive = processExists(processId);
    if (isAlive) {
      if (session.status !== "running") {
        this.registry.updateSession(session.hostSessionId, { status: "running" });
      }
      return this.registry.getSession(session.hostSessionId);
    }

    if (session.status === "running" || session.status === "starting" || session.status === "waiting_approval") {
      this.registry.updateSession(session.hostSessionId, { status: "ended" });
      this.registry.appendEvent(session.hostSessionId, {
        kind: "session_ended",
        controllability: "observed",
        payload: {
          reason: "wrapper_process_not_running",
          processId
        }
      });
    }

    return this.registry.getSession(session.hostSessionId);
  }

  refreshTtySession(session) {
    const processId = session.runtime && session.runtime.processId;
    if (!processId) {
      return session;
    }

    const isAlive = processExists(processId);
    if (isAlive) {
      if (session.status !== "running") {
        this.registry.updateSession(session.hostSessionId, { status: "running" });
      }
      return this.registry.getSession(session.hostSessionId);
    }

    if (session.status === "running" || session.status === "starting") {
      this.registry.updateSession(session.hostSessionId, { status: "ended" });
      this.registry.appendEvent(session.hostSessionId, {
        kind: "session_ended",
        controllability: "observed",
        payload: {
          reason: "tty_process_not_running",
          processId
        }
      });
    }

    return this.registry.getSession(session.hostSessionId);
  }
}

function normalizeWrapperCompletedParams(message) {
  const params = message.params || {};
  if (message.method === "item/completed") {
    return params;
  }

  if (message.method === "codex/event/item_completed") {
    const msg = params.msg || {};
    return {
      item: normalizeWrapperItem(msg.item || {}),
      threadId: msg.thread_id || null,
      turnId: msg.turn_id || null
    };
  }

  return params;
}

function normalizeWrapperItem(item) {
  if (!item || !item.type) {
    return item;
  }

  if (item.type === "AgentMessage") {
    return {
      type: "agentMessage",
      id: item.id,
      text: extractWrapperText(item),
      phase: item.phase || null
    };
  }

  if (item.type === "UserMessage") {
    return {
      type: "userMessage",
      id: item.id,
      text: extractWrapperText(item)
    };
  }

  return item;
}

function extractWrapperText(item) {
  if (typeof item.text === "string") {
    return item.text;
  }

  if (Array.isArray(item.content)) {
    return item.content
      .filter((entry) => entry && (entry.type === "Text" || entry.type === "text"))
      .map((entry) => entry.text || "")
      .join("");
  }

  return "";
}

function inferObservedApprovalDecision(message) {
  if (message.error) {
    return "deny";
  }

  if (message.result && message.result.permissions) {
    return "approve";
  }

  if (message.result && message.result.decision === "accept") {
    return "approve";
  }

  if (message.result && message.result.decision === "decline") {
    return "deny";
  }

  return "approve";
}

function isWrapperManagedProxySession(session) {
  return Boolean(session) &&
    session.transport === "app-server" &&
    session.runtime &&
    session.runtime.mode === "wrapper-managed" &&
    session.runtime.proxyMode === "app-server";
}

function wrapperManagedCapabilities() {
  return {
    sessionRegistration: "supported",
    outputCollection: "limited",
    messageInjection: "conditional",
    autoHitl: "poc"
  };
}

function buildExecArgs(input) {
  const args = ["exec"];
  const trailingPrompt = input.prompt || "";

  if (input.resumeSessionId) {
    args.push("resume");
  }

  if (input.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (!input.resumeSessionId && input.sandbox) {
    args.push("--sandbox", input.sandbox);
  }

  if (input.profile) {
    args.push("--profile", input.profile);
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  if (!input.resumeSessionId && input.search) {
    args.push("--search");
  }

  args.push("--json");

  if (input.resumeSessionId) {
    args.push(input.resumeSessionId);
  }

  args.push(trailingPrompt);
  return args;
}

function buildTtyStartCommand(cwd, prompt) {
  const codexPart = prompt ? `codex "${escapeDoubleQuotes(prompt)}"` : "codex";
  return `start "" cmd.exe /k "cd /d ""${cwd}"" && ${codexPart}"`;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function escapeDoubleQuotes(value) {
  return String(value).replace(/"/g, '\\"');
}

module.exports = {
  CodexCliManager
};




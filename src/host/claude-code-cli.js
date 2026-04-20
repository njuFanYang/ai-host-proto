const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const { mapClaudeStreamJsonLine } = require("./claude-code-event-parser");
const { safeJsonParse } = require("./utils");

const HOOK_MARKER = "__aiHostProtoApprovalHook__";

class ClaudeCodeManager {
  constructor(options) {
    this.registry = options.registry;
    this.projectRoot = options.projectRoot;
    this.hostUrl = options.hostUrl || process.env.AI_HOST_INTERNAL_URL || "http://127.0.0.1:7788";
    this.claudeCommand = options.claudeCommand || process.env.AI_HOST_CLAUDE_BIN || "claude";
    this.hookScriptPath = options.hookScriptPath
      || path.resolve(__dirname, "..", "..", "scripts", "claude-hook-approval.js");
    this.activeRuns = new Map();
    this.onSessionAvailable = null;
  }

  async launchCliSession(input) {
    return this.launchStreamJsonSession(input);
  }

  stopSession(hostSessionId) {
    const child = this.activeRuns.get(hostSessionId);
    if (!child || typeof child.kill !== "function") {
      return false;
    }
    try {
      child.kill();
      return true;
    } catch (_error) {
      return false;
    }
  }

  refreshSession(hostSessionId) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      return null;
    }

    if (session.transport !== "stream-json") {
      return session;
    }

    if (this.activeRuns.has(hostSessionId)) {
      if (session.status !== "running") {
        this.registry.updateSession(hostSessionId, { status: "running" });
      }
      return this.registry.getSession(hostSessionId);
    }

    return this.refreshDetachedProcessSession(session);
  }

  refreshAllSessions() {
    return this.registry.listSessions().map((session) => this.refreshSession(session.hostSessionId));
  }

  async dispatchTransportMessage(hostSessionId, prompt) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    if (session.transport !== "stream-json") {
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

    return this.runStreamJson(hostSessionId, {
      prompt,
      cwd: session.workspaceRoot,
      permissionMode: session.runtime.permissionMode,
      model: session.runtime.model,
      resumeSessionId: session.upstreamSessionId
    });
  }

  async sendMessage(hostSessionId, prompt) {
    return this.dispatchTransportMessage(hostSessionId, prompt);
  }

  async handleApprovalDecision(_approval, _input) {
    // Claude Code hooks pull decisions via the /approvals/{id} polling path,
    // so the manager has nothing to push back over an RPC channel.
    return { ok: true, handled: false };
  }

  async launchStreamJsonSession(input) {
    const workspaceRoot = input.cwd || this.projectRoot;
    const record = this.registry.createSession({
      source: "cli",
      transport: "stream-json",
      workspaceRoot,
      runtime: {
        mode: "stream-json",
        permissionMode: input.permissionMode || "default",
        model: input.model || null
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

    try {
      this.ensureHookInstalled(workspaceRoot);
    } catch (error) {
      this.registry.appendEvent(record.hostSessionId, {
        kind: "hook_install_warning",
        controllability: "observed",
        payload: { message: error.message }
      });
    }

    await this.runStreamJson(record.hostSessionId, {
      prompt: input.prompt || "",
      cwd: workspaceRoot,
      permissionMode: record.runtime.permissionMode,
      model: record.runtime.model,
      resumeSessionId: null
    });

    return {
      record: this.registry.getSession(record.hostSessionId),
      terminalLaunchInfo: null
    };
  }

  runStreamJson(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const args = buildClaudeArgs(input);
    const child = spawn(this.claudeCommand, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AI_HOST_SESSION_ID: hostSessionId,
        AI_HOST_URL: this.hostUrl
      },
      shell: process.platform === "win32"
    });

    this.activeRuns.set(hostSessionId, child);
    this.registry.updateSession(hostSessionId, {
      status: "running",
      runtime: {
        ...(session.runtime || {}),
        processId: child.pid,
        launchedAt: new Date().toISOString(),
        command: `${this.claudeCommand} ${args.join(" ")}`
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

      const mapped = mapClaudeStreamJsonLine(line);
      if (mapped.sessionPatch && mapped.sessionPatch.upstreamSessionId) {
        this.registry.bindUpstreamSession(hostSessionId, mapped.sessionPatch.upstreamSessionId);
        const rest = { ...mapped.sessionPatch };
        delete rest.upstreamSessionId;
        if (Object.keys(rest).length > 0) {
          this.registry.updateSession(hostSessionId, rest);
        }
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
          payload: { message: error.message }
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

        if (typeof this.onSessionAvailable === "function") {
          void this.onSessionAvailable(hostSessionId);
        }

        if (code === 0) {
          resolve({ ok: true, hostSessionId, code });
          return;
        }

        const error = new Error(`claude exited with code ${code}`);
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
        payload: { reason: "process_not_running", processId }
      });
    }

    return this.registry.getSession(session.hostSessionId);
  }

  ensureHookInstalled(workspaceRoot) {
    const settingsDir = path.join(workspaceRoot, ".claude");
    const settingsPath = path.join(settingsDir, "settings.local.json");
    fs.mkdirSync(settingsDir, { recursive: true });

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, "utf8");
        settings = raw.trim() ? JSON.parse(raw) : {};
      } catch (_error) {
        settings = {};
      }
    }

    const hookCommand = buildHookCommand(this.hookScriptPath);
    const hooks = settings.hooks && typeof settings.hooks === "object" ? { ...settings.hooks } : {};
    const existingPreToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.slice() : [];

    const filtered = existingPreToolUse.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return true;
      }
      return entry[HOOK_MARKER] !== true;
    });

    filtered.push({
      [HOOK_MARKER]: true,
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: hookCommand
        }
      ]
    });

    hooks.PreToolUse = filtered;
    settings.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
}

function buildClaudeArgs(input) {
  const args = [];
  const prompt = input.prompt || "";

  args.push("-p", prompt);
  args.push("--output-format", "stream-json");
  args.push("--verbose");

  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  }

  if (input.permissionMode) {
    args.push("--permission-mode", input.permissionMode);
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  return args;
}

function buildHookCommand(hookScriptPath) {
  const normalized = hookScriptPath.replace(/\\/g, "/");
  return `node "${normalized}"`;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  ClaudeCodeManager,
  HOOK_MARKER
};

const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const { mapCodexJsonlLine } = require("./codex-event-parser");
const { safeJsonParse } = require("./utils");

class CodexCliManager {
  constructor(options) {
    this.registry = options.registry;
    this.projectRoot = options.projectRoot;
    this.activeRuns = new Map();
    this.wrapperPath = path.join(this.projectRoot, "bin", "codex-wrapper.cmd");
  }

  async launchCliSession(input) {
    const mode = input.mode || "exec-json";
    if (mode === "sdk") {
      const error = new Error("sdk mode is planned but not implemented in this prototype");
      error.statusCode = 501;
      throw error;
    }

    if (mode === "tty") {
      return this.launchTtySession(input);
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
      }
      return this.registry.getSession(hostSessionId);
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
      }
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
        }
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
      status: "running"
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

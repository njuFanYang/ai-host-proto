#!/usr/bin/env node
const { spawn } = require("node:child_process");
const readline = require("node:readline");

async function main() {
  const hostUrl = process.env.AI_HOST_URL || "http://127.0.0.1:7788";
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const realCodex = process.env.AI_HOST_REAL_CODEX || "codex";
  const proxyMode = argv[0] === "app-server" ? "app-server" : null;

  let hostSessionId = process.env.AI_HOST_SESSION_ID || null;
  try {
    const response = await fetch(`${hostUrl}/internal/wrappers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, argv, hostSessionId })
    });

    if (response.ok) {
      const body = await response.json();
      hostSessionId = body.hostSessionId || null;
    }
  } catch (_error) {
    hostSessionId = null;
  }

  const child = spawn("cmd.exe", ["/d", "/s", "/c", realCodex, ...argv], {
    cwd,
    stdio: proxyMode ? ["pipe", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      AI_HOST_SESSION_ID: hostSessionId || ""
    }
  });

  if (hostSessionId) {
    await postJsonBestEffort(`${hostUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/runtime`, {
      processId: child.pid,
      realCodex,
      argv,
      launchedAt: new Date().toISOString(),
      proxyMode
    });
  }

  const stopProxy = proxyMode
    ? startAppServerProxy({ child, hostSessionId, hostUrl })
    : null;

  child.on("exit", async (code, signal) => {
    if (typeof stopProxy === "function") {
      await stopProxy({ reason: "exit", exitCode: code || 0 });
    }

    if (hostSessionId) {
      await postJsonBestEffort(`${hostUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/complete`, {
        exitCode: code || 0,
        signal: signal || null,
        processId: child.pid
      });
    }

    process.exit(code || 0);
  });

  child.on("error", async (_error) => {
    if (typeof stopProxy === "function") {
      await stopProxy({ reason: "error", exitCode: 1 });
    }

    if (hostSessionId) {
      await postJsonBestEffort(`${hostUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/complete`, {
        exitCode: 1,
        signal: null,
        processId: child.pid || null
      });
    }

    process.exit(1);
  });
}

function startAppServerProxy(input) {
  const pendingApprovalMethods = new Map();
  const hostInjectedRequests = new Map();
  const hostResolvedApprovalIds = new Set();
  let pollTimer = null;
  let polling = false;
  let stopped = false;

  const stdoutReader = readline.createInterface({ input: input.child.stdout, crlfDelay: Infinity });
  stdoutReader.on("line", (line) => {
    const parsed = tryParseJson(line);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "id") && !parsed.method) {
      const requestKey = normalizeRequestId(parsed.id);
      const injected = hostInjectedRequests.get(requestKey) || null;
      if (injected) {
        hostInjectedRequests.delete(requestKey);
        void completeCommandBestEffort(input.hostUrl, input.hostSessionId, injected.commandId, {
          ok: !parsed.error,
          response: parsed.result || null,
          error: parsed.error || null,
          rpcRequestId: parsed.id,
          leaseToken: injected.leaseToken
        });
        return;
      }
    }

    process.stdout.write(`${line}\n`);
    if (parsed && parsed.method && Object.prototype.hasOwnProperty.call(parsed, "id") && isApprovalMethod(parsed.method)) {
      pendingApprovalMethods.set(normalizeRequestId(parsed.id), parsed.method);
    }
    if (input.hostSessionId) {
      void postJsonBestEffort(`${input.hostUrl}/internal/wrappers/${encodeURIComponent(input.hostSessionId)}/events`, {
        direction: "stdout",
        line
      });
    }
  });

  const stderrReader = readline.createInterface({ input: input.child.stderr, crlfDelay: Infinity });
  stderrReader.on("line", (line) => {
    process.stderr.write(`${line}\n`);
    if (input.hostSessionId) {
      void postJsonBestEffort(`${input.hostUrl}/internal/wrappers/${encodeURIComponent(input.hostSessionId)}/events`, {
        direction: "stderr",
        line
      });
    }
  });

  const stdinReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinReader.on("line", (line) => {
    const parsed = tryParseJson(line);
    let relatedApprovalMethod = null;
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "id") && !parsed.method) {
      const requestKey = normalizeRequestId(parsed.id);
      relatedApprovalMethod = pendingApprovalMethods.get(requestKey) || null;
      if (hostResolvedApprovalIds.has(requestKey)) {
        hostResolvedApprovalIds.delete(requestKey);
        pendingApprovalMethods.delete(requestKey);
        return;
      }
      if (relatedApprovalMethod) {
        pendingApprovalMethods.delete(requestKey);
      }
    }

    input.child.stdin.write(`${line}\n`);
    if (input.hostSessionId) {
      void postJsonBestEffort(`${input.hostUrl}/internal/wrappers/${encodeURIComponent(input.hostSessionId)}/events`, {
        direction: "stdin",
        line,
        relatedApprovalMethod
      });
    }
  });

  process.stdin.on("end", () => {
    input.child.stdin.end();
  });

  if (input.hostSessionId) {
    schedulePoll();
  }

  return async function stopProxy(stopInput = {}) {
    if (stopped) {
      return;
    }

    stopped = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    const pendingCommands = Array.from(hostInjectedRequests.values());
    hostInjectedRequests.clear();
    await Promise.all(pendingCommands.map((entry) => {
      return completeCommandBestEffort(input.hostUrl, input.hostSessionId, entry.commandId, {
        ok: false,
        leaseToken: entry.leaseToken,
        error: {
          message: `wrapper proxy stopped before response: ${stopInput.reason || "stopped"}`
        }
      });
    }));
  };

  function schedulePoll() {
    if (stopped || !input.hostSessionId) {
      return;
    }

    pollTimer = setTimeout(() => {
      void pollCommands();
    }, 400);
  }

  async function pollCommands() {
    if (stopped || polling || !input.hostSessionId) {
      return;
    }

    polling = true;
    try {
      const response = await fetch(`${input.hostUrl}/internal/wrappers/${encodeURIComponent(input.hostSessionId)}/commands`);
      if (!response.ok) {
        return;
      }

      const body = await response.json();
      const commands = Array.isArray(body.commands) ? body.commands : [];
      for (const command of commands) {
        await executeCommand(command);
      }
    } catch (_error) {
      // Best effort only.
    } finally {
      polling = false;
      schedulePoll();
    }
  }

  async function executeCommand(command) {
    try {
      if (command.kind === "approval_response") {
        const requestKey = normalizeRequestId(command.payload.rpcRequestId);
        hostResolvedApprovalIds.add(requestKey);
        pendingApprovalMethods.delete(requestKey);
        input.child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: command.payload.rpcRequestId,
          result: command.payload.result || {}
        })}\n`);
        await completeCommandBestEffort(input.hostUrl, input.hostSessionId, command.commandId, {
          ok: true,
          rpcRequestId: command.payload.rpcRequestId,
          leaseToken: command.leaseToken
        });
        return;
      }

      if (command.kind === "start_turn") {
        const hostRpcId = `host-${command.commandId}`;
        hostInjectedRequests.set(normalizeRequestId(hostRpcId), {
          commandId: command.commandId,
          kind: command.kind,
          leaseToken: command.leaseToken
        });
        input.child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: hostRpcId,
          method: "turn/start",
          params: {
            threadId: command.payload.threadId,
            input: [
              {
                type: "text",
                text: command.payload.prompt || ""
              }
            ]
          }
        })}\n`);
        return;
      }

      await completeCommandBestEffort(input.hostUrl, input.hostSessionId, command.commandId, {
        ok: false,
        leaseToken: command.leaseToken,
        error: {
          message: `unsupported wrapper command: ${command.kind}`
        }
      });
    } catch (error) {
      await completeCommandBestEffort(input.hostUrl, input.hostSessionId, command.commandId, {
        ok: false,
        leaseToken: command.leaseToken,
        error: {
          message: error.message
        }
      });
    }
  }
}

function isApprovalMethod(method) {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval";
}

function normalizeRequestId(id) {
  return typeof id === "string" ? id : JSON.stringify(id);
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
}

async function completeCommandBestEffort(hostUrl, hostSessionId, commandId, payload) {
  if (!hostUrl || !hostSessionId || !commandId) {
    return;
  }

  await postJsonBestEffort(`${hostUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/commands/${encodeURIComponent(commandId)}/complete`, payload);
}

async function postJsonBestEffort(url, payload) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_error) {
    // Best effort only.
  }
}

main();

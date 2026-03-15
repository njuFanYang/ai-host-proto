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

  if (proxyMode) {
    startAppServerProxy({ child, hostSessionId, hostUrl });
  }

  child.on("exit", async (code, signal) => {
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

  const stdoutReader = readline.createInterface({ input: input.child.stdout, crlfDelay: Infinity });
  stdoutReader.on("line", (line) => {
    process.stdout.write(`${line}\n`);
    const parsed = tryParseJson(line);
    if (parsed && parsed.method && Object.prototype.hasOwnProperty.call(parsed, "id") && isApprovalMethod(parsed.method)) {
      pendingApprovalMethods.set(parsed.id, parsed.method);
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
    input.child.stdin.write(`${line}\n`);
    const parsed = tryParseJson(line);
    let relatedApprovalMethod = null;
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "id") && !parsed.method) {
      relatedApprovalMethod = pendingApprovalMethods.get(parsed.id) || null;
      if (relatedApprovalMethod) {
        pendingApprovalMethods.delete(parsed.id);
      }
    }
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
}

function isApprovalMethod(method) {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval";
}

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
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

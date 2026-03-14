#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");

async function main() {
  const hostUrl = process.env.AI_HOST_URL || "http://127.0.0.1:7788";
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const realCodex = process.env.AI_HOST_REAL_CODEX || "codex";

  let hostSessionId = process.env.AI_HOST_SESSION_ID || null;
  try {
    const response = await fetch(`${hostUrl}/internal/wrappers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        argv,
        hostSessionId
      })
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
    stdio: "inherit",
    env: {
      ...process.env,
      AI_HOST_SESSION_ID: hostSessionId || ""
    }
  });

  child.on("exit", async (code, signal) => {
    if (hostSessionId) {
      try {
        await fetch(`${hostUrl}/internal/wrappers/${encodeURIComponent(hostSessionId)}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            exitCode: code || 0,
            signal: signal || null
          })
        });
      } catch (_error) {
        // Best effort only.
      }
    }

    process.exit(code || 0);
  });

  child.on("error", (_error) => {
    process.exit(1);
  });
}

main();

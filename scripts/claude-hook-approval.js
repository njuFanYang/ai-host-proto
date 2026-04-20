#!/usr/bin/env node

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
  const payload = await readStdinJson();
  if (!payload || payload.hook_event_name !== "PreToolUse") {
    emitAllow("not_pretooluse");
    return;
  }

  const hostUrl = process.env.AI_HOST_URL;
  const hostSessionId = process.env.AI_HOST_SESSION_ID;

  if (!hostUrl || !hostSessionId) {
    emitAllow("no_host_session");
    return;
  }

  const toolName = payload.tool_name || "unknown";
  const toolInput = payload.tool_input || {};
  const request = {
    riskLevel: classifyRisk(toolName, toolInput),
    actionType: toolName,
    summary: summarize(toolName, toolInput),
    rawRequest: {
      tool_name: toolName,
      tool_input: toolInput,
      claude_session_id: payload.session_id,
      cwd: payload.cwd
    },
    controllability: "controllable"
  };

  let createResponse;
  try {
    createResponse = await postJson(`${hostUrl}/sessions/${encodeURIComponent(hostSessionId)}/approvals`, request);
  } catch (error) {
    emitAsk(`host_unreachable: ${error.message}`);
    return;
  }

  if (createResponse.status >= 400) {
    emitAsk(`host_rejected_${createResponse.status}`);
    return;
  }

  const body = createResponse.body || {};
  const approval = body.approval;

  if (body.autoResolved && approval && approval.decision) {
    emitFromDecision(approval.decision);
    return;
  }

  if (!approval || !approval.requestId) {
    emitAsk("no_approval_id");
    return;
  }

  const timeoutMs = Number(process.env.AI_HOST_APPROVAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const resolved = await pollUntilResolved(hostUrl, approval.requestId, timeoutMs);
  if (!resolved) {
    emitAsk("timeout");
    return;
  }

  if (!resolved.decision) {
    emitAsk("resolved_without_decision");
    return;
  }

  emitFromDecision(resolved.decision);
}

function classifyRisk(toolName, toolInput) {
  const low = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite", "NotebookRead", "WebSearch"]);
  const destructive = /\brm\s+-rf\b|\bsudo\b|\bcurl\b|\bwget\b|\bnc\b|\bnetcat\b|\bssh\s|\bscp\s|\bdd\s|\bmkfs\b|\bfdisk\b|\bformat\b|>\s*\/dev\/|\bkill\s+-9\b|:\(\)\s*\{|\bshutdown\b|\breboot\b/i;

  if (low.has(toolName)) {
    return "low";
  }

  if (toolName === "Bash" || toolName === "KillBash") {
    const cmd = toolInput && typeof toolInput.command === "string" ? toolInput.command : "";
    return destructive.test(cmd) ? "high" : "low";
  }

  if (toolName === "BashOutput") {
    return "low";
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    return "low";
  }

  if (toolName === "WebFetch") {
    return "medium";
  }

  if (toolName === "Task" || toolName === "Agent") {
    return "low";
  }

  if (toolName && toolName.startsWith("mcp__")) {
    return "medium";
  }

  return "low";
}

function summarize(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return toolName;
  }

  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return truncate(`bash: ${toolInput.command}`, 240);
  }

  if ((toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") && typeof toolInput.file_path === "string") {
    return truncate(`${toolName} ${toolInput.file_path}`, 240);
  }

  if (toolName === "WebFetch" && typeof toolInput.url === "string") {
    return truncate(`WebFetch ${toolInput.url}`, 240);
  }

  if (toolName === "Read" && typeof toolInput.file_path === "string") {
    return truncate(`Read ${toolInput.file_path}`, 240);
  }

  try {
    return truncate(`${toolName} ${JSON.stringify(toolInput)}`, 240);
  } catch (_error) {
    return toolName;
  }
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function emitFromDecision(decision) {
  const action = decision.decision;
  const reason = decision.reason || `decided_by_${decision.decidedBy || "host"}`;

  if (action === "approve") {
    emitAllow(reason);
    return;
  }

  if (action === "deny") {
    emitDeny(reason);
    return;
  }

  emitAsk(reason);
}

function emitAllow(reason) {
  writeDecision("allow", reason);
  process.exit(0);
}

function emitDeny(reason) {
  writeDecision("deny", reason);
  process.exit(0);
}

function emitAsk(reason) {
  writeDecision("ask", reason);
  process.exit(0);
}

function writeDecision(permissionDecision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function pollUntilResolved(hostUrl, requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status, body } = await getJson(`${hostUrl}/approvals/${encodeURIComponent(requestId)}`);
      if (status === 200 && body && body.approval && body.approval.status === "resolved") {
        return body.approval;
      }
    } catch (_error) {
      // Ignore transient errors; retry.
    }

    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdinJson() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on("error", reject);
  });
}

function postJson(urlString, body) {
  return requestJson(urlString, "POST", body);
}

function getJson(urlString) {
  return requestJson(urlString, "GET", null);
}

function requestJson(urlString, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");

    const req = transport.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": payload ? payload.length : 0,
        accept: "application/json"
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch (_error) {
            parsed = { raw };
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

main().catch((error) => {
  try {
    writeDecision("ask", `hook_error: ${error.message}`);
  } finally {
    process.exit(0);
  }
});

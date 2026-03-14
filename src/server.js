const http = require("node:http");
const path = require("node:path");

const { ApprovalService } = require("./host/approval-service");
const { CodexCliManager } = require("./host/codex-cli");
const { PolicyEngine } = require("./host/policy-engine");
const { SessionRegistry } = require("./host/session-registry");

const projectRoot = path.resolve(__dirname, "..");
const registry = new SessionRegistry({ projectRoot });
const policyEngine = new PolicyEngine();
const approvalService = new ApprovalService({ registry, policyEngine });
const manager = new CodexCliManager({ registry, projectRoot });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "ai-host-proto",
        managedSessions: registry.listSessions().length
      });
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      return sendJson(res, 200, {
        sessions: registry.listSessions()
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/approvals/")) {
      const requestId = decodeURIComponent(url.pathname.split("/")[2]);
      const approval = registry.getApproval(requestId);
      if (!approval) {
        return sendJson(res, 404, { error: "approval_not_found" });
      }

      return sendJson(res, 200, { approval });
    }

    if (req.method === "POST" && url.pathname === "/sessions/cli") {
      const body = await readJson(req);
      const result = await manager.launchCliSession(body || {});
      return sendJson(res, 201, {
        session: registry.getSession(result.record.hostSessionId),
        terminalLaunchInfo: result.terminalLaunchInfo || null
      });
    }

    if (req.method === "POST" && url.pathname === "/sessions/ide") {
      const body = await readJson(req);
      const result = await manager.launchIdeSession(body || {});
      return sendJson(res, 201, {
        session: registry.getSession(result.record.hostSessionId),
        wrapperLaunchInfo: result.wrapperLaunchInfo
      });
    }

    if (req.method === "POST" && url.pathname === "/internal/wrappers/register") {
      const body = await readJson(req);
      const record = await manager.registerWrapperSession(body || {});
      return sendJson(res, 201, {
        hostSessionId: record.hostSessionId
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/internal/wrappers/") && url.pathname.endsWith("/complete")) {
      const hostSessionId = decodeURIComponent(url.pathname.split("/")[3]);
      const body = await readJson(req);
      const session = await manager.markWrapperCompleted(hostSessionId, body || {});
      return sendJson(res, 200, {
        session
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
      const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
      if (url.pathname.endsWith("/events")) {
        return sendJson(res, 200, {
          hostSessionId,
          events: registry.listEvents(hostSessionId)
        });
      }

      const session = registry.getSession(hostSessionId);
      if (!session) {
        return sendJson(res, 404, { error: "session_not_found" });
      }

      return sendJson(res, 200, { session });
    }

    if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/messages")) {
      const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
      const body = await readJson(req);
      const prompt = body && body.prompt;
      if (!prompt) {
        return sendJson(res, 400, { error: "missing_prompt" });
      }

      await manager.sendMessage(hostSessionId, prompt);
      return sendJson(res, 202, {
        hostSessionId,
        accepted: true
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/approvals")) {
      const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
      const body = await readJson(req);
      const result = approvalService.createApproval(hostSessionId, body || {});
      return sendJson(res, 201, result);
    }

    if (req.method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/decision")) {
      const requestId = decodeURIComponent(url.pathname.split("/")[2]);
      const body = await readJson(req);
      const result = approvalService.resolveApproval(requestId, body || {});
      const statusCode = result.ok ? 200 : 409;
      return sendJson(res, statusCode, result);
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return sendJson(res, statusCode, {
      error: error.message
    });
  }
});

const port = Number(process.env.AI_HOST_PORT || 7788);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ai-host-proto listening on http://127.0.0.1:${port}\n`);
});

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed);
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

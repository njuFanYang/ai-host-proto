const http = require("node:http");
const path = require("node:path");

const { ApprovalService } = require("./host/approval-service");
const { CodexCliManager } = require("./host/codex-cli");
const { PolicyEngine } = require("./host/policy-engine");
const { SessionRegistry } = require("./host/session-registry");

function createHostServer(options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, "..");
  const registry = options.registry || new SessionRegistry({ projectRoot });
  const policyEngine = options.policyEngine || new PolicyEngine();
  const manager = options.manager || new CodexCliManager({ registry, projectRoot });
  const approvalService = options.approvalService || new ApprovalService({
    registry,
    policyEngine,
    decisionHandler: (approval, decision) => manager.handleApprovalDecision(approval, decision)
  });

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
        manager.refreshAllSessions();
        return sendJson(res, 200, {
          sessions: registry.listSessions()
        });
      }

      if (req.method === "GET" && url.pathname === "/approvals") {
        const status = url.searchParams.get("status");
        const approvals = approvalService.listApprovals({
          status: status || undefined
        });
        return sendJson(res, 200, { approvals });
      }

      if (req.method === "GET" && url.pathname === "/approvals/stream") {
        return openApprovalStream(req, res, {
          hostSessionId: url.searchParams.get("hostSessionId") || undefined,
          status: url.searchParams.get("status") || undefined
        }, { approvalService, registry });
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

      if (req.method === "POST" && url.pathname.startsWith("/internal/wrappers/") && url.pathname.endsWith("/runtime")) {
        const hostSessionId = decodeURIComponent(url.pathname.split("/")[3]);
        const body = await readJson(req);
        const session = await manager.updateWrapperRuntime(hostSessionId, body || {});
        return sendJson(res, 200, {
          session
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/internal/wrappers/") && url.pathname.endsWith("/commands")) {
        const hostSessionId = decodeURIComponent(url.pathname.split("/")[3]);
        const commands = manager.claimWrapperCommands(hostSessionId);
        return sendJson(res, 200, {
          hostSessionId,
          commands
        });
      }

      if (req.method === "POST" && url.pathname.startsWith("/internal/wrappers/") && url.pathname.includes("/commands/") && url.pathname.endsWith("/complete")) {
        const parts = url.pathname.split("/");
        const hostSessionId = decodeURIComponent(parts[3]);
        const commandId = decodeURIComponent(parts[5]);
        const body = await readJson(req);
        const command = manager.completeWrapperCommand(hostSessionId, commandId, body || {});
        return sendJson(res, 200, {
          hostSessionId,
          command
        });
      }

      if (req.method === "POST" && url.pathname.startsWith("/internal/wrappers/") && url.pathname.endsWith("/events")) {
        const hostSessionId = decodeURIComponent(url.pathname.split("/")[3]);
        const body = await readJson(req);
        const session = await manager.recordWrapperEvent(hostSessionId, body || {});
        return sendJson(res, 202, {
          session,
          accepted: true
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
        if (url.pathname.endsWith("/events/stream")) {
          return openSessionStream(req, res, hostSessionId, { manager, registry, approvalService });
        }

        if (url.pathname.endsWith("/events")) {
          manager.refreshSession(hostSessionId);
          return sendJson(res, 200, {
            hostSessionId,
            events: registry.listEvents(hostSessionId)
          });
        }

        if (url.pathname.endsWith("/approvals")) {
          return sendJson(res, 200, {
            hostSessionId,
            approvals: approvalService.listApprovals({ hostSessionId })
          });
        }

        const session = manager.refreshSession(hostSessionId) || registry.getSession(hostSessionId);
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
        const result = await approvalService.resolveApproval(requestId, body || {});
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

  return {
    server,
    projectRoot,
    registry,
    manager,
    approvalService,
    policyEngine
  };
}

function openSessionStream(req, res, hostSessionId, services) {
  const session = services.manager.refreshSession(hostSessionId) || services.registry.getSession(hostSessionId);
  if (!session) {
    return sendJson(res, 404, { error: "session_not_found" });
  }

  openSse(req, res, (send) => {
    send("snapshot", {
      session,
      events: services.registry.listEvents(hostSessionId).slice(-20),
      approvals: services.approvalService.listApprovals({ hostSessionId })
    });

    return services.registry.subscribe((message) => {
      if (message.hostSessionId !== hostSessionId) {
        return;
      }

      if (message.type === "session") {
        send("session", message);
        return;
      }

      if (message.type === "event") {
        send("event", message);
        return;
      }

      if (message.type === "approval") {
        send("approval", message);
      }
    });
  });
}

function openApprovalStream(req, res, filter = {}, services) {
  openSse(req, res, (send) => {
    send("snapshot", {
      approvals: services.approvalService.listApprovals(filter)
    });

    return services.registry.subscribe((message) => {
      if (message.type !== "approval") {
        return;
      }

      if (filter.hostSessionId && message.hostSessionId !== filter.hostSessionId) {
        return;
      }

      if (filter.status && message.approval.status !== filter.status) {
        return;
      }

      send("approval", message);
    });
  });
}

function openSse(req, res, onOpen) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  res.write(": connected\n\n");
  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  const send = (eventName, payload) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = onOpen(send);
  req.on("close", () => {
    clearInterval(keepAlive);
    if (typeof unsubscribe === "function") {
      unsubscribe();
    }
    res.end();
  });
}

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

function startServer(options = {}) {
  const host = createHostServer(options);
  const port = Number(options.port || process.env.AI_HOST_PORT || 7788);
  const hostname = options.hostname || "127.0.0.1";

  host.server.listen(port, hostname, () => {
    process.stdout.write(`ai-host-proto listening on http://${hostname}:${port}\n`);
  });

  return host;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createHostServer,
  startServer
};

const http = require("node:http");
const path = require("node:path");

const { ApprovalService } = require("./host/approval-service");
const { ChannelBindingRegistry } = require("./host/channel-binding-registry");
const { ChannelBindingService } = require("./host/channel-binding-service");
const { ClaudeCodeManager } = require("./host/claude-code-cli");
const { PolicyEngine } = require("./host/policy-engine");
const { SessionControlService } = require("./host/session-control-service");
const { SessionRegistry } = require("./host/session-registry");
const { FeishuAdapter } = require("./host/channels/feishu/adapter");

function createHostRuntime(options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, "..");
  const registry = options.registry || new SessionRegistry({ projectRoot });
  const policyEngine = options.policyEngine || new PolicyEngine();
  const manager = options.manager || new ClaudeCodeManager({ registry, projectRoot });
  const sessionControl = options.sessionControl || new SessionControlService({
    registry,
    manager
  });
  const approvalService = options.approvalService || new ApprovalService({
    registry,
    policyEngine,
    onResolved: (approval) => sessionControl.drainQueue(approval.hostSessionId)
  });
  const channelBindingRegistry = options.channelBindingRegistry || new ChannelBindingRegistry({ projectRoot });
  const channelBindingService = options.channelBindingService || new ChannelBindingService({
    bindingRegistry: channelBindingRegistry,
    sessionRegistry: registry,
    sessionControl,
    approvalService
  });

  return {
    projectRoot,
    registry,
    manager,
    approvalService,
    policyEngine,
    sessionControl,
    channelBindingRegistry,
    channelBindingService
  };
}

function createHostServer(options = {}) {
  const runtime = isHostRuntime(options) ? options : createHostRuntime(options);
  return createSurfaceServer(runtime, "internal");
}

function createExternalServer(options = {}) {
  const runtime = isHostRuntime(options) ? options : createHostRuntime(options);
  return createSurfaceServer(runtime, "external");
}

function createSurfaceServer(runtime, surface) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "ai-host-proto",
          surface,
          managedSessions: runtime.registry.listSessions().length,
          channelBindings: runtime.channelBindingRegistry.listBindings().length
        });
      }

      if (await handlePublicRoutes(req, res, url, runtime, surface)) {
        return;
      }

      if (surface !== "external" && await handleInternalRoutes(req, res, url, runtime, surface)) {
        return;
      }

      return sendJson(res, 404, {
        error: "not_found",
        surface
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return sendJson(res, statusCode, {
        error: error.message,
        code: error.code || null,
        surface
      });
    }
  });

  return {
    ...runtime,
    server,
    surface
  };
}

async function handlePublicRoutes(req, res, url, runtime, surface) {
  const { manager, registry, approvalService, sessionControl, channelBindingService } = runtime;

  if (req.method === "GET" && url.pathname === "/channel-bindings") {
    const channel = url.searchParams.get("channel") || undefined;
    const mode = url.searchParams.get("mode") || undefined;
    return sendJson(res, 200, {
      surface,
      bindings: channelBindingService.listBindings({ channel, mode })
    });
  }

  if (url.pathname.startsWith("/channel-bindings/")) {
    const parts = url.pathname.split("/");
    const channel = decodeURIComponent(parts[2] || "");
    const conversationId = decodeURIComponent(parts[3] || "");

    if (req.method === "GET" && parts.length === 4) {
      const binding = channelBindingService.getBinding(channel, conversationId);
      if (!binding) {
        return sendJson(res, 404, { error: "binding_not_found", surface });
      }
      return sendJson(res, 200, { surface, binding });
    }

    if (req.method === "POST" && url.pathname.endsWith("/attach")) {
      const body = await readJson(req);
      const binding = channelBindingService.attachBinding(channel, conversationId, body || {});
      return sendJson(res, 200, { surface, binding });
    }

    if (req.method === "POST" && url.pathname.endsWith("/switch")) {
      const body = await readJson(req);
      const binding = channelBindingService.switchBinding(channel, conversationId, body || {});
      return sendJson(res, 200, { surface, binding });
    }

    if (req.method === "POST" && url.pathname.endsWith("/detach")) {
      const body = await readJson(req);
      const binding = channelBindingService.detachBinding(channel, conversationId, body || {});
      if (!binding) {
        return sendJson(res, 404, { error: "binding_not_found", surface });
      }
      return sendJson(res, 200, { surface, binding });
    }

    if (req.method === "POST" && url.pathname.endsWith("/messages")) {
      const body = await readJson(req);
      const prompt = body && body.prompt;
      if (!prompt) {
        return sendJson(res, 400, { error: "missing_prompt", surface });
      }
      const result = await channelBindingService.sendBoundMessage(channel, conversationId, prompt, body || {});
      return sendJson(res, 202, {
        surface,
        accepted: true,
        ...result
      });
    }

    if (req.method === "GET" && url.pathname.endsWith("/watch")) {
      const snapshot = channelBindingService.getWatchSnapshot(channel, conversationId, {
        limitEvents: Number(url.searchParams.get("limit") || 20)
      });
      return sendJson(res, 200, {
        surface,
        ...snapshot
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    manager.refreshAllSessions();
    return sendJson(res, 200, {
      surface,
      sessions: registry.listSessions()
    });
  }

  if (req.method === "GET" && url.pathname === "/approvals") {
    const status = url.searchParams.get("status");
    const approvals = approvalService.listApprovals({
      status: status || undefined
    });
    return sendJson(res, 200, {
      surface,
      approvals
    });
  }

  if (req.method === "GET" && url.pathname === "/approvals/stream") {
    return openApprovalStream(req, res, {
      hostSessionId: url.searchParams.get("hostSessionId") || undefined,
      status: url.searchParams.get("status") || undefined
    }, { approvalService, registry, surface });
  }

  if (req.method === "GET" && url.pathname.startsWith("/approvals/")) {
    const requestId = decodeURIComponent(url.pathname.split("/")[2]);
    const approval = registry.getApproval(requestId);
    if (!approval) {
      return sendJson(res, 404, { error: "approval_not_found", surface });
    }

    if (url.pathname.endsWith("/decision")) {
      return false;
    }

    return sendJson(res, 200, { surface, approval });
  }

  if (req.method === "POST" && url.pathname.startsWith("/approvals/") && url.pathname.endsWith("/decision")) {
    const requestId = decodeURIComponent(url.pathname.split("/")[2]);
    const body = await readJson(req);
    const result = await approvalService.resolveApproval(requestId, body || {});
    const statusCode = result.ok ? 200 : 409;
    return sendJson(res, statusCode, {
      surface,
      ...result
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
    const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
    if (url.pathname.endsWith("/events/stream")) {
      return openSessionStream(req, res, hostSessionId, { manager, registry, approvalService, surface });
    }

    if (url.pathname.endsWith("/events")) {
      manager.refreshSession(hostSessionId);
      return sendJson(res, 200, {
        surface,
        hostSessionId,
        events: registry.listEvents(hostSessionId)
      });
    }

    if (url.pathname.endsWith("/approvals")) {
      return sendJson(res, 200, {
        surface,
        hostSessionId,
        approvals: approvalService.listApprovals({ hostSessionId })
      });
    }

    if (url.pathname.endsWith("/controllers")) {
      return sendJson(res, 200, {
        surface,
        hostSessionId,
        controllers: sessionControl.listControllers(hostSessionId)
      });
    }

    if (url.pathname.endsWith("/inputs")) {
      return sendJson(res, 200, {
        surface,
        hostSessionId,
        inputs: sessionControl.listInputs(hostSessionId)
      });
    }

    const session = manager.refreshSession(hostSessionId) || registry.getSession(hostSessionId);
    if (!session) {
      return sendJson(res, 404, { error: "session_not_found", surface });
    }

    return sendJson(res, 200, { surface, session });
  }

  if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/messages")) {
    const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
    const body = await readJson(req);
    const prompt = body && body.prompt;
    if (!prompt) {
      return sendJson(res, 400, { error: "missing_prompt", surface });
    }

    const inputRecord = await sessionControl.submitMessage(hostSessionId, prompt, body || {});
    return sendJson(res, 202, {
      surface,
      hostSessionId,
      accepted: true,
      input: inputRecord
    });
  }

  if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/controllers/attach")) {
    const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
    const body = await readJson(req);
    const controller = sessionControl.attachController(hostSessionId, body || {});
    return sendJson(res, 200, {
      surface,
      hostSessionId,
      controller
    });
  }

  if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/controllers/detach")) {
    const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
    const body = await readJson(req);
    if (!body || !body.controllerId) {
      return sendJson(res, 400, { error: "missing_controller_id", surface });
    }

    const controller = sessionControl.detachController(hostSessionId, body.controllerId);
    if (!controller) {
      return sendJson(res, 404, { error: "controller_not_found", surface });
    }

    return sendJson(res, 200, {
      surface,
      hostSessionId,
      controller
    });
  }

  return false;
}

async function handleInternalRoutes(req, res, url, runtime, surface) {
  const { manager, registry, approvalService } = runtime;

  if (req.method === "POST" && url.pathname === "/sessions/cli") {
    const body = await readJson(req);
    const result = await manager.launchCliSession(body || {});
    return sendJson(res, 201, {
      surface,
      session: registry.getSession(result.record.hostSessionId),
      terminalLaunchInfo: result.terminalLaunchInfo || null
    });
  }

  if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/approvals")) {
    const hostSessionId = decodeURIComponent(url.pathname.split("/")[2]);
    const body = await readJson(req);
    const result = await approvalService.createApproval(hostSessionId, body || {});
    return sendJson(res, 201, {
      surface,
      ...result
    });
  }

  return false;
}

function openSessionStream(req, res, hostSessionId, services) {
  const session = services.manager.refreshSession(hostSessionId) || services.registry.getSession(hostSessionId);
  if (!session) {
    return sendJson(res, 404, { error: "session_not_found", surface: services.surface || "unknown" });
  }

  openSse(req, res, (send) => {
    send("snapshot", {
      surface: services.surface || "unknown",
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
      surface: services.surface || "unknown",
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
  return true;
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
    process.stdout.write(`ai-host-proto internal listening on http://${hostname}:${port}\n`);
  });

  return host;
}

function startDualServer(options = {}) {
  const runtime = createHostRuntime(options);
  const internal = createHostServer(runtime);
  const externalPort = Number(options.externalPort || process.env.AI_HOST_EXTERNAL_PORT || 0);
  const externalHostname = options.externalHostname || options.hostname || "127.0.0.1";

  const port = Number(options.port || process.env.AI_HOST_PORT || 7788);
  const hostname = options.hostname || "127.0.0.1";
  internal.server.listen(port, hostname, () => {
    process.stdout.write(`ai-host-proto internal listening on http://${hostname}:${port}\n`);
  });

  let external = null;
  if (externalPort > 0) {
    external = createExternalServer(runtime);
    external.server.listen(externalPort, externalHostname, () => {
      process.stdout.write(`ai-host-proto external listening on http://${externalHostname}:${externalPort}\n`);
    });
  }

  const feishuAdapter = maybeStartFeishuAdapter(runtime, options);

  return {
    ...runtime,
    internal,
    external,
    feishuAdapter
  };
}

function maybeStartFeishuAdapter(runtime, options) {
  const appId = options.feishuAppId || process.env.FEISHU_APP_ID;
  const appSecret = options.feishuAppSecret || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    return null;
  }

  const autoCwd = options.feishuAutoSessionCwd || process.env.FEISHU_AUTO_SESSION_CWD || null;
  const autoSession = autoCwd
    ? {
        cwd: autoCwd,
        permissionMode: options.feishuAutoSessionPermissionMode || process.env.FEISHU_AUTO_SESSION_PERMISSION_MODE || "default",
        model: options.feishuAutoSessionModel || process.env.FEISHU_AUTO_SESSION_MODEL || null
      }
    : null;

  const adapter = new FeishuAdapter({
    appId,
    appSecret,
    encryptKey: options.feishuEncryptKey || process.env.FEISHU_ENCRYPT_KEY || undefined,
    verificationToken: options.feishuVerificationToken || process.env.FEISHU_VERIFICATION_TOKEN || undefined,
    bindingRegistry: runtime.channelBindingRegistry,
    sessionRegistry: runtime.registry,
    channelBindingService: runtime.channelBindingService,
    approvalService: runtime.approvalService,
    manager: runtime.manager,
    autoSession,
    threadIsolation: parseBoolean(options.feishuThreadIsolation || process.env.FEISHU_THREAD_ISOLATION, true)
  });

  adapter.start().catch((error) => {
    process.stderr.write(`[feishu] adapter failed to start: ${error.message}\n`);
  });

  return adapter;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isHostRuntime(value) {
  return Boolean(value) &&
    value.registry &&
    value.manager &&
    value.approvalService &&
    value.sessionControl &&
    value.channelBindingRegistry &&
    value.channelBindingService;
}

if (require.main === module) {
  try {
    require("dotenv").config({ quiet: true });
  } catch (_error) {
    // dotenv is optional at runtime; ignore if missing.
  }
  startDualServer();
}

module.exports = {
  createExternalServer,
  createHostRuntime,
  createHostServer,
  createSurfaceServer,
  startDualServer,
  startServer
};

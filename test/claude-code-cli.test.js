const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ClaudeCodeManager, HOOK_MARKER } = require("../src/host/claude-code-cli");
const { SessionRegistry } = require("../src/host/session-registry");

test("ClaudeCodeManager installs PreToolUse hook in settings.local.json", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new ClaudeCodeManager({ registry, projectRoot });

  manager.ensureHookInstalled(projectRoot);

  const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  assert.ok(Array.isArray(settings.hooks.PreToolUse));
  const ours = settings.hooks.PreToolUse.filter((entry) => entry[HOOK_MARKER] === true);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].matcher, "*");
  assert.equal(ours[0].hooks[0].type, "command");
  assert.match(ours[0].hooks[0].command, /claude-hook-approval\.js/);
});

test("ClaudeCodeManager merges hook into existing settings without duplicating", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const settingsDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.local.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "echo post" }] }
        ]
      }
    }, null, 2)
  );

  const registry = new SessionRegistry({ projectRoot });
  const manager = new ClaudeCodeManager({ registry, projectRoot });

  manager.ensureHookInstalled(projectRoot);
  manager.ensureHookInstalled(projectRoot);

  const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.local.json"), "utf8"));
  const ours = settings.hooks.PreToolUse.filter((entry) => entry[HOOK_MARKER] === true);
  const userHooks = settings.hooks.PreToolUse.filter((entry) => !entry[HOOK_MARKER]);

  assert.equal(ours.length, 1);
  assert.equal(userHooks.length, 1);
  assert.equal(userHooks[0].matcher, "Bash");
  assert.equal(settings.hooks.PostToolUse.length, 1);
});

test("ClaudeCodeManager dispatch rejects non stream-json transports", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new ClaudeCodeManager({ registry, projectRoot });
  const session = registry.createSession({
    source: "cli",
    transport: "legacy-tty",
    workspaceRoot: projectRoot,
    runtime: { mode: "legacy" }
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  await assert.rejects(
    () => manager.dispatchTransportMessage(session.hostSessionId, "nope"),
    /does not support controllable message injection/
  );
});

test("ClaudeCodeManager dispatch requires upstream session binding", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-host-proto-"));
  const registry = new SessionRegistry({ projectRoot });
  const manager = new ClaudeCodeManager({ registry, projectRoot });
  const session = registry.createSession({
    source: "cli",
    transport: "stream-json",
    workspaceRoot: projectRoot,
    runtime: { mode: "stream-json" }
  });
  registry.updateSession(session.hostSessionId, { status: "running" });

  await assert.rejects(
    () => manager.dispatchTransportMessage(session.hostSessionId, "nope"),
    /not bound to an upstream session/
  );
});

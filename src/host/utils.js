const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function createHostSessionId(source) {
  return `host-${source}-${crypto.randomUUID()}`;
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeJsonParse(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error };
  }
}

function resolveDataRoot(projectRoot) {
  return path.join(projectRoot, ".host-data");
}

module.exports = {
  createHostSessionId,
  createId,
  ensureDir,
  nowIso,
  resolveDataRoot,
  safeJsonParse
};

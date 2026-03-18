const fs = require("node:fs");
const path = require("node:path");

const {
  createId,
  ensureDir,
  nowIso,
  resolveDataRoot
} = require("./utils");

class ChannelBindingRegistry {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.dataRoot = options.dataRoot || resolveDataRoot(this.projectRoot);
    ensureDir(this.dataRoot);
    this.filePath = path.join(this.dataRoot, "channel-bindings.json");
    this.records = new Map();
    this.loadPersistedBindings();
  }

  listBindings(filter = {}) {
    let bindings = Array.from(this.records.values());
    if (filter.channel) {
      bindings = bindings.filter((binding) => binding.channel === filter.channel);
    }
    if (filter.conversationId) {
      bindings = bindings.filter((binding) => binding.conversationId === filter.conversationId);
    }
    if (filter.mode) {
      bindings = bindings.filter((binding) => binding.mode === filter.mode);
    }
    return bindings.sort((left, right) => left.updatedAt < right.updatedAt ? 1 : -1).map(cloneBinding);
  }

  getBinding(channel, conversationId) {
    const key = toBindingKey(channel, conversationId);
    const record = this.records.get(key) || null;
    return record ? cloneBinding(record) : null;
  }

  attachBinding(input) {
    const key = toBindingKey(input.channel, input.conversationId);
    const current = this.records.get(key) || createDefaultBinding(input);
    const timestamp = nowIso();
    const pinnedSessionIds = uniq([
      ...(Array.isArray(current.pinnedSessionIds) ? current.pinnedSessionIds : []),
      ...(Array.isArray(input.pinnedSessionIds) ? input.pinnedSessionIds : []),
      input.activeHostSessionId || null
    ].filter(Boolean));

    const updated = {
      ...current,
      conversationType: input.conversationType || current.conversationType || "p2p",
      activeHostSessionId: input.activeHostSessionId || null,
      mode: input.mode || current.mode || "watch",
      pinnedSessionIds,
      attachedBy: input.attachedBy || current.attachedBy || null,
      activeControllerId: input.activeControllerId || current.activeControllerId || null,
      activeControllerType: input.activeControllerType || current.activeControllerType || null,
      lastChannelUserId: input.channelUserId || current.lastChannelUserId || null,
      lastSwitchedAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        ...(current.metadata || {}),
        ...(input.metadata || {})
      }
    };

    this.records.set(key, updated);
    this.persist();
    return cloneBinding(updated);
  }

  detachBinding(channel, conversationId, input = {}) {
    const key = toBindingKey(channel, conversationId);
    const current = this.records.get(key) || null;
    if (!current) {
      return null;
    }

    const updated = {
      ...current,
      activeHostSessionId: null,
      mode: input.mode || "neutral",
      activeControllerId: null,
      activeControllerType: null,
      lastChannelUserId: input.channelUserId || current.lastChannelUserId || null,
      updatedAt: nowIso(),
      metadata: {
        ...(current.metadata || {}),
        ...(input.metadata || {})
      }
    };

    this.records.set(key, updated);
    this.persist();
    return cloneBinding(updated);
  }

  persist() {
    const payload = this.listBindings();
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  loadPersistedBindings() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        if (!entry || !entry.channel || !entry.conversationId) {
          continue;
        }
        this.records.set(toBindingKey(entry.channel, entry.conversationId), normalizeBinding(entry));
      }
    } catch (_error) {
      // Ignore corrupt binding store in this prototype.
    }
  }
}

function toBindingKey(channel, conversationId) {
  return `${channel}:${conversationId}`;
}

function createDefaultBinding(input) {
  const timestamp = nowIso();
  return {
    bindingId: createId("binding"),
    channel: input.channel,
    conversationId: input.conversationId,
    conversationType: input.conversationType || "p2p",
    activeHostSessionId: null,
    mode: "neutral",
    pinnedSessionIds: [],
    attachedBy: null,
    activeControllerId: null,
    activeControllerType: null,
    lastChannelUserId: null,
    lastSwitchedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {}
  };
}

function normalizeBinding(input) {
  return {
    bindingId: input.bindingId || createId("binding"),
    channel: input.channel,
    conversationId: input.conversationId,
    conversationType: input.conversationType || "p2p",
    activeHostSessionId: input.activeHostSessionId || null,
    mode: input.mode || "neutral",
    pinnedSessionIds: uniq(Array.isArray(input.pinnedSessionIds) ? input.pinnedSessionIds : []),
    attachedBy: input.attachedBy || null,
    activeControllerId: input.activeControllerId || null,
    activeControllerType: input.activeControllerType || null,
    lastChannelUserId: input.lastChannelUserId || null,
    lastSwitchedAt: input.lastSwitchedAt || null,
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
    metadata: input.metadata || {}
  };
}

function uniq(values) {
  return Array.from(new Set(values));
}

function cloneBinding(binding) {
  return JSON.parse(JSON.stringify(binding));
}

module.exports = {
  ChannelBindingRegistry
};

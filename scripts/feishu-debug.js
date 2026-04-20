#!/usr/bin/env node

// Minimal standalone debug harness: start a Feishu WSClient with verbose logging
// and print every event that comes through. Run with:
//
//   node scripts/feishu-debug.js
//
// Send a message to the bot from Feishu. You should see the raw event JSON.
// If nothing shows up, the problem is on Feishu's side (bot not published,
// chat not initiated, event not subscribed, etc.), not in ai-host-proto.

require("dotenv").config({ quiet: true });

const lark = require("@larksuiteoapi/node-sdk");

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("FEISHU_APP_ID / FEISHU_APP_SECRET not set in .env");
  process.exit(1);
}

console.log("[debug] NO_PROXY =", process.env.NO_PROXY || "(none)");
console.log("[debug] HTTPS_PROXY =", process.env.HTTPS_PROXY || "(none)");
console.log("[debug] appId =", appId);

const dispatcher = new lark.EventDispatcher({
  loggerLevel: lark.LoggerLevel.debug
});

dispatcher.register({
  "im.message.receive_v1": async (data) => {
    console.log("[event im.message.receive_v1]", JSON.stringify(data, null, 2));
  },
  "card.action.trigger": async (data) => {
    console.log("[event card.action.trigger]", JSON.stringify(data, null, 2));
  }
});

const wsClient = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.debug
});

wsClient.start({ eventDispatcher: dispatcher }).then(() => {
  console.log("[debug] WSClient.start() resolved; waiting for events...");
}).catch((error) => {
  console.error("[debug] WSClient.start() failed:", error.message);
});

process.on("SIGINT", () => {
  console.log("\n[debug] closing");
  try { wsClient.close(); } catch (_) {}
  process.exit(0);
});

const lark = require("@larksuiteoapi/node-sdk");

class FeishuClient {
  constructor(options = {}) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    if (!this.appId || !this.appSecret) {
      throw new Error("FeishuClient requires appId and appSecret");
    }
    this.sdk = options.sdk || new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn
    });
  }

  async sendText(chatId, text) {
    return this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: truncate(text, 4000) })
      }
    });
  }

  async sendCard(chatId, card) {
    return this.sdk.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card)
      }
    });
  }

  async replyText(messageId, text) {
    return this.sdk.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: truncate(text, 4000) }),
        msg_type: "text"
      }
    });
  }

  async replyCard(messageId, card) {
    return this.sdk.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
        msg_type: "interactive"
      }
    });
  }

  async updateCard(messageId, card) {
    return this.sdk.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    });
  }

  async sendToBinding(binding, options) {
    const anchor = binding && binding.metadata && binding.metadata.anchorMessageId;
    const chatId = (binding && binding.metadata && binding.metadata.chatId) || binding.conversationId;

    if (options.text != null) {
      if (anchor) return this.replyText(anchor, options.text);
      return this.sendText(chatId, options.text);
    }

    if (options.card != null) {
      if (anchor) return this.replyCard(anchor, options.card);
      return this.sendCard(chatId, options.card);
    }

    throw new Error("sendToBinding requires text or card");
  }
}

function truncate(text, max) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max - 1)}…`;
}

module.exports = {
  FeishuClient,
  truncate
};

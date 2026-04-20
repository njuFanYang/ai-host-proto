const { FeishuClient } = require("./client");
const { FeishuInboundGateway } = require("./inbound");
const { FeishuOutboundDispatcher } = require("./outbound");

class FeishuAdapter {
  constructor(options) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.encryptKey = options.encryptKey || undefined;
    this.verificationToken = options.verificationToken || undefined;
    this.logger = options.logger || console;
    this.bindingRegistry = options.bindingRegistry;
    this.sessionRegistry = options.sessionRegistry;
    this.channelBindingService = options.channelBindingService;
    this.approvalService = options.approvalService;
    this.manager = options.manager || null;
    this.autoSession = options.autoSession || null;
    this.threadIsolation = options.threadIsolation !== false;

    this.client = options.client || new FeishuClient({
      appId: this.appId,
      appSecret: this.appSecret
    });

    this.outbound = options.outbound || new FeishuOutboundDispatcher({
      client: this.client,
      bindingRegistry: this.bindingRegistry,
      sessionRegistry: this.sessionRegistry,
      logger: this.logger
    });

    this.inbound = options.inbound || new FeishuInboundGateway({
      appId: this.appId,
      appSecret: this.appSecret,
      encryptKey: this.encryptKey,
      verificationToken: this.verificationToken,
      channelBindingService: this.channelBindingService,
      approvalService: this.approvalService,
      manager: this.manager,
      autoSession: this.autoSession,
      threadIsolation: this.threadIsolation,
      outboundDispatcher: this.outbound,
      logger: this.logger
    });
  }

  async start() {
    this.outbound.start();
    await this.inbound.start();
    this.logger.log(`[feishu] adapter started (appId=${this.appId})`);
  }

  async stop() {
    this.outbound.stop();
    await this.inbound.stop();
  }
}

module.exports = {
  FeishuAdapter
};

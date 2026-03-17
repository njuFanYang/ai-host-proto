class ApprovalService {
  constructor(options) {
    this.registry = options.registry;
    this.policyEngine = options.policyEngine;
    this.decisionHandler = options.decisionHandler || null;
    this.onResolved = options.onResolved || null;
  }

  listApprovals(filter = {}) {
    return this.registry.listApprovals(filter);
  }

  async createApproval(hostSessionId, input) {
    const session = this.registry.getSession(hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${hostSessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const approval = this.registry.createApproval(hostSessionId, {
      riskLevel: input.riskLevel || "medium",
      actionType: input.actionType || "unknown",
      summary: input.summary || "",
      rawRequest: input.rawRequest || {},
      controllability: input.controllability || "controllable"
    });

    const decision = this.policyEngine.evaluate(session, approval);
    if (decision.action === "approve" || decision.action === "deny") {
      this.registry.resolveApproval(approval.requestId, {
        decision: decision.action,
        decidedBy: "policy",
        reason: decision.reason,
        controllability: "controllable"
      });
      const resolvedApproval = this.registry.getApproval(approval.requestId);
      await this.notifyResolved(resolvedApproval);
      return {
        approval: resolvedApproval,
        autoResolved: true,
        needsHumanFallback: false
      };
    }

    return {
      approval,
      autoResolved: false,
      needsHumanFallback: true,
      fallbackReason: decision.reason
    };
  }

  async resolveApproval(requestId, input) {
    const approval = this.registry.getApproval(requestId);
    if (!approval) {
      const error = new Error(`Unknown approval: ${requestId}`);
      error.statusCode = 404;
      throw error;
    }

    const session = this.registry.getSession(approval.hostSessionId);
    if (!session) {
      const error = new Error(`Unknown session for approval: ${requestId}`);
      error.statusCode = 404;
      throw error;
    }

    const decidedBy = input.decidedBy || "human";
    if (decidedBy !== "human" && session.transportCapabilities.autoHitl !== "supported") {
      return {
        ok: false,
        error: "needs-human-fallback",
        hostSessionId: session.hostSessionId
      };
    }

    if (this.decisionHandler) {
      const decisionResult = await this.decisionHandler(approval, {
        decision: input.decision || "escalate",
        decidedBy,
        reason: input.reason || null
      });

      if (decisionResult && decisionResult.handled && decisionResult.ok === false) {
        return {
          ok: false,
          error: decisionResult.error || "needs-human-fallback",
          hostSessionId: session.hostSessionId
        };
      }
    }

    this.registry.resolveApproval(requestId, {
      decision: input.decision || "escalate",
      decidedBy,
      reason: input.reason || null,
      controllability: "controllable"
    });

    const resolvedApproval = this.registry.getApproval(requestId);
    await this.notifyResolved(resolvedApproval);
    return {
      ok: true,
      approval: resolvedApproval
    };
  }

  async notifyResolved(approval) {
    if (!approval || typeof this.onResolved !== "function") {
      return;
    }

    await this.onResolved(approval);
  }
}

module.exports = {
  ApprovalService
};

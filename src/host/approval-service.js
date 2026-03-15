class ApprovalService {
  constructor(options) {
    this.registry = options.registry;
    this.policyEngine = options.policyEngine;
  }

  listApprovals(filter = {}) {
    return this.registry.listApprovals(filter);
  }

  createApproval(hostSessionId, input) {
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
      return {
        approval: this.registry.getApproval(approval.requestId),
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

  resolveApproval(requestId, input) {
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

    this.registry.resolveApproval(requestId, {
      decision: input.decision || "escalate",
      decidedBy,
      reason: input.reason || null,
      controllability: "controllable"
    });

    return {
      ok: true,
      approval: this.registry.getApproval(requestId)
    };
  }
}

module.exports = {
  ApprovalService
};

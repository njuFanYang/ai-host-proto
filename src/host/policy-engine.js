class PolicyEngine {
  constructor(options = {}) {
    this.rules = options.rules || defaultRules();
  }

  evaluate(session, approval) {
    if (!session) {
      return {
        action: "escalate",
        reason: "session_not_found"
      };
    }

    const autoHitl = session.transportCapabilities && session.transportCapabilities.autoHitl;
    if (autoHitl !== "supported") {
      return {
        action: "escalate",
        reason: "transport_requires_human_fallback"
      };
    }

    const riskLevel = approval.riskLevel || "medium";
    const action = this.rules[riskLevel] || "escalate";
    return {
      action,
      reason: `policy_rule_${riskLevel}`
    };
  }
}

function defaultRules() {
  return {
    low: "approve",
    medium: "escalate",
    high: "escalate"
  };
}

module.exports = {
  PolicyEngine,
  defaultRules
};

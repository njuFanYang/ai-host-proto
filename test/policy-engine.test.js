const test = require("node:test");
const assert = require("node:assert/strict");

const { PolicyEngine } = require("../src/host/policy-engine");

test("PolicyEngine auto-approves low risk structured sessions", () => {
  const engine = new PolicyEngine();
  const decision = engine.evaluate(
    {
      transportCapabilities: {
        autoHitl: "supported"
      }
    },
    {
      riskLevel: "low"
    }
  );

  assert.equal(decision.action, "approve");
});

test("PolicyEngine escalates unsupported transports", () => {
  const engine = new PolicyEngine();
  const decision = engine.evaluate(
    {
      transportCapabilities: {
        autoHitl: "conditional"
      }
    },
    {
      riskLevel: "low"
    }
  );

  assert.equal(decision.action, "escalate");
});

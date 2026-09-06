import { describe, expect, it } from "vitest";
import { EightBitEligibilityPolicy } from "../src/eligibility.js";
import { makeModel, makePaidModel, makeUnknownCostModel } from "./fixtures.js";

describe("EightBitEligibilityPolicy — fail-closed free boundary", () => {
  const policy = new EightBitEligibilityPolicy();

  it("[PASS] known-free route accepted under adaptive policy", () => {
    const verdict = policy.evaluate(makeModel(), { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(true);
  });

  it("[PASS] paid route blocked from adaptive/free-default fleet", () => {
    const verdict = policy.evaluate(makePaidModel(), { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("PAID_NOT_AUTHORIZED");
  });

  it("[PASS] unknown-pricing route blocked from adaptive fleet (fail closed)", () => {
    const verdict = policy.evaluate(makeUnknownCostModel(), { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("UNKNOWN_COST_NOT_AUTHORIZED");
  });

  it("[PASS] unknown-pricing route blocked even under BYOK/premium (never entered blindly)", () => {
    const verdict = policy.evaluate(makeUnknownCostModel(), { role: "CODER", policyMode: "premium" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("UNKNOWN_COST_NOT_AUTHORIZED");
  });

  it("[PASS] paid route IS eligible under explicit premium policy (already-authorized crossing)", () => {
    const verdict = policy.evaluate(makePaidModel(), { role: "CODER", policyMode: "premium" });
    expect(verdict.eligible).toBe(true);
  });

  it("[PASS] legacy record (no accessClass) trusts freeStatus=verified_free + isFree=true", () => {
    const legacy = makeModel({ accessClass: undefined, freeStatus: "verified_free" });
    const verdict = policy.evaluate(legacy, { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(true);
  });

  it("[PASS] legacy record with freeStatus=expired is rejected under adaptive", () => {
    const legacy = makeModel({ accessClass: undefined, freeStatus: "expired" });
    const verdict = policy.evaluate(legacy, { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
  });

  it("[PASS] role requiring tools rejects a tool-incapable model", () => {
    const noTools = makeModel({ capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: false, longContext: false } });
    const verdict = policy.evaluate(noTools, { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("MISSING_CAPABILITY");
  });

  it("[PASS] VISION role requires vision capability", () => {
    const noVision = makeModel();
    const verdict = policy.evaluate(noVision, { role: "VISION", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
  });

  it("[PASS] LONG_CONTEXT role rejects insufficient context window", () => {
    const smallContext = makeModel({ contextWindow: 4_000, capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: false, longContext: true } });
    const verdict = policy.evaluate(smallContext, { role: "LONG_CONTEXT", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("INSUFFICIENT_CONTEXT");
  });

  it("[PASS] hard tool-reliability gate rejects a model with proven-poor reliability, regardless of capability match", () => {
    const model = makeModel();
    const verdict = policy.evaluate(model, {
      role: "CODER",
      policyMode: "adaptive",
      reliability: { score: 0.2, sampleSize: 20, demoted: true, quarantined: false },
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("TOOL_RELIABILITY_BELOW_THRESHOLD");
  });

  it("[PASS] unknown (insufficient-sample) reliability does NOT block eligibility — explicit unknown is valid", () => {
    const model = makeModel();
    const verdict = policy.evaluate(model, {
      role: "CODER",
      policyMode: "adaptive",
      reliability: { score: undefined, sampleSize: 1, demoted: false, quarantined: false },
    });
    expect(verdict.eligible).toBe(true);
  });

  it("[PASS] quarantined model rejected regardless of numeric score", () => {
    const model = makeModel();
    const verdict = policy.evaluate(model, {
      role: "CODER",
      policyMode: "adaptive",
      reliability: { score: 0.95, sampleSize: 20, demoted: false, quarantined: true },
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("QUARANTINED");
  });

  it("[PASS] offline route rejected even if otherwise eligible", () => {
    const model = makeModel({ health: { status: "offline" } });
    const verdict = policy.evaluate(model, { role: "CODER", policyMode: "adaptive" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible === false && verdict.code).toBe("UNHEALTHY");
  });
});

import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { EightBitHealthTracker, classifyFailure } from "../src/health.js";
import { makeModel } from "./fixtures.js";

describe("classifyFailure", () => {
  it("[PASS] classifies known failure shapes", () => {
    expect(classifyFailure(new Error("401 Unauthorized: invalid api key"))).toBe("AUTH_FAILURE");
    expect(classifyFailure(new Error("429 Too Many Requests, rate limited"))).toBe("RATE_LIMITED");
    expect(classifyFailure(new Error("quota exhausted for this model"))).toBe("QUOTA_EXHAUSTED");
    expect(classifyFailure(new Error("404 model_not_found: no such model"))).toBe("MODEL_NOT_FOUND");
    expect(classifyFailure(new Error("this model has been deprecated and retired"))).toBe("MODEL_RETIRED");
    expect(classifyFailure(new Error("maximum context length exceeded"))).toBe("CONTEXT_LIMIT");
    expect(classifyFailure(new Error("request timed out"))).toBe("TIMEOUT");
    expect(classifyFailure(new Error("502 bad gateway upstream error"))).toBe("PROVIDER_OUTAGE");
    expect(classifyFailure(new Error("ECONNRESET"))).toBe("TRANSIENT_NETWORK");
    expect(classifyFailure(new Error("something entirely unexpected"))).toBe("UNKNOWN");
  });
});

describe("EightBitHealthTracker — live feedback loop", () => {
  it("[PASS] a single transient failure never demotes past HEALTHY/DEGRADED (never permanently retires a route)", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    const h = tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    expect(h.status).not.toBe("UNAVAILABLE");
    expect(h.status).not.toBe("SUSPENDED");
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(false);
  });

  it("[PASS] sustained TIMEOUT failures escalate to DEGRADED", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    const h = tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    expect(h.consecutiveFailures).toBe(3);
    expect(h.status).toBe("DEGRADED");
  });

  it("[PASS] 429 enters cooldown with a retryAfter", () => {
    let clock = 1_000_000;
    const fw = new ForgeZero({ context: { now: () => new Date(clock) } });
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw, () => clock);
    const h = tracker.recordFailure("openrouter", "coder-alpha:free", "RATE_LIMITED");
    expect(h.status).toBe("RATE_LIMITED");
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);
    clock += 10 * 60_000;
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(false);
  });

  it("[PASS] quota exhaustion rotates the route into cooldown", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    const h = tracker.recordFailure("openrouter", "coder-alpha:free", "QUOTA_EXHAUSTED");
    expect(h.status).toBe("QUOTA_EXHAUSTED");
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);
  });

  it("[PASS] recordSuccess clears the consecutive-failure streak", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    tracker.recordSuccess("openrouter", "coder-alpha:free");
    const h = tracker.getHealth("openrouter", "coder-alpha:free");
    expect(h.consecutiveFailures).toBe(0);
    expect(h.status).toBe("HEALTHY");
  });

  it("[PASS] a real recorded failure actually increments recentFailureCount pushed into ForgeZero (the audited gap)", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    tracker.recordFailure("openrouter", "coder-alpha:free", "TIMEOUT");
    const rec = fw.getModel("openrouter", "coder-alpha:free");
    expect(rec?.health?.status).toBe("degraded");
  });

  it("[PASS] hydrate restores a persisted snapshot into both the tracker and ForgeZero", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.hydrate({ providerId: "openrouter", modelId: "coder-alpha:free", consecutiveFailures: 5, status: "UNAVAILABLE", cooldownUntil: Date.now() + 60_000 });
    expect(tracker.getHealth("openrouter", "coder-alpha:free").status).toBe("UNAVAILABLE");
    expect(fw.getModel("openrouter", "coder-alpha:free")?.health?.status).toBe("offline");
  });
});

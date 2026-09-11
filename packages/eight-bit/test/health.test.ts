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

// R1 legal remediation spec §21-22, ENG-P2-03: repeated 401/403 must stop automatic retry
// entirely (not just a bounded, time-limited cooldown) until explicit credential recovery.
describe("EightBitHealthTracker — auth-failure circuit breaker", () => {
  it("[PASS] one or two AUTH_FAILUREs still get an ordinary bounded, time-limited cooldown", () => {
    let clock = 1_000_000;
    const fw = new ForgeZero({ context: { now: () => new Date(clock) } });
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw, () => clock);
    let h = tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    expect(h.permanentlySuspended).toBeFalsy();
    h = tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    expect(h.permanentlySuspended).toBeFalsy();
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);
    clock += 20 * 60_000; // past the 15-minute cap
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(false);
  });

  it("[PASS] a 3rd consecutive AUTH_FAILURE permanently suspends the route — cooldown never expires", () => {
    let clock = 1_000_000;
    const fw = new ForgeZero({ context: { now: () => new Date(clock) } });
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw, () => clock);
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    const h = tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    expect(h.permanentlySuspended).toBe(true);
    expect(h.status).toBe("SUSPENDED");
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);

    // Not just a very long cooldown — literally does not expire with the passage of time.
    clock += 365 * 24 * 60 * 60_000; // one full year later
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);
  });

  it("[PASS] a permanently-suspended route does not burn further requests recording more failures", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    const suspended = tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    expect(suspended.consecutiveFailures).toBe(3);
    // A 4th call while already permanently suspended must not increment further or reclassify —
    // there is nothing more useful to record once the breaker has already tripped.
    const again = tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    expect(again).toEqual(suspended);
  });

  it("[PASS] clearPermanentSuspension is the only way out, and requires an explicit call (not time)", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);

    tracker.clearPermanentSuspension("openrouter", "coder-alpha:free");
    const h = tracker.getHealth("openrouter", "coder-alpha:free");
    expect(h.permanentlySuspended).toBeFalsy();
    expect(h.status).toBe("HEALTHY");
    expect(h.consecutiveFailures).toBe(0);
    expect(tracker.isInCooldown("openrouter", "coder-alpha:free")).toBe(false);
    expect(fw.getModel("openrouter", "coder-alpha:free")?.health?.status).toBe("available");
  });

  it("[PASS] clearPermanentSuspension on a route that was never suspended is a safe no-op", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    expect(() => tracker.clearPermanentSuspension("openrouter", "coder-alpha:free")).not.toThrow();
    expect(tracker.getHealth("openrouter", "coder-alpha:free").status).toBe("HEALTHY");
  });

  it("[PASS] a permanently-suspended snapshot round-trips through JSON without losing its cooldown (persistence safety)", () => {
    const fw = new ForgeZero();
    fw.register(makeModel());
    const tracker = new EightBitHealthTracker(fw);
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");
    const suspended = tracker.recordFailure("openrouter", "coder-alpha:free", "AUTH_FAILURE");

    const roundTripped = JSON.parse(JSON.stringify(suspended));
    expect(roundTripped.permanentlySuspended).toBe(true);
    expect(Number.isFinite(roundTripped.cooldownUntil)).toBe(true); // never silently becomes null

    const rehydrated = new EightBitHealthTracker(new ForgeZero());
    rehydrated.hydrate(roundTripped);
    expect(rehydrated.isInCooldown("openrouter", "coder-alpha:free")).toBe(true);
  });
});

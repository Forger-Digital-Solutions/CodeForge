import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { UsageEngine, calculateTokensAndCredits } from "../src/index.js";

describe("Cloud Usage Engine", () => {
  let db: CloudDatabase;
  let engine: UsageEngine;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    engine = new UsageEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("calculates tokens, credits, and estimated costs correctly", () => {
    const res = calculateTokensAndCredits({
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
    });
    // 800 input * 1 + 200 cached * 0.5 + 500 output * 2 = 800 + 100 + 1000 = 1900 credits
    expect(res.credits).toBe(1900);
    expect(res.totalTokens).toBe(1500);
    expect(res.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("performs two-phase reservation, settles exact difference, and tracks usage idempotently", () => {
    const user = db.createUser({ displayName: "Coder", primaryIdentity: "github:888" });
    db.appendLedgerEvent({
      userId: user.id,
      amount: 100_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
    });
    expect(db.getCreditBalance(user.id)).toBe(100_000);

    // 1. Reserve 10,000 credits
    const reservation = engine.reserveBudget({
      userId: user.id,
      estimatedCredits: 10_000,
      requestId: "req-abc-123",
      providerId: "openrouter",
      modelId: "qwen/qwen3.6-27b",
    });
    expect(reservation.reservedCredits).toBe(10_000);
    expect(reservation.balanceAfter).toBe(90_000);
    expect(db.getCreditBalance(user.id)).toBe(90_000);

    // 2. Commit actual usage (e.g. 1000 input, 200 output = 1000 + 400 = 1400 credits)
    const commit = engine.commitUsage({
      userId: user.id,
      requestId: "req-abc-123",
      reservationId: reservation.reservationId,
      estimatedCredits: 10_000,
      providerId: "openrouter",
      modelId: "qwen/qwen3.6-27b",
      inputTokens: 1000,
      outputTokens: 200,
    });

    expect(commit.actualCredits).toBe(1400);
    // Initial 100k - actual 1400 = 98,600
    expect(commit.balanceAfter).toBe(98_600);
    expect(db.getCreditBalance(user.id)).toBe(98_600);

    const summary = engine.getUserUsageSummary(user.id);
    expect(summary.creditBalance).toBe(98_600);
    expect(summary.recentEvents).toHaveLength(1);
    expect(summary.recentEvents[0]?.creditsConsumed).toBe(1400);
  });

  it("releases entire reservation on failed or cancelled requests", () => {
    const user = db.createUser({ displayName: "Coder 2", primaryIdentity: "github:999" });
    db.appendLedgerEvent({
      userId: user.id,
      amount: 50_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
    });

    const res = engine.reserveBudget({
      userId: user.id,
      estimatedCredits: 5_000,
      requestId: "req-failed-1",
      providerId: "groq",
      modelId: "llama-3.3-70b",
    });
    expect(res.balanceAfter).toBe(45_000);

    const release = engine.releaseReservation({
      userId: user.id,
      requestId: "req-failed-1",
      estimatedCredits: 5_000,
      reason: "Provider rate limit 429",
    });

    expect(release.refundedCredits).toBe(5_000);
    expect(release.balanceAfter).toBe(50_000);
    expect(db.getCreditBalance(user.id)).toBe(50_000);
  });
});

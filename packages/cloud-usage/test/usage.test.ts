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

  it("performs two-phase reservation, settles exact difference, and tracks usage idempotently", async () => {
    const user = await db.createUser({ displayName: "Coder", primaryIdentity: "github:888" });
    await db.appendLedgerEvent({
      userId: user.id,
      amount: 100_000,
      eventType: "CREDIT_PURCHASED",
    });
    expect(await db.getCreditBalance(user.id)).toBe(100_000);

    // 1. Reserve 10,000 credits
    const reservation = await engine.reserveBudget({
      userId: user.id,
      estimatedCredits: 10_000,
      requestId: "req-abc-123",
      providerId: "openrouter",
      modelId: "qwen/qwen3.6-27b",
    });
    expect(reservation.reservedCredits).toBe(10_000);
    expect(reservation.balanceAfter).toBe(90_000);
    expect(await db.getCreditBalance(user.id)).toBe(90_000);

    // 2. Commit actual usage (e.g. 1000 input, 200 output = 1000 + 400 = 1400 credits)
    const commit = await engine.commitUsage({
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
    expect(await db.getCreditBalance(user.id)).toBe(98_600);

    const summary = await engine.getUserUsageSummary(user.id);
    expect(summary.creditBalance).toBe(98_600);
    expect(summary.recentEvents).toHaveLength(1);
    expect(summary.recentEvents[0]?.creditsConsumed).toBe(1400);
  });

  it("rejects malformed or over-budget settlement input without creating credit", async () => {
    const user = await db.createUser({ displayName: "Bounded User", primaryIdentity: "github:bounded" });
    await db.appendLedgerEvent({ userId: user.id, amount: 10_000, eventType: "CREDIT_PURCHASED" });
    await expect(engine.reserveBudget({ userId: user.id, estimatedCredits: -1, requestId: "invalid-reserve", providerId: "groq", modelId: "m" })).rejects.toThrow(/estimatedCredits/);
    const reservation = await engine.reserveBudget({ userId: user.id, estimatedCredits: 10_000, requestId: "over-settlement", providerId: "groq", modelId: "m" });
    await expect(engine.commitUsage({ userId: user.id, requestId: "over-settlement", reservationId: reservation.reservationId, providerId: "groq", modelId: "m", inputTokens: 10_001, outputTokens: 0 })).rejects.toThrow(/Insufficient credit balance/);
    expect(await db.getCreditBalance(user.id)).toBe(0);
    const released = await engine.releaseReservation({ userId: user.id, requestId: "over-settlement", reason: "settlement rejected" });
    expect(released.balanceAfter).toBe(10_000);
  });

  it("releases entire reservation on failed or cancelled requests", async () => {
    const user = await db.createUser({ displayName: "Coder 2", primaryIdentity: "github:999" });
    await db.appendLedgerEvent({
      userId: user.id,
      amount: 50_000,
      eventType: "CREDIT_PURCHASED",
    });

    const res = await engine.reserveBudget({
      userId: user.id,
      estimatedCredits: 5_000,
      requestId: "req-failed-1",
      providerId: "groq",
      modelId: "llama-3.3-70b",
    });
    expect(res.balanceAfter).toBe(45_000);

    const release = await engine.releaseReservation({
      userId: user.id,
      requestId: "req-failed-1",
      estimatedCredits: 5_000,
      reason: "Provider rate limit 429",
    });

    expect(release.refundedCredits).toBe(5_000);
    expect(release.balanceAfter).toBe(50_000);
    expect(await db.getCreditBalance(user.id)).toBe(50_000);
  });

  it("keeps Free allowance isolated and reports authoritative used, reserved, and remaining credits", async () => {
    const accountA = await db.createUser({ displayName: "Free A", primaryIdentity: "github:free-a" });
    const accountB = await db.createUser({ displayName: "Free B", primaryIdentity: "github:free-b" });
    const reserved = await engine.reserveBudget({
      userId: accountA.id,
      estimatedCredits: 12_000,
      requestId: "free-a-request",
      providerId: "codeforge",
      modelId: "codeforge/forgeauto-free",
      freeAllowance: true,
    });

    expect(reserved.balanceAfter).toBe(488_000);
    expect(await db.getCreditBalance(accountA.id)).toBe(0);
    const inFlight = await engine.getUserUsageSummary(accountA.id);
    expect(inFlight.freeReservedCredits).toBe(12_000);
    expect(inFlight.freeRemainingCredits).toBe(488_000);

    await engine.commitUsage({
      userId: accountA.id,
      requestId: "free-a-request",
      providerId: "codeforge",
      modelId: "codeforge/forgeauto-free",
      inputTokens: 1_000,
      outputTokens: 100,
    });
    await engine.commitUsage({
      userId: accountA.id,
      requestId: "free-a-request",
      providerId: "codeforge",
      modelId: "codeforge/forgeauto-free",
      inputTokens: 1_000,
      outputTokens: 100,
    });
    const settled = await engine.getUserUsageSummary(accountA.id);
    expect(settled.freeUsedCredits).toBe(1_200);
    expect(settled.freeReservedCredits).toBe(0);
    expect(settled.freeRemainingCredits).toBe(498_800);

    const accountBUsage = await engine.getUserUsageSummary(accountB.id);
    expect(accountBUsage.freeAllowanceCredits).toBe(500_000);
    expect(accountBUsage.freeUsedCredits).toBe(0);
    expect(accountBUsage.freeRemainingCredits).toBe(500_000);

    await engine.reserveBudget({ userId: accountA.id, estimatedCredits: 5_000, requestId: "free-cancelled", providerId: "codeforge", modelId: "codeforge/forgeauto-free", freeAllowance: true });
    await engine.releaseReservation({ userId: accountA.id, requestId: "free-cancelled", reason: "cancelled before provider dispatch" });
    const afterCancellation = await engine.getUserUsageSummary(accountA.id);
    expect(afterCancellation.freeUsedCredits).toBe(1_200);
    expect(afterCancellation.freeReservedCredits).toBe(0);
    expect(afterCancellation.freeRemainingCredits).toBe(498_800);
  });

  it("enforces the per-task cap, exact remaining monthly allowance, and no rollover", async () => {
    const user = await db.createUser({ displayName: "Boundary User", primaryIdentity: "github:boundary" });
    const period = (await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-05-12T00:00:00Z"))).period;

    await expect(db.reserveCredits({ requestId: "task-over-limit", userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 50_001, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 })).rejects.toThrow(/Free task credit limit/);

    for (let index = 0; index < 9; index++) {
      const requestId = `boundary-${index}`;
      await db.reserveCredits({ requestId, userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 50_000, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 });
      await db.settleReservation({ requestId, userId: user.id, actualCredits: 50_000 });
    }

    const lastRequest = "boundary-last";
    await db.reserveCredits({ requestId: lastRequest, userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 50_000, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 });
    await db.settleReservation({ requestId: lastRequest, userId: user.id, actualCredits: 49_999 });
    expect(await db.getUsagePeriodReservedCredits(period.id)).toBe(0);

    await expect(db.reserveCredits({ requestId: "one-credit-too-many", userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 2, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 })).rejects.toThrow(/Free allowance exhausted/);
    const exactRemaining = await db.reserveCredits({ requestId: "exactly-one-credit", userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 1, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 });
    expect(exactRemaining.balanceAfter).toBe(0);
    await db.settleReservation({ requestId: "exactly-one-credit", userId: user.id, actualCredits: 1 });

    const completedPeriod = (await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-05-31T23:59:59Z"))).period;
    const nextMonth = (await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-06-01T00:00:00Z"))).period;
    expect(nextMonth.id).not.toBe(period.id);
    expect(nextMonth.creditsUsed).toBe(0);
    expect(completedPeriod.creditsUsed).toBe(500_000);
  });

  it("prevents simultaneous reservations from oversubscribing a period", async () => {
    const user = await db.createUser({ displayName: "Race User", primaryIdentity: "github:reservation-race" });
    const period = (await db.getOrCreateCurrentUsagePeriod(user.id, 500_000)).period;
    for (let index = 0; index < 9; index++) {
      const requestId = `race-seed-${index}`;
      await db.reserveCredits({ requestId, userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 50_000, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 });
      await db.settleReservation({ requestId, userId: user.id, actualCredits: 50_000 });
    }

    const attempts = await Promise.allSettled(["race-a", "race-b"].map((requestId) => db.reserveCredits({
      requestId,
      userId: user.id,
      providerId: "codeforge",
      modelId: "codeforge/forgeauto-free",
      reservedCredits: 50_000,
      usagePeriodId: period.id,
      maxTaskSpendCredits: 50_000,
    })));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.getUsagePeriodReservedCredits(period.id)).toBe(50_000);
  });
});


import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { UsageEngine } from "../src/index.js";

/**
 * Mandatory per-user Free usage acceptance tests (zero-setup spec §30):
 * A isolation, B exhaustion + unaffected peer, C reset, D concurrent reservation,
 * E upstream-failure settlement, F failover single-charge (idempotent re-reservation).
 * Every scenario runs two users side by side because the invariant under test is that one
 * user's usage can never appear in, or drain, another user's ledger.
 */
describe("Per-user Free usage — two-user isolation (spec §30)", () => {
  let db: CloudDatabase;
  let engine: UsageEngine;
  let userA: { id: string };
  let userB: { id: string };

  const GRANT = 10_000;

  const reserve = (userId: string, requestId: string, credits: number) =>
    engine.reserveBudget({
      userId,
      requestId,
      estimatedCredits: credits,
      providerId: "groq",
      modelId: "llama-3.1-8b-instruct:free",
    });

  beforeEach(async () => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    engine = new UsageEngine(db);
    userA = await db.createUser({ displayName: "User A", primaryIdentity: "github:1001" });
    userB = await db.createUser({ displayName: "User B", primaryIdentity: "github:1002" });
    // Mirror the production signup flow (auth-service grants the period at account creation):
    // the period IS the source of the allowance and the initial credit balance.
    await db.getOrCreateCurrentUsagePeriod(userA.id, GRANT);
    await db.getOrCreateCurrentUsagePeriod(userB.id, GRANT);
    expect(await db.getCreditBalance(userA.id)).toBe(GRANT);
    expect(await db.getCreditBalance(userB.id)).toBe(GRANT);
  });

  afterEach(() => {
    db.close();
  });

  it("Test A — user A's usage changes only A's ledger", async () => {
    const beforeB = await db.getCreditBalance(userB.id);
    const res = await reserve(userA.id, "req-a-1", 4_000);
    expect(res.balanceAfter).toBe(GRANT - 4_000);

    const commit = await engine.commitUsage({
      userId: userA.id,
      requestId: "req-a-1",
      reservationId: res.reservationId,
      estimatedCredits: 4_000,
      providerId: "groq",
      modelId: "llama-3.1-8b-instruct:free",
      inputTokens: 1_000,
      outputTokens: 500,
    });
    expect(commit.balanceAfter).toBe(GRANT - commit.actualCredits);

    expect(await db.getCreditBalance(userB.id)).toBe(beforeB);
    const summaryB = await engine.getUserUsageSummary(userB.id);
    expect(summaryB.freeAllowance.usedCredits).toBe(0);
  });

  it("Test B — exhausting A's allowance blocks A but leaves B fully usable", async () => {
    await reserve(userA.id, "req-a-all", GRANT);
    await expect(reserve(userA.id, "req-a-over", 1)).rejects.toThrow(/Insufficient credit balance/);

    const summaryA = await engine.getUserUsageSummary(userA.id);
    expect(summaryA.freeAllowance.remainingCredits).toBe(0);

    const resB = await reserve(userB.id, "req-b-1", 4_000);
    expect(resB.balanceAfter).toBe(GRANT - 4_000);
  });

  it("Test C — a new usage period grants a fresh allowance with a server-controlled reset", async () => {
    const first = await db.getOrCreateCurrentUsagePeriod(userA.id);
    expect(first.grantedNewAllowance).toBe(false);

    // Advance past the period boundary: the server mints the new window, re-grants the allowance,
    // and issues the new reset stamp. Client clocks are never consulted.
    const after = new Date(Date.parse(first.period.periodEnd) + 1);
    const next = await db.getOrCreateCurrentUsagePeriod(userA.id, GRANT, after);
    expect(next.grantedNewAllowance).toBe(true);
    expect(Date.parse(next.period.periodStart)).toBeGreaterThanOrEqual(Date.parse(first.period.periodEnd));
    expect(Date.parse(next.period.periodEnd)).toBeGreaterThan(Date.parse(next.period.periodStart));

    // The summary exposes the reset timestamp of the user's CURRENT period (the pre-reset one).
    const summary = await engine.getUserUsageSummary(userA.id);
    expect(summary.freeAllowance.remainingCredits).toBe(GRANT);
    expect(summary.freeAllowance.periodEnd).toBe(first.period.periodEnd);
    expect(Date.parse(summary.freeAllowance.periodEnd)).toBeGreaterThan(Date.now());
  });

  it("Test D — concurrent reservations can never overspend A's allowance", async () => {
    // 10 concurrent 4,000-credit reservations against a 10,000-credit balance: exactly 2 may hold.
    const attempts = Array.from({ length: 10 }, (_, i) =>
      reserve(userA.id, `req-a-cc-${i}`, 4_000).then(
        (r) => ({ ok: true as const, balance: r.balanceAfter }),
        (err: Error) => ({ ok: false as const, error: err.message }),
      ),
    );
    const results = await Promise.all(attempts);
    const granted = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok && r.error.includes("Insufficient credit balance"));

    expect(granted).toHaveLength(2);
    expect(denied).toHaveLength(8);
    expect(await db.getCreditBalance(userA.id)).toBe(2_000);
    // Peer untouched by the race.
    expect(await db.getCreditBalance(userB.id)).toBe(GRANT);
  });

  it("Test E — an upstream failure releases the full hold and consumes nothing", async () => {
    const before = await db.getCreditBalance(userA.id);
    await reserve(userA.id, "req-a-fail", 5_000);
    await engine.releaseReservation({ userId: userA.id, requestId: "req-a-fail", estimatedCredits: 5_000, reason: "upstream 502" });

    expect(await db.getCreditBalance(userA.id)).toBe(before);
    const summary = await engine.getUserUsageSummary(userA.id);
    expect(summary.freeAllowance.usedCredits).toBe(0);
    expect(summary.freeAllowance.remainingCredits).toBe(GRANT);
  });

  it("Test F — a retried request id (failover re-reservation) charges exactly once", async () => {
    const before = await db.getCreditBalance(userA.id);
    const first = await reserve(userA.id, "req-a-same", 3_000);
    const second = await reserve(userA.id, "req-a-same", 3_000);

    // Same requestId → the existing reservation is returned, never a second hold.
    expect(second.reservationId).toBe(first.reservationId);
    expect(await db.getReservationByRequestId("req-a-same")).toBeDefined();
    expect(await db.getCreditBalance(userA.id)).toBe(before - 3_000);

    const commit = await engine.commitUsage({
      userId: userA.id,
      requestId: "req-a-same",
      reservationId: first.reservationId,
      estimatedCredits: 3_000,
      providerId: "groq",
      modelId: "llama-3.1-8b-instruct:free",
      inputTokens: 500,
      outputTokens: 250,
    });
    expect(commit.actualCredits).toBeLessThanOrEqual(3_000);
    expect(await db.getCreditBalance(userA.id)).toBe(before - commit.actualCredits);
  });

  it("Cross-user reservation ids are rejected — A's request can never settle against B", async () => {
    await reserve(userA.id, "req-cross", 1_000);
    await expect(
      engine.reserveBudget({
        userId: userB.id,
        requestId: "req-cross",
        estimatedCredits: 1_000,
        providerId: "groq",
        modelId: "llama-3.1-8b-instruct:free",
      }),
    ).rejects.toThrow(/another user account/);
    expect(await db.getCreditBalance(userB.id)).toBe(GRANT);
  });

  it("Summaries are per-user: A's consumption never appears in B's summary", async () => {
    const res = await reserve(userA.id, "req-a-iso", 6_000);
    await engine.commitUsage({
      userId: userA.id,
      requestId: "req-a-iso",
      reservationId: res.reservationId,
      estimatedCredits: 6_000,
      providerId: "groq",
      modelId: "llama-3.1-8b-instruct:free",
      inputTokens: 2_000,
      outputTokens: 1_000,
    });

    const [summaryA, summaryB] = await Promise.all([
      engine.getUserUsageSummary(userA.id),
      engine.getUserUsageSummary(userB.id),
    ]);
    expect(summaryA.freeAllowance.usedCredits).toBeGreaterThan(0);
    expect(summaryA.freeAllowance.remainingCredits).toBeLessThan(GRANT);
    expect(summaryB.freeAllowance.usedCredits).toBe(0);
    expect(summaryB.freeAllowance.remainingCredits).toBe(GRANT);
    // The reset timestamp is server-controlled, not client-derived, and per-user identical in shape.
    expect(typeof summaryB.freeAllowance.periodEnd).toBe("string");
  });
});

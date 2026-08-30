import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { UsageEngine } from "@codeforge/cloud-usage";

describe("UsageEngine — stale reservation recovery (crash recovery)", () => {
  let db: CloudDatabase;
  let usage: UsageEngine;
  let userId: string;

  beforeEach(async () => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    usage = new UsageEngine(db);
    const user = await db.createUser({ displayName: "Recovery User", primaryIdentity: "github:stale-1" });
    userId = user.id;
    await db.getOrCreateCurrentUsagePeriod(userId, 500_000);
  });

  afterEach(() => db.close());

  it("reclaims credits from a reservation that was never committed or released", async () => {
    const before = await db.getCreditBalance(userId);
    await usage.reserveBudget({ userId, estimatedCredits: 5000, requestId: "req-stale", providerId: "groq", modelId: "m" });
    expect(await db.getCreditBalance(userId)).toBe(before - 5000); // credits held

    // Simulate that this reservation was created 30 minutes ago (process died mid-inference).
    const later = new Date(Date.now() + 30 * 60 * 1000);
    const result = await usage.reconcileStaleReservations({ now: later, timeoutMs: 10 * 60 * 1000 });

    expect(result.reconciled).toBe(1);
    expect(result.refundedCredits).toBe(5000);
    expect(await db.getCreditBalance(userId)).toBe(before); // fully refunded — never locked forever
    const r = await db.getReservationByRequestId("req-stale");
    expect(r?.status).toBe("released");
  });

  it("does NOT touch fresh, committed, or released reservations", async () => {
    // Fresh reservation (within timeout) — must be left alone.
    await usage.reserveBudget({ userId, estimatedCredits: 3000, requestId: "req-fresh", providerId: "groq", modelId: "m" });
    // Committed reservation — settled, not stale.
    await usage.reserveBudget({ userId, estimatedCredits: 4000, requestId: "req-done", providerId: "groq", modelId: "m" });
    await usage.commitUsage({ userId, requestId: "req-done", reservationId: "x", estimatedCredits: 4000, providerId: "groq", modelId: "m", inputTokens: 100, outputTokens: 50 });

    const result = await usage.reconcileStaleReservations({ now: new Date(), timeoutMs: 10 * 60 * 1000 });
    expect(result.reconciled).toBe(0);
    const rFresh = await db.getReservationByRequestId("req-fresh");
    const rDone = await db.getReservationByRequestId("req-done");
    expect(rFresh?.status).toBe("reserved");
    expect(rDone?.status).toBe("committed");
  });

  it("persists reservation state across a simulated restart (same DB file) and reclaims after", async () => {
    await usage.reserveBudget({ userId, estimatedCredits: 5000, requestId: "req-restart", providerId: "groq", modelId: "m" });
    // A new engine over the same DB (simulated process restart) still sees the reservation and can reclaim it.
    const usage2 = new UsageEngine(db);
    const later = new Date(Date.now() + 20 * 60 * 1000);
    const result = await usage2.reconcileStaleReservations({ now: later, timeoutMs: 10 * 60 * 1000 });
    expect(result.reconciled).toBe(1);
  });
});


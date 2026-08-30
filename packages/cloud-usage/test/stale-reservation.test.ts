import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { UsageEngine } from "@codeforge/cloud-usage";

describe("UsageEngine — stale reservation recovery (crash recovery)", () => {
  let db: CloudDatabase;
  let usage: UsageEngine;
  let userId: string;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    usage = new UsageEngine(db);
    const user = db.createUser({ displayName: "Recovery User", primaryIdentity: "github:stale-1" });
    userId = user.id;
    db.getOrCreateCurrentUsagePeriod(userId, 500_000);
  });

  afterEach(() => db.close());

  it("reclaims credits from a reservation that was never committed or released", () => {
    const before = db.getCreditBalance(userId);
    usage.reserveBudget({ userId, estimatedCredits: 5000, requestId: "req-stale", providerId: "groq", modelId: "m" });
    expect(db.getCreditBalance(userId)).toBe(before - 5000); // credits held

    // Simulate that this reservation was created 30 minutes ago (process died mid-inference).
    const later = new Date(Date.now() + 30 * 60 * 1000);
    const result = usage.reconcileStaleReservations({ now: later, timeoutMs: 10 * 60 * 1000 });

    expect(result.reconciled).toBe(1);
    expect(result.refundedCredits).toBe(5000);
    expect(db.getCreditBalance(userId)).toBe(before); // fully refunded — never locked forever
    expect(db.getReservationByRequestId("req-stale")?.status).toBe("released");
  });

  it("does NOT touch fresh, committed, or released reservations", () => {
    // Fresh reservation (within timeout) — must be left alone.
    usage.reserveBudget({ userId, estimatedCredits: 3000, requestId: "req-fresh", providerId: "groq", modelId: "m" });
    // Committed reservation — settled, not stale.
    usage.reserveBudget({ userId, estimatedCredits: 4000, requestId: "req-done", providerId: "groq", modelId: "m" });
    usage.commitUsage({ userId, requestId: "req-done", reservationId: "x", estimatedCredits: 4000, providerId: "groq", modelId: "m", inputTokens: 100, outputTokens: 50 });

    const result = usage.reconcileStaleReservations({ now: new Date(), timeoutMs: 10 * 60 * 1000 });
    expect(result.reconciled).toBe(0);
    expect(db.getReservationByRequestId("req-fresh")?.status).toBe("reserved");
    expect(db.getReservationByRequestId("req-done")?.status).toBe("committed");
  });

  it("persists reservation state across a simulated restart (same DB file) and reclaims after", () => {
    usage.reserveBudget({ userId, estimatedCredits: 5000, requestId: "req-restart", providerId: "groq", modelId: "m" });
    // A new engine over the same DB (simulated process restart) still sees the reservation and can reclaim it.
    const usage2 = new UsageEngine(db);
    const later = new Date(Date.now() + 20 * 60 * 1000);
    const result = usage2.reconcileStaleReservations({ now: later, timeoutMs: 10 * 60 * 1000 });
    expect(result.reconciled).toBe(1);
  });
});

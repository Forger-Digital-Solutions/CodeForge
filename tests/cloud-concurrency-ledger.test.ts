import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { UsageEngine } from "@codeforge/cloud-usage";

describe("Phase 14 — Adversarial Ledger Concurrency & Reservation State Machine", () => {
  let db: CloudDatabase;
  let usage: UsageEngine;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    usage = new UsageEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it("handles high concurrency competition: only 1 request succeeds from 50 concurrent 4k reservations with 5k balance", async () => {
    const user = db.createUser({ displayName: "Contended User", primaryIdentity: "github:5000" });

    // Grant 5,000 initial balance
    db.appendLedgerEvent({
      userId: user.id,
      amount: 5000,
      eventType: "FREE_ALLOWANCE_GRANTED",
    });
    expect(db.getCreditBalance(user.id)).toBe(5000);

    // 50 concurrent requests trying to reserve 4,000 credits each
    const concurrency = 50;
    const promises = Array.from({ length: concurrency }).map(async (_, idx) => {
      try {
        const res = usage.reserveBudget({
          userId: user.id,
          estimatedCredits: 4000,
          requestId: `req-race-${idx}`,
          providerId: "codeforge",
          modelId: "test-model",
        });
        return { success: true, res };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    const results = await Promise.all(promises);
    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Exactly 1 must succeed, 49 must fail
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(49);

    // Invariant: Balance must be non-negative
    const finalBalance = db.getCreditBalance(user.id);
    expect(finalBalance).toBe(1000);
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    // Invariant: Reconciled ledger sum equals final balance
    const events = db.listLedgerEvents(user.id, 100);
    const sum = events.reduce((acc, ev) => acc + ev.amount, 0);
    expect(sum).toBe(1000);
    expect(events[0]?.balanceAfter).toBe(1000);
  });

  it("handles concurrent duplicate request IDs safely (idempotent single reservation)", async () => {
    const user = db.createUser({ displayName: "Dup User", primaryIdentity: "github:6000" });
    db.appendLedgerEvent({ userId: user.id, amount: 20000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const sharedRequestId = "req-idempotent-race-1";

    // 10 concurrent calls with the EXACT same requestId for the same user
    const promises = Array.from({ length: 10 }).map(async () => {
      try {
        return {
          success: true,
          res: usage.reserveBudget({
            userId: user.id,
            estimatedCredits: 5000,
            requestId: sharedRequestId,
            providerId: "codeforge",
            modelId: "test-model",
          }),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    const results = await Promise.all(promises);
    const successful = results.filter((r) => r.success);

    // All return success with the same reservation
    expect(successful.length).toBe(10);
    const resId = (successful[0] as any).res.reservationId;
    for (const item of successful) {
      expect((item as any).res.reservationId).toBe(resId);
    }

    // Reservation in DB is created once
    const reservation = db.getReservationByRequestId(sharedRequestId);
    expect(reservation?.status).toBe("reserved");
  });

  it("proves state machine transitions: duplicate commit is idempotent, release after commit is denied, commit after release is denied", () => {
    const user = db.createUser({ displayName: "State User", primaryIdentity: "github:7000" });
    db.appendLedgerEvent({ userId: user.id, amount: 50000, eventType: "FREE_ALLOWANCE_GRANTED" });

    // 1. Reserve
    usage.reserveBudget({
      userId: user.id,
      estimatedCredits: 5000,
      requestId: "req-state-1",
      providerId: "codeforge",
      modelId: "test-model",
    });

    // 2. Commit
    const commit1 = usage.commitUsage({
      userId: user.id,
      requestId: "req-state-1",
      providerId: "codeforge",
      modelId: "test-model",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(commit1.actualCredits).toBeGreaterThan(0);

    // Duplicate commit is idempotent no-op
    const commit2 = usage.commitUsage({
      userId: user.id,
      requestId: "req-state-1",
      providerId: "codeforge",
      modelId: "test-model",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(commit2.actualCredits).toBe(commit1.actualCredits);

    // Release after commit is strictly DENIED
    expect(() => {
      usage.releaseReservation({
        userId: user.id,
        requestId: "req-state-1",
      });
    }).toThrow(/already been committed/);

    // 3. New request for release flow
    usage.reserveBudget({
      userId: user.id,
      estimatedCredits: 5000,
      requestId: "req-state-2",
      providerId: "codeforge",
      modelId: "test-model",
    });

    // Release
    const rel1 = usage.releaseReservation({
      userId: user.id,
      requestId: "req-state-2",
    });
    expect(rel1.refundedCredits).toBe(5000);

    // Duplicate release is idempotent no-op
    const rel2 = usage.releaseReservation({
      userId: user.id,
      requestId: "req-state-2",
    });
    expect(rel2.refundedCredits).toBe(5000);

    // Commit after release is strictly DENIED
    expect(() => {
      usage.commitUsage({
        userId: user.id,
        requestId: "req-state-2",
        providerId: "codeforge",
        modelId: "test-model",
        inputTokens: 100,
        outputTokens: 50,
      });
    }).toThrow(/already been released/);
  });
});

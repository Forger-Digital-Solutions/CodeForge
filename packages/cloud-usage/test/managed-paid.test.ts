import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteSessionPersistence } from "@codeforge/sessions";
import {
  ManagedPaidAllowanceLedger,
  type ManagedPaidPolicy,
  type ManagedPaidReservationInput,
} from "../src/managed-paid.js";

const OWNER = "alice";

function policy(overrides: Partial<ManagedPaidPolicy> = {}): ManagedPaidPolicy {
  return {
    ownerUserId: OWNER,
    entitlement: "PAID",
    costMode: "BALANCED",
    includedAllowanceUsd: 10,
    overageEnabled: false,
    hardMaximumUsd: 20,
    userOwnedAllowed: true,
    paidLeadAllowed: false,
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<ManagedPaidReservationInput> = {}): ManagedPaidReservationInput {
  return {
    requestId: "req-1",
    taskId: "task-1",
    role: "CODER",
    providerId: "openai",
    modelId: "gpt-5.6-luna",
    estimatedUsd: 1,
    priceSource: "https://developers.openai.com/pricing",
    ...overrides,
  };
}

const restartDir = mkdtempSync(join(tmpdir(), "codeforge-managed-paid-"));
afterAll(() => rmSync(restartDir, { recursive: true, force: true }));

describe("R55 managed paid allowance ledger", () => {
  it("rejects FREE entitlement and unknown allowance ceilings — never unlimited", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      await expect(ledger.reserve(policy({ entitlement: "FREE" }), input())).rejects.toMatchObject({ code: "MANAGED_PAID_ENTITLEMENT_REQUIRED" });
      await expect(ledger.reserve(policy({ includedAllowanceUsd: null }), input())).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_UNKNOWN" });
      await expect(ledger.reserve(policy({ hardMaximumUsd: null }), input())).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_UNKNOWN" });
      await expect(ledger.snapshot(policy({ hardMaximumUsd: null }))).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_UNKNOWN" });
      await expect(ledger.reserve(policy({ hardMaximumUsd: -1 }), input())).rejects.toMatchObject({ code: "MANAGED_PAID_AMOUNT_INVALID" });
      await expect(ledger.reserve(policy({ updatedAt: "not-a-date" }), input())).rejects.toMatchObject({ code: "MANAGED_PAID_POLICY_INVALID" });
    } finally {
      await db.close();
    }
  });

  it("caps reservations at min(included, hardMax) without overage and at hardMax with overage", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      // included=10, hardMax=20, overage off → ceiling is 10.
      const noOverage = policy({ includedAllowanceUsd: 10, hardMaximumUsd: 20, overageEnabled: false });
      await ledger.reserve(noOverage, input({ requestId: "r1", estimatedUsd: 9 }));
      await expect(ledger.reserve(noOverage, input({ requestId: "r2", estimatedUsd: 1.5 }))).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_EXHAUSTED" });
      const snap = await ledger.snapshot(noOverage);
      expect([snap.ceilingUsd, snap.reservedUsd, snap.availableUsd]).toEqual([10, 9, 1]);
      // overage on → ceiling is the hard maximum.
      const overage = policy({ ownerUserId: "bob", includedAllowanceUsd: 10, hardMaximumUsd: 20, overageEnabled: true });
      await ledger.reserve(overage, input({ requestId: "r1", estimatedUsd: 15 }));
      expect((await ledger.snapshot(overage)).availableUsd).toBe(5);
      await expect(ledger.reserve(overage, input({ requestId: "r2", estimatedUsd: 5.5 }))).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_EXHAUSTED" });
    } finally {
      await db.close();
    }
  });

  it("exhausts the allowance: settled charges consume headroom and the next reserve fails", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const p = policy({ includedAllowanceUsd: 2, hardMaximumUsd: 2 });
      await ledger.reserve(p, input({ requestId: "a", estimatedUsd: 1.5 }));
      await ledger.settle(OWNER, "a", 1.4, "OBSERVED");
      expect((await ledger.snapshot(p)).consumedUsd).toBeCloseTo(1.4, 6);
      await ledger.reserve(p, input({ requestId: "b", estimatedUsd: 0.6 }));
      await expect(ledger.reserve(p, input({ requestId: "c", estimatedUsd: 0.01 }))).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_EXHAUSTED" });
    } finally {
      await db.close();
    }
  });

  it("is idempotent on replay and rejects a conflicting duplicate requestId", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const p = policy();
      const first = await ledger.reserve(p, input());
      const replay = await ledger.reserve(p, input());
      expect(replay).toEqual(first);
      expect((await ledger.snapshot(p)).reservedUsd).toBe(1);
      await expect(ledger.reserve(p, input({ estimatedUsd: 2 }))).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_CONFLICT" });
      await expect(ledger.reserve(p, input({ providerId: "other" }))).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_CONFLICT" });
      // Settle is idempotent with the same observed actual and conflicts on a different one.
      const receipt = await ledger.settle(OWNER, "req-1", 0.8, "OBSERVED");
      expect(receipt.chargedUsd).toBe(0.8);
      expect(await ledger.settle(OWNER, "req-1", 0.8, "OBSERVED")).toEqual(receipt);
      await expect(ledger.settle(OWNER, "req-1", 0.9, "OBSERVED")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_CONFLICT" });
      await expect(ledger.release(OWNER, "req-1")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_CONFLICT" });
    } finally {
      await db.close();
    }
  });

  it("settles OBSERVED actuals and ESTIMATED reserves — a null actual is never zeroed", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const p = policy();
      await ledger.reserve(p, input({ requestId: "obs", estimatedUsd: 1 }));
      const observed = await ledger.settle(OWNER, "obs", 0.42, "OBSERVED");
      expect([observed.actualUsd, observed.chargedUsd, observed.confidence]).toEqual([0.42, 0.42, "OBSERVED"]);
      await ledger.reserve(p, input({ requestId: "est", estimatedUsd: 1.25 }));
      const estimated = await ledger.settle(OWNER, "est", null, "ESTIMATED");
      expect([estimated.actualUsd, estimated.chargedUsd, estimated.confidence]).toEqual([null, 1.25, "ESTIMATED"]);
      // Confidence is forced to match the evidence — a null actual cannot claim OBSERVED.
      await ledger.reserve(p, input({ requestId: "bad" }));
      await expect(ledger.settle(OWNER, "bad", null, "OBSERVED")).rejects.toMatchObject({ code: "MANAGED_PAID_CONFIDENCE_INVALID" });
      await expect(ledger.settle(OWNER, "bad", 0.5, "ESTIMATED")).rejects.toMatchObject({ code: "MANAGED_PAID_CONFIDENCE_INVALID" });
      await expect(ledger.settle(OWNER, "missing", null, "ESTIMATED")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_UNKNOWN" });
      const receipts = await ledger.receipts(OWNER, "task-1");
      expect(receipts).toHaveLength(2);
      expect(JSON.stringify(receipts)).not.toContain("prompt");
      expect(JSON.stringify(receipts)).not.toContain("apiKey");
    } finally {
      await db.close();
    }
  });

  it("refuses an OBSERVED actual above the reserved estimate — the hold stays OPEN", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const p = policy();
      await ledger.reserve(p, input({ requestId: "over-actual", estimatedUsd: 1 }));
      // The provider's reported cost exceeds the conservative reservation: this is an
      // accounting invariant breach — no false lower charge, no silent hard-max breach.
      await expect(ledger.settle(OWNER, "over-actual", 1.5, "OBSERVED")).rejects.toMatchObject({ code: "MANAGED_PAID_ACTUAL_EXCEEDS_RESERVATION" });
      const snap = await ledger.snapshot(p);
      expect([snap.reservedUsd, snap.consumedUsd]).toEqual([1, 0]);
      expect(await ledger.receipts(OWNER, "task-1")).toEqual([]);
      // The OPEN hold still belongs to normal recovery: release returns the headroom.
      await ledger.release(OWNER, "over-actual");
      expect((await ledger.snapshot(p)).reservedUsd).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("rejects an idempotent replay whose stored receipt does not match the settlement", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const p = policy();
      await ledger.reserve(p, input({ requestId: "settled", estimatedUsd: 1 }));
      const receipt = await ledger.settle(OWNER, "settled", null, "ESTIMATED");
      // Replay with identical terms returns the stored receipt unchanged.
      expect(await ledger.settle(OWNER, "settled", null, "ESTIMATED")).toEqual(receipt);
      // A foreign record at the receipt key must not pass as this settlement.
      const receiptId = `managed-paid-receipt:${createHash("sha256").update(`${OWNER}\0settled`).digest("hex")}`;
      const stored = await db.getWorkItem(receiptId) as unknown as { receipt: Record<string, unknown> };
      await db.upsertWorkItem({ ...stored, receipt: { ...stored.receipt, ownerUserId: "mallory" } } as never);
      await expect(ledger.settle(OWNER, "settled", null, "ESTIMATED")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_CONFLICT" });
    } finally {
      await db.close();
    }
  });

  it("releases only open reservations and frees the reserved headroom", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const p = policy({ includedAllowanceUsd: 1, hardMaximumUsd: 1 });
      await ledger.reserve(p, input({ requestId: "r", estimatedUsd: 1 }));
      await expect(ledger.reserve(p, input({ requestId: "blocked", estimatedUsd: 0.5 }))).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_EXHAUSTED" });
      await ledger.release(OWNER, "r");
      await ledger.release(OWNER, "r"); // releasing twice is idempotent
      expect((await ledger.snapshot(p)).reservedUsd).toBe(0);
      await ledger.reserve(p, input({ requestId: "unblocked", estimatedUsd: 0.5 }));
      await expect(ledger.release(OWNER, "missing")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_UNKNOWN" });
    } finally {
      await db.close();
    }
  });

  it("survives a persistence restart — reservations, receipts, and headroom all reopen intact", async () => {
    const dbPath = join(restartDir, "managed-paid.db");
    const p = policy({ includedAllowanceUsd: 5, hardMaximumUsd: 5 });
    const db1 = new SqliteSessionPersistence({ dbPath });
    try {
      const ledger1 = new ManagedPaidAllowanceLedger(db1);
      await ledger1.reserve(p, input({ requestId: "persisted", estimatedUsd: 2 }));
      await ledger1.settle(OWNER, "persisted", 1.75, "OBSERVED");
      await ledger1.reserve(p, input({ requestId: "open", estimatedUsd: 1 }));
    } finally {
      await db1.close();
    }
    const db2 = new SqliteSessionPersistence({ dbPath });
    try {
      const ledger2 = new ManagedPaidAllowanceLedger(db2);
      const snap = await ledger2.snapshot(p);
      expect([snap.consumedUsd, snap.reservedUsd, snap.availableUsd]).toEqual([1.75, 1, 2.25]);
      // The replayed reserve is idempotent across the restart — no double count.
      const replay = await ledger2.reserve(p, input({ requestId: "open", estimatedUsd: 1 }));
      expect(replay.status).toBe("OPEN");
      expect((await ledger2.snapshot(p)).reservedUsd).toBe(1);
      const receipts = await ledger2.receipts(OWNER);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.chargedUsd).toBe(1.75);
      await expect(ledger2.reserve(p, input({ requestId: "over", estimatedUsd: 2.5 }))).rejects.toMatchObject({ code: "MANAGED_PAID_ALLOWANCE_EXHAUSTED" });
    } finally {
      await db2.close();
    }
  });

  it("isolates owners: Bob cannot read, settle, release, or spend Alice's allowance", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ManagedPaidAllowanceLedger(db);
      const alice = policy();
      await ledger.reserve(alice, input({ requestId: "alice-only" }));
      await ledger.settle(OWNER, "alice-only", 0.5, "OBSERVED");
      // Bob's snapshot sees none of Alice's consumption.
      const bob = policy({ ownerUserId: "bob" });
      const snap = await ledger.snapshot(bob);
      expect([snap.consumedUsd, snap.reservedUsd]).toEqual([0, 0]);
      expect(await ledger.receipts("bob")).toEqual([]);
      expect((await ledger.receipts(OWNER)).map((receipt) => receipt.requestId)).toEqual(["alice-only"]);
      // Bob cannot touch Alice's reservation records — owner-keyed lookups see nothing.
      await expect(ledger.settle("bob", "alice-only", 0.5, "OBSERVED")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_UNKNOWN" });
      await expect(ledger.release("bob", "alice-only")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_UNKNOWN" });
      // And a same-requestId reserve under a different policy owner lands in Bob's own space.
      await ledger.reserve(bob, input({ requestId: "alice-only", estimatedUsd: 0.25 }));
      expect((await ledger.snapshot(bob)).reservedUsd).toBe(0.25);
      expect((await ledger.snapshot(alice)).consumedUsd).toBe(0.5);
    } finally {
      await db.close();
    }
  });
});

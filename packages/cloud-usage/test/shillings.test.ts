import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteSessionPersistence } from "@codeforge/sessions";
import { createShillingEntry, ShillingLedger, summarizeShillings, type ShillingEntry } from "../src/shillings.js";

function entry(id: string, overrides: Partial<Parameters<typeof createShillingEntry>[0]> = {}): ShillingEntry {
  return createShillingEntry({
    id, userId: "alice", taskId: "task-1", role: "CODER", requestId: id,
    providerId: "groq", modelId: "free-a", sourceClass: "MANAGED_FREE",
    rawUsage: 100, rawAllowance: 1_000, rawRemaining: 900, usableRaw: 800, availableNowRaw: 500,
    conversion: { rawUnit: "TOKENS", shPerRawUnit: 1, confidence: "AUTHORITATIVE", evidenceSource: "provider-token-meter" },
    managedSpendUsd: null, userProviderSpendUsd: null, costConfidence: "UNKNOWN",
    recordedAt: "2026-09-28T00:00:00.000Z", ...overrides,
  });
}

describe("R55 Shilling ledger", () => {
  it("retains raw units and confidence, and distinguishes gross, usable and available now", () => {
    const measured = entry("one");
    expect([measured.shConsumed, measured.grossSh, measured.usableSh, measured.availableNowSh]).toEqual([100, 1_000, 800, 500]);
    expect(measured.conversion.rawUnit).toBe("TOKENS");
    const unknown = entry("two", { rawUsage: 8, conversion: { rawUnit: "REQUESTS", confidence: "UNKNOWN" } });
    expect([unknown.shConsumed, unknown.grossSh, unknown.usableSh, unknown.availableNowSh]).toEqual([null, null, null, null]);
    expect(() => entry("bad", { conversion: { rawUnit: "CREDITS", confidence: "ESTIMATED", shPerRawUnit: 3 } })).toThrow("SHILLING_CONVERSION_EVIDENCE_REQUIRED");
    expect(() => entry("bad2", { conversion: { rawUnit: "REQUESTS", confidence: "UNKNOWN", shPerRawUnit: 100 } })).toThrow("SHILLING_UNKNOWN_HAS_FACTOR");
  });

  it("does not merge user provider spend into managed spend or invent verified completion", () => {
    const free = entry("free");
    const paid = entry("paid", { sourceClass: "MANAGED_PAID", providerId: "openai", modelId: "gpt-5.6-luna", rawUsage: 200, managedSpendUsd: 0.03, costConfidence: "AUTHORITATIVE" });
    const user = entry("user", { sourceClass: "USER_API", providerId: "custom", modelId: "x", rawUsage: 50, managedSpendUsd: null, userProviderSpendUsd: 0.02, costConfidence: "OBSERVED" });
    const summary = summarizeShillings("task-1", [free, paid, user]);
    expect(summary.shConsumed).toBe(350);
    expect(summary.managedSpendUsd).toBe(0.03);
    expect(summary.userProviderSpendUsd).toBe(0.02);
    expect(summary.verifiedCompletion).toBe(false);
    expect(summary.frontierInferenceShare).toBeNull();
    const verified = summarizeShillings("task-1", [free], { authority: "FORGEVERIFY", outcome: "completed", evidenceId: "receipt-1" });
    expect(verified.verifiedCompletion).toBe(true);
    expect(verified.shillingsToVerifiedCompletion).toBe(100);
    expect(verified.verifiedWorkPerMillionSh).toBe(10_000);
    expect(() => entry("leak", { sourceClass: "USER_API", managedSpendUsd: 0.01 })).toThrow("SHILLING_MANAGED_SPEND_WRONG_SOURCE");
  });

  it("propagates unknown conversion through task and role totals", () => {
    const unknown = entry("unknown", { conversion: { rawUnit: "NEURONS", confidence: "UNKNOWN" } });
    const summary = summarizeShillings("task-1", [entry("known"), unknown]);
    expect(summary.shConsumed).toBeNull();
    expect(summary.byRole.CODER).toBeNull();
    expect(summary.bySourceClass.MANAGED_FREE).toBeNull();
  });

  it("persists immutable entries and isolates task reads by user", async () => {
    const db = new SqliteSessionPersistence();
    try {
      const ledger = new ShillingLedger(db);
      expect(await ledger.record(entry("once"))).toBe(true);
      expect(await ledger.record(entry("once"))).toBe(false);
      await expect(ledger.record(entry("once", { rawUsage: 101 }))).rejects.toThrow("SHILLING_ENTRY_CONFLICT");
      expect(await ledger.forTask("alice", "task-1")).toHaveLength(1);
      expect(await ledger.forTask("bob", "task-1")).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("never coerces a null/UNKNOWN measurement to zero — every derived field stays null", () => {
    const unmeasured = entry("unmeasured", {
      rawUsage: null, rawInputUsage: null, rawOutputUsage: null,
      rawAllowance: undefined, rawRemaining: undefined, usableRaw: undefined, availableNowRaw: undefined,
      conversion: { rawUnit: "UNKNOWN", confidence: "UNKNOWN" },
    });
    expect([unmeasured.shConsumed, unmeasured.grossSh, unmeasured.usableSh, unmeasured.availableNowSh]).toEqual([null, null, null, null]);
    // A user-owned turn without price evidence reports null spend — the task summary keeps
    // the total unknown (null), never manufacturing 0.00 out of missing evidence.
    const unpricedUser = entry("unpriced", { sourceClass: "USER_API", userProviderSpendUsd: null, costConfidence: "UNKNOWN" });
    expect(unpricedUser.userProviderSpendUsd).toBeNull();
    expect(summarizeShillings("task-1", [unpricedUser]).userProviderSpendUsd).toBeNull();
    const mixed = summarizeShillings("task-1", [unpricedUser, entry("priced", { sourceClass: "USER_API", userProviderSpendUsd: null })]);
    expect(mixed.userProviderSpendUsd).toBeNull();
    // One missing component poisons the total honestly — it stays null, not partial.
    const withSpend = summarizeShillings("task-1", [unpricedUser, entry("priced", { sourceClass: "USER_API", userProviderSpendUsd: 0.5, costConfidence: "OBSERVED" })]);
    expect(withSpend.userProviderSpendUsd).toBeNull();
  });

  it("survives restart — record() after reopening is idempotent and still detects conflicts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeforge-shillings-restart-"));
    const dbPath = join(dir, "shillings.db");
    try {
      const db1 = new SqliteSessionPersistence({ dbPath });
      const ledger1 = new ShillingLedger(db1);
      expect(await ledger1.record(entry("restart-entry"))).toBe(true);
      await db1.close();

      const db2 = new SqliteSessionPersistence({ dbPath });
      const ledger2 = new ShillingLedger(db2);
      try {
        // The same record replayed through the ledger after reopening is a no-op, and a
        // differing payload on the same id is still a hard conflict — not a duplicate row.
        expect(await ledger2.record(entry("restart-entry"))).toBe(false);
        await expect(ledger2.record(entry("restart-entry", { rawUsage: 999 }))).rejects.toThrow("SHILLING_ENTRY_CONFLICT");
        expect(await ledger2.forTask("alice", "task-1")).toHaveLength(1);
      } finally {
        await db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

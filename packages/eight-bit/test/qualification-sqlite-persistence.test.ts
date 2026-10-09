import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteSessionPersistence } from "@codeforge/sessions";
import { InMemoryQualificationPersistence, SqliteQualificationPersistence } from "../src/qualification/persistence.js";
import type { ModelQualificationReceipt } from "../src/qualification/types.js";

function receipt(modelId: string, state: ModelQualificationReceipt["qualificationState"]): ModelQualificationReceipt {
  const now = new Date().toISOString();
  return {
    suiteVersion: "R1_FREE_CLOUD_COMPACT_V1",
    providerId: "openrouter",
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_ROUTED",
    freeStatus: "verified_free",
    roleResults: {},
    startedAt: now,
    completedAt: now,
    totalLatencyMs: 1,
    qualificationState: state,
    hardFailureRoles: [],
    metadata: { compact: true, requests: 3, transient: false },
  };
}

describe("SqliteQualificationPersistence against the real session database", () => {
  it("retains the conclusive receipt across a transient retry and database restart, with both runs archived", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "r73-qualification-history-"));
    const dbPath = path.join(directory, "receipts.db");
    const qualified = receipt("reviewer:free", "QUALIFIED");
    const interrupted: ModelQualificationReceipt = { ...qualified, qualificationState: "NOT_QUALIFIED", startedAt: new Date(Date.parse(qualified.startedAt) + 1000).toISOString(), metadata: { requests: 1, transient: true } };
    let persistence = createSqliteSessionPersistence({ dbPath });
    try {
      for (const store of [new InMemoryQualificationPersistence(), new SqliteQualificationPersistence(persistence)]) {
        await store.save(qualified);
        await store.save(interrupted);
        await store.save(interrupted);
        expect(await store.load("openrouter", "reviewer:free")).toEqual(qualified);
        expect(await store.loadAll()).toEqual([qualified]);
        expect(await store.loadHistory("openrouter", "reviewer:free")).toEqual([qualified, interrupted]);
      }
      await persistence.close?.();
      persistence = createSqliteSessionPersistence({ dbPath });
      const reopened = new SqliteQualificationPersistence(persistence);
      expect(await reopened.load("openrouter", "reviewer:free")).toEqual(qualified);
      expect(await reopened.loadHistory("openrouter", "reviewer:free")).toEqual([qualified, interrupted]);
      await reopened.save({ ...interrupted, metadata: { transient: false } });
      expect((await reopened.load("openrouter", "reviewer:free"))?.qualificationState).toBe("NOT_QUALIFIED");
      expect(await reopened.loadHistory("openrouter", "reviewer:free")).toHaveLength(3);
    } finally {
      await persistence.close?.();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("archives an interrupted first probe without admitting it", async () => {
    const store = new InMemoryQualificationPersistence();
    const interrupted = { ...receipt("a:free", "NOT_QUALIFIED"), metadata: { transient: true } };
    await store.save(interrupted);
    expect(await store.load("openrouter", "a:free")).toBeNull();
    expect(await store.loadAll()).toEqual([]);
    expect(await store.loadHistory("openrouter", "a:free")).toEqual([interrupted]);
  });

  it("isolates archived evidence from mutation through active receipt reads", async () => {
    const store = new InMemoryQualificationPersistence();
    const qualified = receipt("a:free", "QUALIFIED");
    await store.save(qualified);
    const reads = [await store.load("openrouter", "a:free"), ...(await store.loadAll()), ...(await store.loadByProvider("openrouter"))];
    for (const loaded of reads) if (loaded) loaded.qualificationState = "HARD_FAILURE";
    qualified.qualificationState = "PROBATION";
    expect((await store.load("openrouter", "a:free"))?.qualificationState).toBe("QUALIFIED");
    expect((await store.loadHistory("openrouter", "a:free"))[0]?.qualificationState).toBe("QUALIFIED");
  });

  it("persists receipts across a reopen and does not fabricate a session", async () => {
    // Found by R5: receipts were bound to a non-existent "global" session, which violated the
    // work_items foreign key on the real database; the failure was swallowed and the desktop
    // re-qualified every route (spending shared free quota) on every launch.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r5-qualification-persist-"));
    const dbPath = path.join(dir, "codeforge.db");
    try {
      const first = createSqliteSessionPersistence({ dbPath });
      const store = new SqliteQualificationPersistence(first);
      await store.save(receipt("a:free", "QUALIFIED"));
      await store.save(receipt("b:free", "NOT_QUALIFIED"));
      await store.save(receipt("a:free", "PROBATION")); // upsert, not duplicate
      expect((await store.loadAll()).map((r) => `${r.modelId}=${r.qualificationState}`).sort()).toEqual(["a:free=PROBATION", "b:free=NOT_QUALIFIED"]);
      expect((await first.listSessions?.()) ?? []).toEqual([]);
      await first.close?.();

      const second = createSqliteSessionPersistence({ dbPath });
      const reopened = new SqliteQualificationPersistence(second);
      const loaded = await reopened.loadAll();
      expect(loaded.map((r) => r.modelId).sort()).toEqual(["a:free", "b:free"]);
      expect((await reopened.load("openrouter", "a:free"))?.qualificationState).toBe("PROBATION");
      expect((await reopened.loadByProvider("openrouter")).length).toBe(2);
      await second.close?.();
    } finally {
      // Windows may still hold the just-closed database briefly; the directory is disposable.
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort */ }
    }
  });
});

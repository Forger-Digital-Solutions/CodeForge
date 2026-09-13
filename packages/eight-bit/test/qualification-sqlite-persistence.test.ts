import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteSessionPersistence } from "@codeforge/sessions";
import { SqliteQualificationPersistence } from "../src/qualification/persistence.js";
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

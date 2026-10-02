import { describe, expect, it } from "vitest";
import { createSqliteSessionPersistence } from "../src/index.js";
const session = (id: string) => ({ id, title: id, status: "idle" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

describe("SQLite transaction ownership", () => {
  it("serializes independently concurrent transactions and keeps writes after rollback", async () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    try {
      const first = store.withTransaction(async (tx) => {
        await tx.upsertSession(session("rolled-back"));
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        throw new Error("fixture rollback");
      });
      const second = store.withTransaction(async (tx) => { expect(await tx.getSession("rolled-back")).toBeUndefined(); await tx.upsertSession(session("committed")); });
      const direct = store.upsertSession(session("independent-write"));
      const outcomes = await Promise.allSettled([first, second, direct]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
      expect((await store.listSessions()).map((entry) => entry.id)).toEqual(["committed", "independent-write"]);
    } finally { await store.close(); }
  });

  it("continues to reject nested transactions without deadlock and recovers its queue", async () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    try {
      await expect(store.withTransaction(async (tx) => {
        await tx.upsertSession(session("outer"));
        await store.withTransaction(async () => undefined);
      })).rejects.toThrow("does not support nesting");
      await store.withTransaction(async (tx) => tx.upsertSession(session("after-nesting")));
      expect(await store.getSession("outer")).toBeUndefined();
      expect(await store.getSession("after-nesting")).toBeDefined();
    } finally { await store.close(); }
  });
});

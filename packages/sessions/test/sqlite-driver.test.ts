import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPersistence, detectAvailableSqliteDrivers } from "../src/index.js";

const require_ = createRequire(import.meta.url);
const betterSqliteAvailable = (() => {
  try {
    require_.resolve("better-sqlite3");
    return true;
  } catch {
    return false;
  }
})();

const now = new Date().toISOString();

function seedAndVerify(p: SessionPersistence): void {
  p.upsertSession({
    id: "driver-session",
    title: "driver round trip",
    createdAt: now,
    updatedAt: now,
    status: "completed",
  });
  p.upsertTurn({
    id: "driver-turn",
    sessionId: "driver-session",
    seq: 1,
    userMessage: "survives restart",
    status: "completed",
    startedAt: now,
  });

  const session = p.getSession("driver-session");
  expect(session?.title).toBe("driver round trip");
  const turns = p.getTurns("driver-session");
  expect(turns).toHaveLength(1);
  expect(turns[0]?.userMessage).toBe("survives restart");
}

describe("sqlite driver selection", () => {
  it("detects at least one usable backend", () => {
    expect(detectAvailableSqliteDrivers().length).toBeGreaterThan(0);
  });

  it("auto-selects a durable backend and survives a fresh instance (restart)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-driver-auto-"));
    const dbPath = join(dir, "auto.db");
    try {
      const first = new SessionPersistence({ dbPath });
      const driverUsed = first.getDriver();
      expect(["node:sqlite", "better-sqlite3"]).toContain(driverUsed);
      seedAndVerify(first);
      first.close();

      // Fresh instance == application restart
      const second = new SessionPersistence({ dbPath });
      expect(second.getDriver()).toBe(driverUsed);
      expect(second.getSession("driver-session")?.title).toBe("driver round trip");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it.skipIf(!betterSqliteAvailable)("forced better-sqlite3 backend is durable across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-driver-bs3-"));
    const dbPath = join(dir, "fallback.db");
    try {
      const first = new SessionPersistence({ dbPath, driver: "better-sqlite3" });
      expect(first.getDriver()).toBe("better-sqlite3");
      seedAndVerify(first);
      first.close();

      const second = new SessionPersistence({ dbPath, driver: "better-sqlite3" });
      expect(second.getSession("driver-session")?.title).toBe("driver round trip");
      expect(second.getTurns("driver-session")[0]?.userMessage).toBe("survives restart");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

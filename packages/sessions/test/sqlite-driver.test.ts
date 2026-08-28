import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionPersistence, detectAvailableSqliteDrivers, openSqliteDatabase } from "../src/index.js";

const require_ = createRequire(import.meta.url);
const betterSqliteAvailable = (() => {
  try {
    const BS3 = require_("better-sqlite3");
    const testDb = new BS3(":memory:");
    testDb.close();
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

  it("forced better-sqlite3 backend is durable across restart in its compatible runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-driver-bs3-"));
    const dbPath = join(dir, "fallback.db");
    try {
      if (betterSqliteAvailable) {
        const first = new SessionPersistence({ dbPath, driver: "better-sqlite3" });
        expect(first.getDriver()).toBe("better-sqlite3");
        seedAndVerify(first);
        first.close();

        const second = new SessionPersistence({ dbPath, driver: "better-sqlite3" });
        expect(second.getSession("driver-session")?.title).toBe("driver round trip");
        expect(second.getTurns("driver-session")[0]?.userMessage).toBe("survives restart");
        second.close();
      } else {
        const testRoot = dirname(fileURLToPath(import.meta.url));
        const repositoryRoot = resolve(testRoot, "..", "..", "..");
        const electron = join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
        const sessionsEntry = join(repositoryRoot, "packages", "sessions", "dist", "index.js");
        expect(existsSync(electron), "Electron runtime is required for an Electron-ABI native binding").toBe(true);
        expect(existsSync(sessionsEntry), "Build @codeforge/sessions before testing an Electron-ABI binding").toBe(true);
        const result = spawnSync(electron, [join(testRoot, "sqlite-electron-runtime.mjs"), sessionsEntry, dbPath], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          windowsHide: true,
        });
        expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
        expect(result.stdout).toContain("SQLITE_ELECTRON_RUNTIME_OK");
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("executes table creation, parameter binding, transactions, and WAL mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-driver-ops-"));
    const dbPath = join(dir, "ops.db");
    try {
      const { db } = openSqliteDatabase(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE operations (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO operations (id, value) VALUES ($id, $value)");
      db.exec("BEGIN");
      insert.run({ $id: 1, $value: "committed" });
      db.exec("COMMIT");
      db.exec("BEGIN");
      insert.run({ $id: 2, $value: "rolled-back" });
      db.exec("ROLLBACK");
      const rows = db.prepare("SELECT id, value FROM operations ORDER BY id").all();
      expect(rows).toEqual([{ id: 1, value: "committed" }]);
      const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
      expect(journal.journal_mode?.toLowerCase()).toBe("wal");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("fails closed on a corrupt database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-driver-corrupt-"));
    const dbPath = join(dir, "corrupt.db");
    try {
      writeFileSync(dbPath, "this is not a sqlite database", "utf8");
      expect(() => new SessionPersistence({ dbPath })).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

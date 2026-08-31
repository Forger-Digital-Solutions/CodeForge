import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [sessionsEntry, dbPath] = process.argv.slice(2);
if (!sessionsEntry || !dbPath) throw new Error("Expected sessions entry point and database path");

const { SessionPersistence, openSqliteDatabase } = await import(pathToFileURL(sessionsEntry).href);
const now = new Date().toISOString();
const first = new SessionPersistence({ dbPath, driver: "better-sqlite3" });
first.upsertSession({
  id: "electron-driver-session",
  title: "Electron ABI round trip",
  createdAt: now,
  updatedAt: now,
  status: "completed",
});
first.close();

const second = new SessionPersistence({ dbPath, driver: "better-sqlite3" });
const session = second.getSession("electron-driver-session");
second.close();
if (session?.title !== "Electron ABI round trip") throw new Error("Electron SQLite restart round trip failed");
const { db } = openSqliteDatabase(dbPath, { driver: "better-sqlite3" });
const count = db.prepare("SELECT count(*) AS count FROM sessions").get();
const all = db.prepare("SELECT id FROM sessions ORDER BY id").all();
db.prepare("CREATE TABLE IF NOT EXISTS parameterless_probe (id INTEGER)").run();
db.close();
if (count?.count !== 1 || all.length !== 1) throw new Error("Electron SQLite parameterless statement failed");
if (!fs.existsSync(dbPath)) throw new Error("Electron SQLite database was not created");
console.log("SQLITE_ELECTRON_RUNTIME_OK");

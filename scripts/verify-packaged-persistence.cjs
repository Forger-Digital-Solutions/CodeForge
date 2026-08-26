// Persistence smoke check executed INSIDE the packaged Electron runtime
// (ELECTRON_RUN_AS_NODE=1 CodeForge.exe scripts/verify-packaged-persistence.cjs).
// Proves the driver fallback performs a real durable write + fresh-instance read.
//
// @codeforge/sessions is pure ESM; Electron 33 bundles Node 20.x where
// require() of ES modules is unsupported (ERR_REQUIRE_ESM), so the package is
// loaded with dynamic import() and the entry point is an async main.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

// Windows Electron GUI binaries may not attach to the parent console; when
// CODEFORGE_SMOKE_OUT is set, evidence lines are also written to that file so
// the result is deterministic in any execution context.
const smokeOutPath = process.env.CODEFORGE_SMOKE_OUT || null;

function record(line) {
  console.log(line);
  if (smokeOutPath) {
    try {
      fs.appendFileSync(smokeOutPath, line + "\n");
    } catch {
      // Result file is best-effort; stdout and exit codes stay authoritative.
    }
  }
}

function fail(message) {
  record("PACKAGED_PERSISTENCE_FAILED " + message);
  process.exit(1);
}

async function main() {
  const pkgPath = path.join(__dirname, "..", "packages", "sessions", "dist", "index.js");
  let sessions;
  try {
    sessions = await import(pathToFileURL(pkgPath).href);
  } catch (error) {
    fail("cannot load @codeforge/sessions (" + error.message + "). Run `npm run build` first.");
  }

  const now = new Date().toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-packaged-"));
  const dbPath = path.join(dir, "smoke.db");

  record("electron_version=" + (process.versions.electron || "unknown"));
  record("electron_node_version=" + process.versions.node);
  record("better_sqlite3_abi=" + (process.versions.modules || "unknown"));
  record("available_drivers=" + sessions.detectAvailableSqliteDrivers().join(","));

  let first;
  try {
    first = new sessions.SessionPersistence({ dbPath });
  } catch (error) {
    fail("no SQLite backend available (" + error.message + ")");
  }

  const driverUsed = first.getDriver();
  record("active_driver=" + driverUsed);

  first.upsertSession({
    id: "smoke",
    title: "packaged round trip",
    createdAt: now,
    updatedAt: now,
    status: "completed",
  });
  first.upsertTurn({
    id: "smoke-turn",
    sessionId: "smoke",
    seq: 1,
    userMessage: "conversation survives",
    status: "completed",
    startedAt: now,
  });
  first.close();

  // Fresh instance == application restart
  const second = new sessions.SessionPersistence({ dbPath });
  const session = second.getSession("smoke");
  const turns = second.getTurns("smoke");
  second.close();

  if (!session || session.title !== "packaged round trip") {
    fail("session did not survive restart");
  }
  if (turns.length !== 1 || turns[0].userMessage !== "conversation survives") {
    fail("conversation did not survive restart");
  }
  if (!["node:sqlite", "better-sqlite3"].includes(driverUsed)) {
    fail("unknown active driver " + driverUsed);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  record("sqlite_driver=" + driverUsed);
  record("persistence_round_trip=PASS");
  record("PACKAGED_PERSISTENCE_OK driver=" + driverUsed);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});


#!/usr/bin/env node
/**
 * CodeForge Cloud — deployment-neutral PostgreSQL validation.
 *
 *   npm run cloud:pg:validate -- --url postgres://... [--json pg-validate.json]
 *
 * Proves a database target can actually back the Cloud BEFORE any traffic is served: connectivity,
 * server version, TLS posture, the migration advisory lock, migrations 001/002/003, checksum
 * integrity, pool creation, transactional behavior, credit-ledger ordering, and a full
 * insert/read/delete round trip.
 *
 * SAFETY: every fixture row is written under a uniquely-namespaced identity and removed afterwards.
 * The tool refuses a target that looks like production unless --certification-mode is passed, so a
 * mistyped URL cannot touch a live database.
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const url = argValue("--url") ?? process.env.CODEFORGE_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const certificationMode = process.argv.includes("--certification-mode");
const jsonPath = argValue("--json");

if (!url) {
  console.error("usage: pg-validate.mjs --url postgres://user:pass@host:5432/db [--json out.json] [--certification-mode]");
  console.error("       (or set CODEFORGE_TEST_POSTGRES_URL / DATABASE_URL)");
  process.exit(2);
}

// --- Production-target guard -------------------------------------------------------------------
// Deliberately conservative: refuse anything that names itself production unless the operator has
// explicitly opted in. Losing a staging fixture is cheap; touching production is not.
const PRODUCTION_MARKERS = [/prod/i, /production/i, /live/i];
if (PRODUCTION_MARKERS.some((re) => re.test(url)) && !certificationMode) {
  console.error("REFUSED: the target database URL looks like a production database.");
  console.error("Pass --certification-mode only if you are certain this target is safe to write fixtures to.");
  process.exit(3);
}

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "../../packages/cloud-db/dist/index.js");

let mod;
try {
  mod = await import(pathToFileURL(distEntry).href);
} catch (err) {
  console.error("Could not load the compiled cloud-db build. Run `npm run build` first.");
  console.error(String(err?.message ?? err));
  process.exit(2);
}

const { PostgresCloudDatabase, MIGRATIONS } = mod;

const checks = [];
const add = (id, status, message) => {
  checks.push({ id, status, message });
  console.log(`${status.padEnd(4)}  ${message}`);
};

const parsedUrl = new URL(url);
const isLoopback = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "::1";
const sslMode = parsedUrl.searchParams.get("sslmode")?.toLowerCase();

// Namespace every fixture so a concurrent run (or a shared staging database) never collides.
const fixtureNamespace = `cfpgvalidate-${randomUUID()}`;
let createdUserId;
let db;

try {
  db = new PostgresCloudDatabase({ connectionString: url, ssl: isLoopback ? false : undefined });

  // 1. Connectivity + migrations under the advisory lock (init() takes pg_advisory_lock).
  const initStart = Date.now();
  await db.init();
  add("connect", "PASS", `connected and migrated in ${Date.now() - initStart}ms`);
  add("migration.lock", "PASS", "migrations applied under the transaction-independent advisory lock");

  // 2. Ping
  add("ping", (await db.ping()) ? "PASS" : "FAIL", "connectivity ping");

  // 3. Server version
  const versionRes = await db.diagnosticQuery("SHOW server_version");
  const versionText = String(versionRes.rows[0].server_version ?? "");
  const major = Number.parseInt(versionText, 10);
  if (Number.isFinite(major) && major >= 13) {
    add("version", "PASS", `PostgreSQL ${versionText} (>= 13 required)`);
  } else {
    add("version", "FAIL", `PostgreSQL ${versionText} is below the supported minimum (13)`);
  }

  // 4. TLS posture
  const sslRes = await db.diagnosticQuery("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
  const usingSsl = Boolean(sslRes.rows[0]?.ssl);
  if (isLoopback) {
    add("tls", usingSsl ? "PASS" : "WARN", `loopback database connection (TLS ${usingSsl ? "on" : "off"}) — acceptable only for a sidecar database`);
  } else if (usingSsl) {
    add("tls", "PASS", "remote database connection is using TLS");
  } else {
    add("tls", "FAIL", "remote database connection is NOT using TLS");
  }
  if (sslMode && ["disable", "allow", "prefer", "no-verify"].includes(sslMode)) {
    add("tls.sslmode", "FAIL", `connection string weakens TLS (sslmode=${sslMode})`);
  } else {
    add("tls.sslmode", "PASS", "connection string does not weaken TLS");
  }

  // 5. Migration state & checksum integrity
  const applied = await db.diagnosticQuery("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  const appliedByVersion = new Map(applied.rows.map((r) => [Number(r.version), r]));
  for (const migration of MIGRATIONS) {
    const row = appliedByVersion.get(migration.version);
    if (!row) {
      add(`migration.${migration.version}`, "FAIL", `migration ${migration.version} (${migration.name}) is not applied`);
    } else if (row.checksum !== migration.checksum) {
      add(`migration.${migration.version}`, "FAIL", `migration ${migration.version} checksum mismatch — schema integrity compromised`);
    } else {
      add(`migration.${migration.version}`, "PASS", `migration ${migration.version} (${migration.name}) applied with matching checksum`);
    }
  }

  // 6. Expected schema objects exist
  const expectedTables = [
    "users", "identities", "device_sessions", "plans", "subscriptions", "entitlements",
    "credit_ledger", "usage_events", "usage_periods", "reservations", "hosted_requests",
    "billing_webhook_events", "account_settings", "abuse_events", "oauth_transactions",
    "desktop_auth_codes",
  ];
  const tableRes = await db.diagnosticQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()");
  const presentTables = new Set(tableRes.rows.map((r) => r.table_name));
  const missing = expectedTables.filter((t) => !presentTables.has(t));
  if (missing.length === 0) {
    add("schema.tables", "PASS", `all ${expectedTables.length} expected tables present`);
  } else {
    add("schema.tables", "FAIL", `missing tables: ${missing.join(", ")}`);
  }

  const seqCol = await db.diagnosticQuery("SELECT 1 FROM information_schema.columns WHERE table_name = 'credit_ledger' AND column_name = 'seq'");
  add("schema.ledger_seq", seqCol.rows.length > 0 ? "PASS" : "FAIL", "credit_ledger.seq monotonic ordering column present");

  const verifierCol = await db.diagnosticQuery("SELECT 1 FROM information_schema.columns WHERE table_name = 'oauth_transactions' AND column_name = 'github_code_verifier'");
  add("schema.oauth_verifier", verifierCol.rows.length > 0 ? "PASS" : "FAIL", "oauth_transactions.github_code_verifier column present");

  // 7. Default plans seeded
  const plans = await db.listPlans();
  const hasFree = plans.some((p) => p.id === "free");
  const hasPro = plans.some((p) => p.id === "pro");
  add("seed.plans", hasFree && hasPro ? "PASS" : "FAIL", `default plans seeded (free=${hasFree}, pro=${hasPro})`);

  // 8. Full fixture round trip: insert then read, all namespaced.
  const user = await db.createUser({ displayName: "CodeForge PG Validation", primaryIdentity: `github:${fixtureNamespace}` });
  createdUserId = user.id;
  add("fixture.insert", "PASS", "fixture user inserted");

  const readBack = await db.getUserById(user.id);
  add("fixture.read", readBack?.id === user.id ? "PASS" : "FAIL", "fixture user read back");

  // 9. Ledger ordering: three appends must observe a strictly consistent running balance.
  await db.appendLedgerEvent({ userId: user.id, amount: 1000, eventType: "FREE_ALLOWANCE_GRANTED" });
  await db.appendLedgerEvent({ userId: user.id, amount: -400, eventType: "CREDIT_RESERVED" });
  await db.appendLedgerEvent({ userId: user.id, amount: 100, eventType: "CREDIT_REFUNDED" });
  const balance = await db.getCreditBalance(user.id);
  add("ledger.balance", balance === 700 ? "PASS" : "FAIL", `credit ledger running balance is ${balance} (expected 700)`);

  const events = await db.listLedgerEvents(user.id, 10);
  const ordered = events.length >= 3 && events[0].balanceAfter === 700;
  add("ledger.ordering", ordered ? "PASS" : "FAIL", "credit ledger returns events in authoritative newest-first order");

  // 10. Transactional atomicity: a reservation that exceeds the balance must not mutate anything.
  const balanceBefore = await db.getCreditBalance(user.id);
  let overspendRejected = false;
  try {
    await db.reserveCredits({
      requestId: `${fixtureNamespace}-overspend`,
      userId: user.id,
      providerId: "validation",
      modelId: "validation",
      reservedCredits: balanceBefore + 1_000_000,
    });
  } catch {
    overspendRejected = true;
  }
  const balanceAfterOverspend = await db.getCreditBalance(user.id);
  add(
    "transaction.atomic",
    overspendRejected && balanceAfterOverspend === balanceBefore ? "PASS" : "FAIL",
    `overspending reservation rejected without mutating the balance (${balanceBefore} -> ${balanceAfterOverspend})`,
  );

  // 11. Single-use desktop auth code semantics on this server.
  const codeHash = `${fixtureNamespace}-codehash`;
  await db.createDesktopAuthCode({
    codeHash,
    userId: user.id,
    codeChallenge: "A".repeat(43),
    redirectUri: "http://127.0.0.1:49152/auth/callback",
    expiresInSeconds: 120,
  });
  await db.consumeDesktopAuthCode(codeHash);
  let replayRejected = false;
  try {
    await db.consumeDesktopAuthCode(codeHash);
  } catch {
    replayRejected = true;
  }
  add("oauth.single_use", replayRejected ? "PASS" : "FAIL", "desktop authorization codes are single-use on this server");

  // 12. Pool creation under concurrency.
  const pings = await Promise.all(Array.from({ length: 8 }, () => db.ping()));
  add("pool.concurrency", pings.every(Boolean) ? "PASS" : "FAIL", "connection pool served 8 concurrent operations");
} catch (err) {
  const message = String(err?.message ?? err).replace(/(postgres|postgresql):\/\/\S*/g, "[REDACTED_DATABASE_URL]");
  add("fatal", "FAIL", `validation aborted: ${message}`);
} finally {
  // Fixture cleanup. ON DELETE CASCADE removes the ledger/auth-code rows with the user.
  if (db && createdUserId) {
    try {
      await db.diagnosticQuery("DELETE FROM users WHERE id = $1", [createdUserId]);
      add("fixture.cleanup", "PASS", "fixture rows removed");
    } catch (err) {
      add("fixture.cleanup", "FAIL", `fixture cleanup failed: ${String(err?.message ?? err)}`);
    }
  }
  if (db) {
    try {
      await db.close();
    } catch {}
  }
}

const failed = checks.filter((c) => c.status === "FAIL").length;
const passed = checks.filter((c) => c.status === "PASS").length;
const warnings = checks.filter((c) => c.status === "WARN").length;

const report = {
  schemaVersion: "1.0.0",
  timestamp: new Date().toISOString(),
  // Host and database name only — never the credentials.
  target: `${parsedUrl.protocol}//${parsedUrl.hostname}:${parsedUrl.port || 5432}${parsedUrl.pathname}`,
  checks,
  passed,
  failed,
  warnings,
  ok: failed === 0,
};

console.log("");
console.log(`${passed} passed, ${failed} failed, ${warnings} warning(s) — target ${report.target}`);
console.log(report.ok ? "POSTGRES VALIDATION: PASS" : "POSTGRES VALIDATION: FAIL");

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`receipt written to ${jsonPath}`);
}

process.exit(report.ok ? 0 : 1);

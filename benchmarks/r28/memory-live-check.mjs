// R28 memory/context live check — real SqliteSessionPersistence: long-session
// accumulation (hundreds of turns/events), cross-session isolation, restart
// durability across process-fresh instances, work-item idempotency, and purge.
//
//   node benchmarks/r28/memory-live-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-memory-live-"));
const dbPath = path.join(dir, "sessions.sqlite");
const now = () => new Date().toISOString();
const session = (id, title) => ({ id, title, createdAt: now(), updatedAt: now(), status: "running" });
const turn = (sessionId, seq) => ({ id: `t-${sessionId}-${seq}`, sessionId, seq, userMessage: `message ${seq} ${"x".repeat(200)}`, status: "completed", startedAt: now(), completedAt: now() });

// ---- Phase 1: long-session accumulation ----------------------------------------------
let p = createSessionPersistence({ dbPath });
await p.init();
check("driver is a real sqlite binding", ["sqlite", "node:sqlite", "better-sqlite3"].includes(p.getDriver()), p.getDriver());
await p.upsertSession(session("sess-A", "long session"));
await p.upsertSession(session("sess-B", "other session"));
for (let i = 0; i < 200; i++) await p.upsertTurn(turn("sess-A", i));
for (let i = 0; i < 500; i++) await p.appendEvent({ sessionId: "sess-A", seq: i, type: "agent.event", payload: { data: "e".repeat(120) } });
for (let i = 0; i < 5; i++) { await p.upsertTurn(turn("sess-B", i)); await p.appendEvent({ sessionId: "sess-B", seq: i, type: "agent.event" }); }

const turnsA = await p.getTurns("sess-A");
const eventsA = await p.getEvents("sess-A");
check("200 turns accumulated + retrieved in order", turnsA.length === 200 && turnsA[0].seq === 0 && turnsA[199].seq === 199, `${turnsA.length} turns`);
check("500 events accumulated", eventsA.length === 500 && eventsA[499].seq === 499, `${eventsA.length} events`);
check("session isolation: B sees only its own", (await p.getTurns("sess-B")).length === 5 && (await p.getEvents("sess-B")).length === 5, "");
check("isolation: no A content in B events", !(await p.getEvents("sess-B")).some((e) => String(e.payload?.data ?? "").includes("e".repeat(100))), "");

// ---- Phase 2: work-item idempotency ---------------------------------------------------
const wi = { kind: "steer", id: "steer-dup-1", sessionId: "sess-A", status: "queued", createdAt: now(), payload: { text: "steer once" } };
const first = await p.insertIfAbsent(wi);
const second = await p.insertIfAbsent(wi);
check("insertIfAbsent dedupes duplicate delivery", first === true && second === false, `first=${first} second=${second}`);
check("duplicate insert kept single record", (await p.getWorkItems("sess-A")).filter((w) => w.id === "steer-dup-1").length === 1, "");

// ---- Phase 3: restart durability (fresh instance, same file) --------------------------
await p.close();
p = createSessionPersistence({ dbPath });
await p.init();
const turnsAfter = await p.getTurns("sess-A");
const eventsAfter = await p.getEvents("sess-A");
check("restart: all 200 turns survive", turnsAfter.length === 200 && turnsAfter[150].userMessage.includes("message 150"), `${turnsAfter.length}`);
check("restart: all 500 events survive", eventsAfter.length === 500, `${eventsAfter.length}`);
const sessionsAfter = await p.listSessions();
check("restart: both sessions listed", sessionsAfter.length === 2 && sessionsAfter.some((s) => s.id === "sess-B"), `${sessionsAfter.length}`);
check("restart: work item survives", (await p.getWorkItem("steer-dup-1")) !== undefined, "");

// ---- Phase 4: updates + reads of nonexistent state ------------------------------------
await p.upsertSession({ ...session("sess-A", "long session"), status: "completed", outcome: "completed" });
const a = await p.getSession("sess-A");
check("session update persists", a?.status === "completed" && a?.outcome === "completed", a?.status);
check("nonexistent session → undefined not crash", (await p.getSession("does-not-exist")) === undefined, "");
check("nonexistent turn → undefined", (await p.getTurn("nope")) === undefined, "");

// ---- Phase 5: transactional compound write + purge -------------------------------------
await p.withTransaction(async (tx) => {
  await tx.upsertSession({ ...session("sess-C", "tx session"), status: "queued" });
  await tx.appendEvent({ sessionId: "sess-C", type: "tx.marker", seq: 0 });
});
check("compound tx write visible", (await p.getSession("sess-C")) !== undefined && (await p.getEvents("sess-C")).length === 1, "");
await p.withTransaction(async (tx) => { await tx.deleteEventsForSession("sess-C"); await tx.deleteSession("sess-C"); });
check("purge removes session + events", (await p.getSession("sess-C")) === undefined && (await p.getEvents("sess-C")).length === 0, "");
check("purge did not touch other sessions", (await p.getTurns("sess-A")).length === 200 && (await p.getSession("sess-B")) !== undefined, "");
await p.close();

const dbSize = fs.statSync(dbPath).size;
check("real SQLite file on disk, non-trivial", dbSize > 100_000, `${(dbSize / 1024).toFixed(0)} KiB`);

const passed = results.filter((r) => r.ok).length;
console.log(`\nMEMORY_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-MEMORY-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-memory-live-check-1",
  recordedAt: new Date().toISOString(),
  surface: "real SqliteSessionPersistence — 200-turn/500-event accumulation, session isolation, insertIfAbsent idempotency, restart durability, transactions, purge",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

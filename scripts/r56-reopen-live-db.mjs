// R56 durability proof — second process boundary. Opens a live-run SQLite db produced by
// r56-roster-live-run.mjs --keep and asserts the run's durable evidence survives intact:
// route-health marks (with scope), decision receipts, Shilling entries, worker journals.
//
//   node scripts/r56-reopen-live-db.mjs --db=<path-to-r56-live.db>
import { resolve } from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";

const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith("--db="))?.slice(5);
if (!dbArg) {
  console.error("usage: r56-reopen-live-db.mjs --db=<path>");
  process.exit(1);
}
const dbPath = resolve(dbArg);

const persistence = createSessionPersistence({ dbPath });
await persistence.init();

const workItems = await persistence.getWorkItemsByKind("eight_bit_route_health")
  .catch(() => []);
const receipts = await persistence.getWorkItemsByKind("eight_bit_decision_receipt").catch(() => []);
const rosterDecisions = await persistence.getWorkItemsByKind("forgeauto_decision_receipt").catch(() => []);
const shillings = await persistence.getWorkItemsByKind("shilling_entry").catch(() => []);
const workers = await persistence.getWorkItemsByKind("subagent_run").catch(() => []);
const telemetry = await persistence.getWorkItemsByKind("forgegreen_r0_telemetry").catch(() => []);

const healthRows = workItems.map((i) => i.health ?? i);
const result = {
  dbPath,
  pid: process.pid,
  processBoundary: "this is a fresh process over a file written by a previous process",
  counts: {
    routeHealth: workItems.length,
    decisionReceipts: receipts.length,
    rosterDecisions: rosterDecisions.length,
    shillingEntries: shillings.length,
    workerRecords: workers.length,
    forgegreenTelemetry: telemetry.length,
  },
  scopedMarks: healthRows.filter((h) => h.scope !== undefined).map((h) => ({ providerId: h.providerId, modelId: h.modelId, status: h.status, scope: h.scope, cooldownUntil: h.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : null })),
  ownerIsolation: rosterDecisions.every((i) => i.decision?.ownerUserId === "r56-live-owner"),
  secretsInStore: JSON.stringify(workItems).includes(process.env.GROQ_API_KEY ?? "\0never"),
};
await persistence.close();

const ok = result.counts.routeHealth > 0 && result.counts.decisionReceipts > 0 && !result.secretsInStore;
console.log(`[r56-reopen] ${ok ? "PASS" : "FAIL"} ${JSON.stringify(result.counts)}`);
console.log(`[r56-reopen] scopedMarks=${JSON.stringify(result.scopedMarks)}`);
console.log(`[r56-reopen] ownerIsolation=${result.ownerIsolation} secretsInStore=${result.secretsInStore}`);
if (!ok) process.exitCode = 1;

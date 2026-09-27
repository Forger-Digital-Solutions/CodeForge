// R48 E3 live 16-Bit mission: `paid-auto/auto` + roleRouting resolves each role's canonical
// through selectRoleRoute against the real measured R47 per-role verdicts, spends only through
// the BudgetGatedProviderAdapter + durable campaign ledger, and proves:
//
//   A) live role selection + dispatch for a qualified role (Coder), with route provenance;
//   B) reviewer physical-pool independence — the reviewer prefers a route different from the
//      implementer's served route;
//   C) honest denial for a role with no qualified route (Explorer — all four canonicals
//      measured NOT_QUALIFIED in R47), with ZERO spend and no free-fleet substitution.
//
//   CODEFORGE_16BIT_CAMPAIGN=1 node scripts/r48-paid-mission.mjs [--cap 0.25] [--keep]
//
// The campaign gate is mandatory: without it the script exits before constructing any route.
// Credentials are checked by presence only; values are never printed or persisted.
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createOpenRouterAdapter, InMemoryProviderCatalog } from "../packages/providers/dist/index.js";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import { EventStore, createSessionPersistence } from "../packages/sessions/dist/index.js";
import {
  BudgetGatedProviderAdapter,
  DurablePaidEvaluationBudgetLedger,
  createPaidAutoService,
  PAID_AUTO_MODELS,
} from "../packages/paid-auto/dist/index.js";
import { createAgentRuntime } from "../packages/server/dist/agent-runtime.js";
import { createWorkspaceEventAdapter } from "../packages/server/dist/workspace-event-adapter.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const CAP = opt("cap", "0.25");
const keep = args.includes("--keep");
const R47_DIR = path.resolve("docs/evidence/r47-16bit");
const EVIDENCE_DIR = path.resolve("docs/evidence/r48-role-routing");
const CAMPAIGN_DB = process.env.R48_PAID_DB ?? path.join(os.tmpdir(), "r48-16bit-ledger.db");
const CAMPAIGN_ID = "r48-16bit";
const SESSION_ID = "r48-16bit-campaign";

if (process.env.CODEFORGE_16BIT_CAMPAIGN !== "1") {
  console.error("fail-closed: CODEFORGE_16BIT_CAMPAIGN=1 is required for any 16-Bit spend");
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY?.trim()) {
  console.error("fail-closed: OPENROUTER_API_KEY is required — every executable route is the OpenRouter fallback");
  process.exit(1);
}

// Measured per-role verdicts from the R47 live qualification campaign — production routing
// evidence, not assumed competence. Absent roles for a model stay honestly NOT_TESTED.
const roleVerdicts = [];
for (const model of PAID_AUTO_MODELS) {
  const file = path.join(R47_DIR, `R47-16BIT-QUALIFY-${model.canonicalModelId}.json`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`fail-closed: missing measured qualification evidence ${file}`);
    process.exit(1);
  }
  for (const [role, rr] of Object.entries(doc.result?.roleResults ?? {})) {
    if (rr.status === "NOT_TESTED") continue;
    roleVerdicts.push({ canonicalModelId: model.canonicalModelId, role, status: rr.status, measuredAt: doc.generatedAt, source: "r47-qualify" });
  }
}
console.log(`[r48-paid] seeded ${roleVerdicts.length} measured role verdicts`);

const pricing = JSON.parse(readFileSync(path.join(R47_DIR, "R47-16BIT-PRICING.json"), "utf8"));
const priceCards = pricing.priceCards.filter((c) => c.providerId === "openrouter");
if (priceCards.length !== PAID_AUTO_MODELS.length) {
  console.error(`fail-closed: need ${PAID_AUTO_MODELS.length} OpenRouter price cards, found ${priceCards.length}`);
  process.exit(1);
}

// Only the measured OpenRouter fallbacks execute. Every direct route stays NOT_CONFIGURED so
// all spend is priced, ledger-gated, and capped — bounded even if other paid keys exist.
const routeQualifications = Object.fromEntries(
  PAID_AUTO_MODELS.flatMap((model) => [
    [model.direct.routeId, { state: "NOT_CONFIGURED" }],
    [model.fallback.routeId, { state: "READY", commercialEligibility: "verified", privacy: "verified", capabilityParity: "verified", certification: "CERTIFIED" }],
  ]),
);

const campaignPersistence = createSessionPersistence({ dbPath: CAMPAIGN_DB });
await campaignPersistence.init();
await campaignPersistence.upsertSession({ id: SESSION_ID, title: "R48 16-Bit role routing", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
const ledger = new DurablePaidEvaluationBudgetLedger(campaignPersistence, { campaignId: CAMPAIGN_ID, sessionId: SESSION_ID, authorizedUsd: CAP });
const receipts = [];
const upstream = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
const gated = new BudgetGatedProviderAdapter(upstream, { ledger, priceCards, onReceipt: (r) => receipts.push(r) });
const telemetry = [];
const paidAuto = createPaidAutoService({
  adapters: { openrouter: gated },
  paidExecutionEnabled: true,
  openRouterFallbackEnabled: true,
  routeQualifications,
  roleVerdicts,
  onTelemetry: (record) => telemetry.push(record),
});

const catalog = new InMemoryProviderCatalog();
catalog.register(paidAuto.asProviderAdapter());

// Workspace: same shape as the R47 mission — stubbed module + focused real test.
const repoDir = mkdtempSync(path.join(os.tmpdir(), "r48-paid-repo-"));
execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
execFileSync("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "r48-math-lib", version: "1.0.0", type: "module" }));
writeFileSync(path.join(repoDir, "math.mjs"), "export function multiply(a, b) { return 0; }\n");
mkdirSync(path.join(repoDir, "test"));
writeFileSync(path.join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n");
execFileSync("git", ["add", "."], { cwd: repoDir });
execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

const persistence = createSessionPersistence();
await persistence.init();
const eventStore = new EventStore();
const runtime = createAgentRuntime({
  sessionId: "r48-16bit-mission",
  eventStore,
  persistence,
  firewall: new ForgeZero(),
  providerCatalog: catalog,
  workspacePath: repoDir,
  paidAuto,
});
runtime.setModelSelection({ providerId: "paid-auto", modelId: "auto" });
const adapter = createWorkspaceEventAdapter({ sessionId: "r48-16bit-mission", eventStore, persistence });
const run = (id, role, goal, extra = {}) =>
  runtime.executeAgentRun({
    runId: id, agentId: `agent-${id}`, role, goal,
    workspaceId: `ws-${id}`, workspacePath: repoDir,
    permissions: { read: true, search: true, write: true, executeCommand: false, network: false },
    executionBudget: { maxModelTurns: 14 },
    modelSelection: { providerId: "paid-auto", modelId: "auto" },
    roleRouting: true,
    adapter,
    ...extra,
  });

const startedAt = new Date().toISOString();
const phases = [];

// Phase C first — the denial costs nothing and proves the floor with real evidence.
const explorer = await run("r48-explorer", "explorer", "Map the repository and report which files implement the math helpers.", { permissions: { read: true, search: true, write: false, executeCommand: false, network: false } });
phases.push({ phase: "explorer-denial", role: "explorer", status: explorer.status, summary: explorer.summary, routePoolId: explorer.routePoolId ?? null });
console.log(`[r48-paid] explorer: ${explorer.status} — ${String(explorer.summary).slice(0, 160)}`);

// Phase A — a qualified role selects and serves through a real paid route.
const coder = await run("r48-coder", "coder", "Implement multiply(a,b) in math.mjs so `node --test test/math.test.mjs` passes. Read the file first, then edit it.");
phases.push({ phase: "coder-selection", role: "coder", status: coder.status, summary: coder.summary, routePoolId: coder.routePoolId ?? null, filesChanged: coder.filesChanged ?? [] });
console.log(`[r48-paid] coder: ${coder.status} pool=${coder.routePoolId ?? "-"}`);

// Phase B — reviewer must prefer a physically different paid route from the implementer's.
let reviewer = null;
if (coder.status === "completed" && coder.routePoolId) {
  reviewer = await run("r48-reviewer", "reviewer", "Review math.mjs: verify multiply is correct and has no regressions. Report PASS or FAIL with reasons.", { preferIndependentFromPoolId: coder.routePoolId });
  phases.push({ phase: "reviewer-independence", role: "reviewer", status: reviewer.status, summary: reviewer.summary, routePoolId: reviewer.routePoolId ?? null, implementerPool: coder.routePoolId });
  console.log(`[r48-paid] reviewer: ${reviewer.status} pool=${reviewer.routePoolId ?? "-"} (implementer=${coder.routePoolId})`);
}

const snapshot = await ledger.snapshot();
const routerEvents = eventStore.getAll()
  .filter((e) => e.type === "router.selection" || e.type === "router.failover")
  .map((e) => ({ type: e.type, payload: e.payload }));
const journals = (await persistence.getWorkItemsByKind("agent_run_journal")).map((item) => ({
  runId: item.runId, role: item.role, state: item.state, route: item.route ?? null,
}));

const evidence = {
  schemaVersion: 1,
  round: "R48-E3",
  generatedAt: new Date().toISOString(),
  startedAt,
  purpose: "Live paid-auto/auto per-role routing: measured verdict floor, OR-fallback execution only, ledger-capped spend, reviewer independence, honest Explorer denial.",
  campaignId: CAMPAIGN_ID,
  capUsd: CAP,
  roleVerdictsSeeded: roleVerdicts.map((v) => `${v.canonicalModelId}:${v.role}=${v.status}`),
  executableRoutes: Object.entries(routeQualifications).filter(([, q]) => q.state === "READY").map(([id]) => id),
  phases,
  budget: snapshot,
  receipts: receipts.map((r) => ({ routeId: r.routeId ?? null, modelId: r.modelId ?? r.servedModelId ?? null, servedModelId: r.servedModelId ?? null, costUsd: r.costUsd ?? r.amountUsd ?? null })),
  telemetry,
  routerEvents,
  journals,
  mathFile: readFileSync(path.join(repoDir, "math.mjs"), "utf8"),
};
mkdirSync(EVIDENCE_DIR, { recursive: true });
const file = path.join(EVIDENCE_DIR, "R48-16BIT-ROLE-MISSION.json");
writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[r48-paid] committed=$${snapshot.committedUsd} receipts=${receipts.length} evidence=${file}`);
if (!keep) rmSync(repoDir, { recursive: true, force: true });
await persistence.close();
await campaignPersistence.close();
if (explorer.status === "completed") {
  console.error("[r48-paid] WARNING: explorer run completed despite every canonical measuring NOT_QUALIFIED for EXPLORER — the role floor did not hold");
  process.exitCode = 1;
}
if (coder.status === "completed" && coder.routePoolId && reviewer && reviewer.routePoolId === coder.routePoolId) {
  console.error("[r48-paid] WARNING: reviewer served on the implementer's route — independence preference did not hold");
  process.exitCode = 1;
}

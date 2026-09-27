#!/usr/bin/env node
// R47 Phase B: first live 16-Bit mission. Runs the full Explorer -> Planner -> Coder ->
// Reviewer -> Verification -> Integration pipeline through AgentRuntime pinned to one
// canonical paid model. Every provider call flows through PaidAutoService -> the route's
// BudgetGatedProviderAdapter -> the durable campaign ledger: no reservation, no dispatch.
//
//   CODEFORGE_16BIT_CAMPAIGN=1 node scripts/r47-16bit-mission.mjs --model glm-5.3-flash [--cap 0.50]
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createOpenRouterAdapter, InMemoryProviderCatalog } from "../packages/providers/dist/index.js";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import { EventStore, createSessionPersistence } from "../packages/sessions/dist/index.js";
import {
  BudgetGatedProviderAdapter,
  DurablePaidEvaluationBudgetLedger,
  createPaidAutoService,
  paidAutoModel,
} from "../packages/paid-auto/dist/index.js";
import { createAgentRuntime } from "../packages/server/dist/agent-runtime.js";
import { createAutonomousRunOrchestrator } from "../packages/server/dist/autonomous-orchestrator.js";
import { createWorkspaceService } from "../packages/server/dist/workspace-service.js";
import { createSubagentManager } from "../packages/server/dist/subagent-manager.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL_ID = opt("model", "glm-5.3-flash");
const CAP = opt("cap", "0.50");
const EVIDENCE_DIR = path.resolve("docs/evidence/r47-16bit");
const CAMPAIGN_DB = process.env.R47_PAID_DB ?? path.join(os.tmpdir(), "r47-16bit-ledger.db");
const CAMPAIGN_ID = "r47-16bit";
const SESSION_ID = "r47-16bit-campaign";

if (process.env.CODEFORGE_16BIT_CAMPAIGN !== "1") {
  console.error("fail-closed: CODEFORGE_16BIT_CAMPAIGN=1 is required for any 16-Bit spend");
  process.exit(1);
}
const model = paidAutoModel(MODEL_ID);
if (!model) {
  console.error(`unknown canonical model ${MODEL_ID}`);
  process.exit(1);
}
const route = model.fallback;
const pricing = JSON.parse(readFileSync(path.join(EVIDENCE_DIR, "R47-16BIT-PRICING.json"), "utf8"));
const priceCards = pricing.priceCards.filter(
  (c) => c.canonicalModelId === route.canonicalModelId && c.providerId === route.providerId && c.providerModelId === route.providerModelId,
);
if (priceCards.length !== 1) {
  console.error(`fail-closed: need exactly one exact PriceCard for ${route.providerModelId}, found ${priceCards.length}`);
  process.exit(1);
}

// Mission workspace: a real git repo with a stubbed module and a real verification command.
const repoDir = mkdtempSync(path.join(os.tmpdir(), "r47-16bit-repo-"));
const worktreeBase = mkdtempSync(path.join(os.tmpdir(), "r47-16bit-worktrees-"));
execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
execFileSync("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "r47-math-lib", version: "1.0.0", type: "module" }));
writeFileSync(path.join(repoDir, "math.mjs"), "export function multiply(a, b) { return 0; }\nexport function power(a, b) { return 0; }\n");
mkdirSync(path.join(repoDir, "test"));
writeFileSync(path.join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply, power } from '../math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\ntest('power', () => assert.equal(power(2, 8), 256));\n");
execFileSync("git", ["add", "."], { cwd: repoDir });
execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

const campaignPersistence = createSessionPersistence({ dbPath: CAMPAIGN_DB });
await campaignPersistence.init();
await campaignPersistence.upsertSession({ id: SESSION_ID, title: "R47 16-Bit campaign", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
const ledger = new DurablePaidEvaluationBudgetLedger(campaignPersistence, { campaignId: CAMPAIGN_ID, sessionId: SESSION_ID, authorizedUsd: CAP });
const receipts = [];
const upstream = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
const gated = new BudgetGatedProviderAdapter(upstream, { ledger, priceCards, onReceipt: (r) => receipts.push(r) });

const routeQualifications = Object.fromEntries(
  [model.direct, model.fallback].map((r) => [r.routeId, r.kind === "direct"
    ? { state: "NOT_CONFIGURED" }
    : { state: "READY", commercialEligibility: "verified", privacy: "verified", capabilityParity: "verified", certification: "CERTIFIED" }]),
);
const telemetry = [];
const paidAuto = createPaidAutoService({
  adapters: { openrouter: gated },
  paidExecutionEnabled: true,
  openRouterFallbackEnabled: true,
  routeQualifications,
  onTelemetry: (record) => telemetry.push(record),
});

const catalog = new InMemoryProviderCatalog();
catalog.register(paidAuto.asProviderAdapter());

const persistence = createSessionPersistence();
await persistence.init();
const eventStore = new EventStore();
const firewall = new ForgeZero();
const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBase });
const runtime = createAgentRuntime({
  sessionId: "r47-16bit-mission",
  eventStore,
  persistence,
  firewall,
  providerCatalog: catalog,
  workspacePath: repoDir,
  paidAuto,
});
runtime.setModelSelection({ providerId: "paid-auto", modelId: MODEL_ID, canonicalModelId: MODEL_ID, lock: "route" });
const subagentManager = createSubagentManager({ persistence, workspaceService, agentRuntime: runtime });
const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, subagentManager, agentRuntime: runtime });

console.log(`mission start: ${MODEL_ID} via ${route.routeId} | cap $${CAP} | repo ${repoDir}`);
const startedAt = Date.now();
let result;
let runError;
try {
  result = await orchestrator.startRun({
    sessionId: "r47-16bit-mission",
    workspacePath: repoDir,
    goal: "Implement multiply(a,b) and power(a,b) in math.mjs so the focused test file passes.",
    verificationCommands: ["node --test test/math.test.mjs"],
  });
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
}
const durationMs = Date.now() - startedAt;

const snapshot = await ledger.snapshot();
const evidence = {
  generatedAt: new Date().toISOString(),
  campaignId: CAMPAIGN_ID,
  model: MODEL_ID,
  route: route.routeId,
  goal: "Implement multiply(a,b) and power(a,b) in math.mjs so the focused test file passes.",
  verificationCommands: ["node --test test/math.test.mjs"],
  durationMs,
  status: result?.status ?? "error",
  runError,
  summary: result?.summary,
  changedFiles: result?.changedFiles,
  verification: result?.verification,
  review: result?.review,
  integration: result?.integration,
  counters: result?.counters,
  evidenceKinds: result?.evidence?.map((e) => e.kind ?? e),
  budget: snapshot,
  receipts,
  telemetry,
};
mkdirSync(EVIDENCE_DIR, { recursive: true });
const file = path.join(EVIDENCE_DIR, `R47-16BIT-MISSION-${MODEL_ID}.json`);
writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(`status=${evidence.status} duration=${(durationMs / 1000).toFixed(0)}s committed=${snapshot.committedUsd} receipts=${receipts.length}`);
console.log(`evidence: ${file}`);
const math = readFileSync(path.join(repoDir, "math.mjs"), "utf8");
console.log("--- math.mjs ---\n" + math);
await persistence.close();
await campaignPersistence.close();

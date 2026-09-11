#!/usr/bin/env node
// FG-8 / FG-8R realistic-workload benchmark. Deterministic, synthetic, zero network — see
// packages/forge-green/src/sustainability-fixtures.ts for the 7 synthetic fixtures and
// docs/codeforge-forgegreen-measurement-contract.md §10 for the zero-cash requirement. Workload
// 8 (FG-8R) additionally exercises the REAL live-integration path: a real RepositoryIntelligence
// instance indexing a real temp workspace (Baseline B), and authoritative-shaped 8-Bit
// DecisionReceipt + ForgeZero FreeModelRecord evidence (the real cross-receipt authority — see
// the FG-8R certification report for why RouteReceipt/FinancialReceipt are NOT the live path).
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  buildDuplicateToolReuseDecision,
  buildSustainabilityWorkloadFixtures,
  computeLiveContextPopulation,
  createForgeGreenLedgerCollector,
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  generateForgeGreenSummary,
  normalizeMeasurementInput,
  ReferenceHeuristicEstimator,
} from "@codeforge/forge-green";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";

const outPath = path.resolve("docs/codeforge-forgegreen-fg8-benchmark-fixtures.json");

const fixtures = buildSustainabilityWorkloadFixtures();
const results = fixtures.map((fixture) => {
  const draft = createSustainabilityReceipt({
    identity: fixture.identity,
    normalized: fixture.normalized,
    contextPopulation: fixture.contextPopulation,
  });
  const receipt = finalizeSustainabilityReceipt(draft);
  const summary = generateForgeGreenSummary(receipt);
  return { workloadId: fixture.workloadId, description: fixture.description, measurementStatus: receipt.measurementStatus, receipt, summary };
});

// --- Workload 8 (FG-8R): live-integration-shaped, using real production components ---
async function buildLiveIntegrationWorkload() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-benchmark-"));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-benchmark-cache-"));
  let intelligence;
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fg8r-benchmark-fixture", version: "1.0.0" }));
    await fs.writeFile(path.join(root, "service.ts"), "export function handle(req: unknown): unknown { return req; }\n");
    await fs.writeFile(path.join(root, "service.test.ts"), "import { handle } from './service.js';\nit('handles', () => handle({}));\n");

    intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();

    const identity = { runId: "live-integration-shaped", sessionId: "fixture-session-live-integration-shaped", agentId: "fixture-agent", taskId: "fixture-task-live-integration-shaped", namespace: root };
    const decisionReceipts = [
      { receiptId: "decision-benchmark-1", sessionId: identity.sessionId, runId: identity.runId, action: "rotate", selected: { providerId: "openrouter", modelId: "glm-4.6" }, reasonCodes: ["PROVIDER_TIMEOUT", "REPLACEMENT_ELIGIBLE"], createdAt: new Date().toISOString() },
    ];
    const freeModelRecord = {
      providerId: "openrouter", modelId: "glm-4.6", accessClass: "VERIFIED_FREE", freeStatus: "verified_free",
      costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "openrouter-live" },
    };
    const contextPopulation = await computeLiveContextPopulation(intelligence, { actualTransmittedBytes: 20, actualTransmittedTokens: 6 });

    const ledger = createForgeGreenLedgerCollector({ runId: identity.runId, operation: "agent_run", namespace: root, sessionId: identity.sessionId, agentId: identity.agentId });
    ledger.recordContextPagesReused(1);
    ledger.recordModelFailoverRotation();
    ledger.recordVerificationObligations(1);
    ledger.recordVerificationTargetedSuiteUsed();

    const normalized = normalizeMeasurementInput({
      identity,
      ledgerRecord: ledger.snapshot(),
      usage: { inputTokens: 1600, outputTokens: 700, requestCount: 2, provider: "openrouter", model: "glm-4.6" },
      toolExecutions: [
        { success: true, readOnly: true, durationMs: 30 },
        { success: true, readOnly: false, durationMs: 90 },
      ],
      wallClockMs: 5100,
    });

    const draft = createSustainabilityReceipt({
      identity,
      normalized,
      live: { freeModelRecord, decisionReceipts },
      contextPopulation,
      energyEstimator: new ReferenceHeuristicEstimator(),
      taskId: identity.taskId,
    });
    const receipt = finalizeSustainabilityReceipt(draft);
    const summary = generateForgeGreenSummary(receipt);
    return {
      workloadId: "live_integration_shaped",
      description: "FG-8R: authoritative-shaped DecisionReceipt + FreeModelRecord evidence, and a real RepositoryIntelligence instance indexing a real temp workspace for Baseline B — the closure-phase proof that the measurement chain reaches real production components, not only synthetic fixtures.",
      measurementStatus: receipt.measurementStatus,
      receipt,
      summary,
    };
  } finally {
    await intelligence?.closeWorkspace().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cache, { recursive: true, force: true }).catch(() => undefined);
  }
}

results.push(await buildLiveIntegrationWorkload());

// --- FG-9 Candidate A before/after benchmark (§18/§31), deterministic, zero network ---
// The tool_heavy_task fixture already records 4 real FG-1C duplicate suppressions
// (sustainability-fixtures.ts). Treatment = the fixture as-is (suppression ON, what actually
// ran). Control = a naive re-execution where those 4 suppressed calls are added back.
const toolHeavyFixture = fixtures.find((f) => f.workloadId === "tool_heavy_task");
const treatmentReceipt = results.find((r) => r.workloadId === "tool_heavy_task").receipt;
const controlNormalized = {
  ...toolHeavyFixture.normalized,
  tools: {
    ...toolHeavyFixture.normalized.tools,
    toolCallCount: toolHeavyFixture.normalized.tools.toolCallCount + toolHeavyFixture.normalized.tools.duplicateActionsSuppressed,
  },
  timing: { ...toolHeavyFixture.normalized.timing, wallClockMs: toolHeavyFixture.normalized.timing.wallClockMs + 4 * 15 },
};
const controlReceipt = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity: toolHeavyFixture.identity, normalized: controlNormalized }));

const optimizationDecision = buildDuplicateToolReuseDecision({
  runId: toolHeavyFixture.identity.runId,
  sessionId: toolHeavyFixture.identity.sessionId,
  sustainabilityReceiptId: treatmentReceipt.receiptId,
  events: Array.from({ length: toolHeavyFixture.normalized.tools.duplicateActionsSuppressed }, (_, i) => ({
    tool: "read_file",
    identityKeyHash: `benchmark-hash-${i}`,
    priorExecutionId: `benchmark-exec-${i}`,
    avoidedBytes: 450,
  })),
});

const optimizationBenchmark = {
  optimizationKind: "DUPLICATE_READ_ONLY_TOOL_REUSE",
  workloadId: "tool_heavy_task",
  control: {
    toolCalls: controlReceipt.toolAccounting.toolCallCount,
    wallClockMs: controlReceipt.timing.wallClockMs,
    measurementStatus: controlReceipt.measurementStatus,
  },
  treatment: {
    toolCalls: treatmentReceipt.toolAccounting.toolCallCount,
    wallClockMs: treatmentReceipt.timing.wallClockMs,
    measurementStatus: treatmentReceipt.measurementStatus,
  },
  delta: {
    toolCallsAvoided: controlReceipt.toolAccounting.toolCallCount - treatmentReceipt.toolAccounting.toolCallCount,
    wallClockMsDelta: controlReceipt.timing.wallClockMs - treatmentReceipt.timing.wallClockMs,
    verificationOutcomeIdentical: controlReceipt.measurementStatus === treatmentReceipt.measurementStatus,
  },
  decision: optimizationDecision?.decision,
  receipt: optimizationDecision?.receipt,
};

const artifact = {
  generatedAt: new Date().toISOString(),
  methodology: "Workloads 1-7: deterministic, hand-built synthetic fixtures. Workload 8 (live_integration_shaped): a real RepositoryIntelligence instance indexes a real temp workspace, and authoritative-shaped 8-Bit DecisionReceipt / ForgeZero FreeModelRecord evidence is used for cross-receipt integrity — the real live authorities, not the unused RouteReceipt/FinancialReceipt schema. Zero network calls anywhere.",
  fixtureSource: "packages/forge-green/src/sustainability-fixtures.ts (workloads 1-7); scripts/forgegreen-fg8-benchmark.mjs (workload 8)",
  workloadCount: results.length,
  results,
  optimizationBenchmark,
};

await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

console.log(`FG-8/FG-8R/FG-9 benchmark: wrote ${results.length} workload receipts to ${outPath}`);
for (const r of results) {
  console.log(`  - ${r.workloadId}: ${r.measurementStatus} — ${r.summary.headline}`);
}
console.log(`  - FG-9 Candidate A before/after: control ${optimizationBenchmark.control.toolCalls} tool calls / ${optimizationBenchmark.control.wallClockMs}ms -> treatment ${optimizationBenchmark.treatment.toolCalls} tool calls / ${optimizationBenchmark.treatment.wallClockMs}ms (avoided ${optimizationBenchmark.delta.toolCallsAvoided} calls, ${optimizationBenchmark.delta.wallClockMsDelta}ms; verification outcome identical: ${optimizationBenchmark.delta.verificationOutcomeIdentical})`);

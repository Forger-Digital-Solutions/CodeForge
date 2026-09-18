import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import {
  comparePromptCacheExperiment,
} from "@codeforge/forge-green";
import { createAgentRuntime } from "@codeforge/server";

// This deterministic, offline harness owns its scripted adapter. Keep the opt-in process-local so
// ForgeZero's production provider isolation remains the default everywhere else.
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "tests", "evidence", "forgegreen-r0");
const providerId = "forgegreen-r0-scripted";
const modelId = "forgegreen-r0-free";
const repositoryRevision = "2673f1374fa4d3d623bca187b4068128ce0a9e9c";
const verificationPolicyRevision = "forgegreen-r0-measurement-1";

class ScriptedFreeProvider {
  providerId = providerId;
  isTestProvider = true;
  requests = [];

  constructor(responses) {
    this.responses = responses;
  }

  async listModels() {
    return [{
      modelId,
      displayName: "ForgeGreen R0 scripted free model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat() {
    throw new Error("The R0 harness uses streamChat only.");
  }

  async *streamChat(request, signal) {
    this.requests.push(request);
    const response = this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
    if (!response) {
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    for (const event of response) {
      if (signal?.aborted) return;
      yield event;
    }
  }

  async healthCheck() {
    return { status: "available" };
  }
}

function toolTurn(id, name, args, cachedInputTokens) {
  return [
    { type: "tool_call_started", toolCallId: id, toolName: name },
    { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) },
    { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 20, ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) } },
    { type: "finish", finishReason: "tool_calls" },
  ];
}

function finalTurn(text, cachedInputTokens) {
  return [
    { type: "text_delta", delta: text },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 20, ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) } },
    { type: "finish", finishReason: "stop" },
  ];
}

function duplicateResponses() {
  return [
    toolTurn("r0-1", "read_file", { path: "index.ts" }),
    toolTurn("r0-2", "list_files", { path: "." }),
    toolTurn("r0-3", "repo_search", { query: "forgegreen", limit: 5 }),
    toolTurn("r0-4", "read_file", { path: "index.ts" }),
    toolTurn("r0-5", "list_files", { path: "." }),
    toolTurn("r0-6", "read_file", { path: "index.ts" }),
    finalTurn("unreachable"),
  ];
}

async function readTelemetry(persistence, runId) {
  const items = await persistence.getWorkItemsByKind("forgegreen_r0_telemetry");
  const item = items.find((candidate) => candidate.runId === runId);
  if (!item) throw new Error(`R0 telemetry was not persisted for ${runId}`);
  return item.record;
}

async function runWorkload({ persistence, eventStore, workspacePath, sessionId, runId, responses, goal, cacheMode }) {
  const provider = new ScriptedFreeProvider(responses);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId, modelId }));
  const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath });
  const result = await runtime.executeAgentRun({
    runId,
    agentId: "explorer",
    role: "explorer",
    goal,
    workspaceId: "forgegreen-r0-local-workspace",
    workspacePath,
    repositoryRevision,
    modelSelection: { providerId, modelId },
    permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
  });
  const telemetry = await readTelemetry(persistence, runId);
  return { cacheMode, result, telemetry, providerRequestCount: provider.requests.length };
}

function metricValue(metric) {
  return metric?.source === "UNKNOWN" ? undefined : metric?.value;
}

function experimentSample(run) {
  return {
    workloadId: "r0-prompt-cache-replay-read-file-v1",
    providerId,
    modelId,
    routeClass: run.telemetry.routeClass.value,
    toolsetRevision: "agent-runtime-default-tools-v1",
    securityPolicyRevision: "agent-read-only-permissions-v1",
    repositoryRevision,
    verificationPolicyRevision,
    totalInputTokens: metricValue(run.telemetry.model.inputTokens),
    cachedInputTokens: metricValue(run.telemetry.model.cachedInputTokens),
    outputTokens: metricValue(run.telemetry.model.outputTokens),
    wallTimeMs: metricValue(run.telemetry.wallTimeMs),
    providerAttempts: metricValue(run.telemetry.model.providerAttempts),
    retryCount: metricValue(run.telemetry.retries.retryCount),
    forgeGreenOverheadMs: metricValue(run.telemetry.forgeGreenOverheadMs),
    forgeVerifyStatus: run.telemetry.forgeVerify,
    completionGateStatus: run.telemetry.completionGate,
    taskCompletionStatus: run.telemetry.taskCompletionStatus.value ?? "UNKNOWN",
  };
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "forgegreen-r0-workload-"));
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  const eventStore = new EventStore();

  try {
    await fs.writeFile(path.join(workspacePath, "index.ts"), "export const codeforge = 'forgegreen-r0';\n", "utf8");
    const repetitive = Array.from({ length: 240 }, (_, index) => `PASS fixture ${index % 4} completed without anomalies`).join("\n");
    await fs.writeFile(path.join(workspacePath, "large.log"), `${repetitive}\n`, "utf8");

    const workloads = [];
    workloads.push(await runWorkload({
      persistence,
      eventStore,
      workspacePath,
      sessionId: "forgegreen-r0-session-read",
      runId: "forgegreen-r0-run-read",
      responses: [toolTurn("read-1", "read_file", { path: "index.ts" }), finalTurn("read complete")],
      goal: "Read one source file and summarize it.",
      cacheMode: "control-no-cache-metadata",
    }));
    workloads.push(await runWorkload({
      persistence,
      eventStore,
      workspacePath,
      sessionId: "forgegreen-r0-session-large",
      runId: "forgegreen-r0-run-large",
      responses: [toolTurn("large-1", "read_file", { path: "large.log" }), finalTurn("large log read")],
      goal: "Read the local log and summarize it.",
      cacheMode: "control-no-cache-metadata",
    }));
    workloads.push(await runWorkload({
      persistence,
      eventStore,
      workspacePath,
      sessionId: "forgegreen-r0-session-duplicate",
      runId: "forgegreen-r0-run-duplicate",
      responses: duplicateResponses(),
      goal: "Inspect the repository without repeating unchanged discovery.",
      cacheMode: "control-no-cache-metadata",
    }));

    const control = await runWorkload({
      persistence,
      eventStore,
      workspacePath,
      sessionId: "forgegreen-r0-session-cache-control",
      runId: "forgegreen-r0-run-cache-control",
      responses: [toolTurn("cache-control-1", "read_file", { path: "index.ts" }), finalTurn("read complete")],
      goal: "Read one source file for the prompt-cache control replay.",
      cacheMode: "control-no-cache-metadata",
    });
    const experiment = await runWorkload({
      persistence,
      eventStore,
      workspacePath,
      sessionId: "forgegreen-r0-session-cache-experiment",
      runId: "forgegreen-r0-run-cache-experiment",
      responses: [toolTurn("cache-experiment-1", "read_file", { path: "index.ts" }, 80), finalTurn("read complete", 80)],
      goal: "Read one source file for the prompt-cache experiment replay.",
      cacheMode: "experiment-cache-metadata-replay",
    });

    const baselineRuns = workloads.map((run) => ({
      runId: run.telemetry.identity.runId,
      taskCompletionStatus: run.telemetry.taskCompletionStatus,
      stopReason: run.telemetry.stopReason,
      routeClass: run.telemetry.routeClass,
      model: run.telemetry.model,
      tools: run.telemetry.tools,
      context: run.telemetry.context,
      retries: run.telemetry.retries,
      providerFailures: run.telemetry.providerFailures,
      wallTimeMs: run.telemetry.wallTimeMs,
      forgeGreenOverheadMs: run.telemetry.forgeGreenOverheadMs,
      actualProviderCost: run.telemetry.actualProviderCost,
      effectiveProviderCost: run.telemetry.effectiveProviderCost,
      authority: { forgeVerify: run.telemetry.forgeVerify, completionGate: run.telemetry.completionGate },
      providerRequestCount: run.providerRequestCount,
    }));
    const baseline = {
      schema: "codeforge-forgegreen-r0-baseline-v1",
      generatedAt: new Date().toISOString(),
      deterministicReplay: true,
      liveInference: false,
      paidInference: false,
      repositoryRevision,
      workloadCount: baselineRuns.length,
      measurementSources: {
        modelUsage: "PROVIDER_REPORTED scripted stream events",
        toolBytes: "RUNTIME byte counts from bounded ToolExecutionRecord fields",
        context: "RUNTIME context assembly byte counts",
        authority: "UNKNOWN because this local harness does not invoke ForgeVerify or Completion Gate",
        cost: "UNKNOWN because the scripted provider reports no price/quota",
      },
      runs: baselineRuns,
      findings: [
        "Repeated tool discovery is visible in the duplicate workload: duplicate-equivalent calls are suppressed before physical execution.",
        "Large local output is measured before and after model-context compression; authoritative output remains separate.",
        "The replay does not establish production provider cache economics or verified-completion parity.",
      ],
    };
    await fs.writeFile(path.join(evidenceDir, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const controlSample = experimentSample(control);
    const experimentSampleRecord = experimentSample(experiment);
    const comparison = comparePromptCacheExperiment(controlSample, experimentSampleRecord);
    const controlArtifact = {
      schema: "codeforge-forgegreen-r0-prompt-cache-sample-v1",
      sampleRole: "CONTROL",
      liveInference: false,
      cacheMechanism: "no provider cache metadata",
      sample: controlSample,
    };
    const experimentArtifact = {
      schema: "codeforge-forgegreen-r0-prompt-cache-sample-v1",
      sampleRole: "EXPERIMENT",
      liveInference: false,
      cacheMechanism: "scripted provider cache metadata replay; no cache API call",
      sample: experimentSampleRecord,
    };
    await fs.writeFile(path.join(evidenceDir, "prompt-cache-control.json"), `${JSON.stringify(controlArtifact, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(evidenceDir, "prompt-cache-experiment.json"), `${JSON.stringify(experimentArtifact, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(evidenceDir, "comparison.json"), `${JSON.stringify({
      schema: "codeforge-forgegreen-r0-prompt-cache-comparison-v1",
      comparison,
      interpretation: "The replay demonstrates the false-win guard: authority parity is UNKNOWN, so it is not a production efficiency win even though cache-shaped token metadata is lower.",
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(evidenceDir, "test-summary.json"), `${JSON.stringify({
      schema: "codeforge-forgegreen-r0-evidence-run-v1",
      generatedAt: baseline.generatedAt,
      command: "node scripts/forgegreen-r0-baseline.mjs",
      deterministicReplay: true,
      workloadRuns: baselineRuns.map((run) => ({ runId: run.runId, status: run.taskCompletionStatus, stopReason: run.stopReason })),
      promptCacheComparison: { comparable: comparison.comparable, netPositive: comparison.netPositive, reasons: comparison.reasons },
      noPaidInference: true,
    }, null, 2)}\n`, "utf8");

    console.log(JSON.stringify({
      evidenceDir: path.relative(root, evidenceDir),
      workloadRuns: baselineRuns.map((run) => ({ runId: run.runId, status: run.taskCompletionStatus.value, toolCalls: run.tools.toolCalls.value, duplicateEquivalentToolCalls: run.tools.duplicateEquivalentToolCalls.value })),
      promptCacheComparison: { comparable: comparison.comparable, netPositive: comparison.netPositive, reasons: comparison.reasons },
    }, null, 2));
  } finally {
    await persistence.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

await main();

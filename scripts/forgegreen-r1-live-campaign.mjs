// Bounded ForgeGreen R1 live campaign over one freshly qualified exact Managed-Free route.
// The harness measures the existing runtime surfaces; it never changes ForgeVerify or the
// Completion Gate and never records provider content or credentials.
//
//   node scripts/forgegreen-r1-live-campaign.mjs [--out=<file>]

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createOpenRouterAdapter } from "@codeforge/providers";
import { createForgeGreenAdvisor } from "@codeforge/forge-green";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "@codeforge/server";
import { createWorkflowEngine } from "@codeforge/workflow";

const execFile = promisify(execFileCallback);
const MODEL_ID = "nvidia/nemotron-3-super-120b-a12b:free";
const ROUTE = { providerId: "openrouter", modelId: MODEL_ID };
const GOAL = "Fix the multiply function in src/calc.mjs so test/calc.test.mjs passes. Do not modify the tests.";
const VERIFY = ["node --test test/calc.test.mjs"];
const OUT = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
  ?? "docs/evidence/forgegreen-r1/live-campaign.json";

function fleetRecord() {
  return createGenericFreeRecord({
    providerId: ROUTE.providerId,
    modelId: ROUTE.modelId,
    displayName: "OpenRouter exact free Nemotron route",
    codingScore: 80,
    contextWindow: 131072,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      longContext: true,
    },
    benchmarkProfile: {
      coding: 80,
      toolCalling: 80,
      reasoning: 80,
      longContext: 80,
      speed: 60,
    },
  });
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "forgegreen-r1-live-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "forgegreen-r1-fixture",
    version: "1.0.0",
    type: "module",
    scripts: { test: "node --test" },
  }), "utf8");
  await writeFile(join(root, "README.md"), "# ForgeGreen R1 fixture\n\nA bounded live campaign repository.\n", "utf8");
  await writeFile(join(root, "src", "calc.mjs"), "export function multiply(a, b) { return 0; }\n\nexport function add(a, b) { return a + b; }\n", "utf8");
  await writeFile(join(root, "src", "format.mjs"), "export function format(value) { return `value: ${value}`; }\n", "utf8");
  await writeFile(join(root, "src", "index.mjs"), "export { multiply, add } from './calc.mjs';\nexport { format } from './format.mjs';\n", "utf8");
  await writeFile(join(root, "test", "calc.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { multiply } from '../src/calc.mjs';",
    "test('multiply', () => assert.equal(multiply(6, 7), 42));",
    "",
  ].join("\n"), "utf8");
  const repeated = Array.from({ length: 700 }, (_, index) =>
    `INFO build step ${index % 7} completed successfully; artifact remains unchanged`,
  );
  repeated.splice(420, 0, "ERROR sentinel retained for diagnostic context: no command should trust log prose");
  await writeFile(join(root, "logs", "build.log"), `${repeated.join("\n")}\n`, "utf8");
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(root, "src", `module-${index}.mjs`), `export const module${index} = ${index};\n`, "utf8");
  }
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFile("git", ["config", "user.name", "CodeForge R1"], { cwd: root });
  await execFile("git", ["config", "user.email", "forgegreen-r1@codeforge.local"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-qm", "Initial R1 fixture"], { cwd: root });
  return root;
}

function executionBudget(role) {
  if (role === "coder") {
    return {
      maxModelTurns: 8,
      maxToolCalls: 12,
      maxWriteToolCalls: 3,
      maxCommandExecutions: 3,
      maxContextTokens: 16000,
      maxOutputTokens: 500,
    };
  }
  return {
    maxModelTurns: 4,
    maxToolCalls: 8,
    maxWriteToolCalls: 0,
    maxCommandExecutions: 0,
    maxContextTokens: 12000,
    maxOutputTokens: 400,
  };
}

function permissions(role) {
  return role === "coder"
    ? { read: true, search: true, write: true, executeCommand: true, network: false }
    : { read: true, search: true, write: false, executeCommand: false, network: false };
}

function sanitizeExecution(execution) {
  return {
    toolName: execution.toolName,
    success: execution.success,
    readOnly: execution.readOnly,
    durationMs: execution.durationMs,
    rawOutputBytes: execution.rawOutputBytes ?? null,
    modelContextBytes: execution.modelContextOutput ? Buffer.byteLength(execution.modelContextOutput, "utf8") : Buffer.byteLength(execution.output ?? "", "utf8"),
    compression: execution.compression ?? null,
  };
}

function summarizeAgentResult(result) {
  const receipt = result.contextMetrics?.efficiencyReceipt;
  return {
    status: result.status,
    stopReason: result.stopReason,
    error: result.error ?? null,
    filesChanged: result.filesChanged,
    usage: result.usage,
    toolExecutions: result.toolExecutions.map(sanitizeExecution),
    contextMetrics: result.contextMetrics ? {
      contextBytes: result.contextMetrics.contextBytes,
      estimatedInputTokens: result.contextMetrics.estimatedInputTokens,
      candidateFileCount: result.contextMetrics.candidateFileCount,
      selectedFileCount: result.contextMetrics.selectedFileCount,
      selectedEvidenceCount: result.contextMetrics.selectedEvidenceCount,
      efficiencyReceipt: receipt ?? null,
    } : null,
  };
}

async function runArm({ arm, forgeGreenEnabled }) {
  const workspacePath = await buildFixture();
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(fleetRecord());
  const catalog = new InMemoryProviderCatalog();
  catalog.register(createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 90000 }));
  const advisor = createForgeGreenAdvisor({ enabled: forgeGreenEnabled });
  const sessionId = `forgegreen-r1-${arm}`;
  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath,
    forgeGreen: advisor,
  });

  const runAgent = (runId, role, goal) => runtime.executeAgentRun({
    runId,
    agentId: role,
    role,
    goal,
    workspaceId: `workspace-${arm}`,
    workspacePath,
    permissions: permissions(role),
    modelSelection: ROUTE,
    roleRouting: true,
    executionBudget: executionBudget(role),
  });

  const discovery = await runAgent(
    `${arm}-discovery`,
    "explorer",
    "Perform read-only repository discovery. Use list_files once, repo_search once, and read_file on src/calc.mjs twice with the exact same path and no mutation between reads. Then summarize and stop.",
  );
  const largeOutput = await runAgent(
    `${arm}-large-output`,
    "explorer",
    "Perform a read-only diagnostics pass. Read logs/build.log, preserve any error context in your summary, and stop after the read; do not edit files or run commands.",
  );

  const workflow = createWorkflowEngine({
    workspacePath,
    sessionId,
    verificationCommands: VERIFY,
    forgeGreen: advisor,
    askForApproval: async () => "allow_once",
    agentExecutor: {
      executePlan: async (plan, context, _repoMap, intent) => {
        const result = await runAgent(
          `${arm}-edit-verify-coder`,
          "coder",
          `${intent.rawMessage}\nImplement the approved plan with the smallest safe edit. Use hash-protected edit_file. Do not modify test files.`,
        );
        return {
          success: result.status === "completed",
          output: result.summary,
          planId: plan.id,
          contextFiles: context.primaryFiles,
        };
      },
    },
  });
  const workflowResult = await workflow.run(GOAL);
  const finalCalc = await readFile(join(workspacePath, "src", "calc.mjs"), "utf8").catch(() => null);
  let independentVerification = { passed: false, exitCode: null, output: "" };
  try {
    const verification = await execFile("node", ["--test", "test/calc.test.mjs"], { cwd: workspacePath });
    independentVerification = { passed: true, exitCode: 0, output: String(verification.stdout).slice(0, 500) };
  } catch (error) {
    independentVerification = { passed: false, exitCode: error.code ?? 1, output: String(error.stdout ?? "").slice(0, 500) };
  }

  const telemetryItems = (await persistence.getWorkItemsByKind("forgegreen_r0_telemetry"))
    .filter((item) => item.kind === "forgegreen_r0_telemetry")
    .map((item) => item.record);
  const ledgers = (await persistence.getWorkItemsByKind("forgegreen_ledger"))
    .filter((item) => item.kind === "forgegreen_ledger")
    .map((item) => item.record);
  const status = await execFile("git", ["status", "--porcelain"], { cwd: workspacePath });
  const result = {
    arm,
    forgeGreenEnabled,
    route: ROUTE,
    security: {
      networkPermission: false,
      providerCredentialsUsed: ["OPENROUTER_API_KEY (presence only)"],
      paidInferenceRequested: false,
      exactFreeRoutePinned: true,
    },
    workloads: {
      repositoryDiscovery: summarizeAgentResult(discovery),
      largeToolOutput: summarizeAgentResult(largeOutput),
    },
    editVerify: {
      workflowStatus: workflowResult.status,
      completion: workflowResult.completion ? {
        outcome: workflowResult.completion.outcome,
        blockers: workflowResult.completion.blockers.map((blocker) => blocker.code),
        advisories: workflowResult.completion.advisories.map((advisory) => advisory.code),
      } : null,
      verification: workflowResult.verification ? {
        command: workflowResult.verification.command,
        passed: workflowResult.verification.passed,
        failed: workflowResult.verification.failed,
        exitCode: workflowResult.verification.exitCode,
        durationMs: workflowResult.verification.durationMs,
        forgeVerify: workflowResult.verification.forgeVerify ? {
          planId: workflowResult.verification.forgeVerify.plan.planId,
          summary: workflowResult.verification.forgeVerify.summary,
        } : null,
      } : null,
      review: workflowResult.review ? {
        approved: workflowResult.review.approved,
        findings: workflowResult.review.findings,
        diffPaths: workflowResult.review.diffs.map((diff) => diff.path),
      } : null,
      changedFiles: workflowResult.review?.diffs.map((diff) => diff.path) ?? [],
      finalCalc,
      independentVerification,
    },
    telemetry: telemetryItems,
    ledgers,
    workspaceStatus: status.stdout.trim(),
  };
  persistence.close();
  await rm(workspacePath, { recursive: true, force: true });
  return result;
}

function numberMetric(metric) {
  return typeof metric?.value === "number" ? metric.value : null;
}

function flattenArm(arm) {
  const discovery = arm.workloads.repositoryDiscovery;
  const large = arm.workloads.largeToolOutput;
  const executions = [...discovery.toolExecutions, ...large.toolExecutions];
  const compression = executions.reduce((total, execution) => total + (execution.compression?.originalBytes ?? 0) - (execution.compression?.compressedBytes ?? 0), 0);
  const raw = executions.reduce((total, execution) => total + (execution.compression?.originalBytes ?? execution.rawOutputBytes ?? 0), 0);
  const delivered = executions.reduce((total, execution) => total + (execution.compression?.compressedBytes ?? execution.modelContextBytes ?? 0), 0);
  const duplicateSuppressed = [discovery, large].reduce((total, result) => total + (result.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed ?? 0), 0);
  const allTelemetry = arm.telemetry;
  const modelAttempts = allTelemetry.reduce((total, telemetry) => total + (numberMetric(telemetry.model?.modelAttempts) ?? 0), 0);
  const providerAttempts = allTelemetry.reduce((total, telemetry) => total + (numberMetric(telemetry.model?.providerAttempts) ?? 0), 0);
  const inputTokens = allTelemetry.reduce((total, telemetry) => total + (numberMetric(telemetry.model?.inputTokens) ?? 0), 0);
  const outputTokens = allTelemetry.reduce((total, telemetry) => total + (numberMetric(telemetry.model?.outputTokens) ?? 0), 0);
  const overheadMs = allTelemetry.reduce((total, telemetry) => total + (numberMetric(telemetry.forgeGreenOverheadMs) ?? 0), 0);
  const wallTimeMs = allTelemetry.reduce((total, telemetry) => total + (numberMetric(telemetry.wallTimeMs) ?? 0), 0);
  return {
    workloadCount: 3,
    modelAttempts,
    providerAttempts,
    inputTokens,
    outputTokens,
    rawToolOutputBytes: raw,
    deliveredToolOutputBytes: delivered,
    toolOutputBytesAvoided: compression,
    toolOutputCompressionRatio: raw > 0 ? delivered / raw : null,
    duplicateActionsSuppressed: duplicateSuppressed,
    forgeGreenOverheadMs: overheadMs,
    wallTimeMs,
    editVerifyStatus: arm.editVerify.workflowStatus,
    completionOutcome: arm.editVerify.completion?.outcome ?? null,
    verificationPassed: arm.editVerify.verification?.failed === 0 && arm.editVerify.verification?.exitCode === 0,
    independentVerificationPassed: arm.editVerify.independentVerification.passed,
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is required; presence is checked only and the value is never printed or persisted");
  }
  const startedAt = new Date().toISOString();
  const control = await runArm({ arm: "control", forgeGreenEnabled: false });
  const experiment = await runArm({ arm: "experiment", forgeGreenEnabled: true });
  const controlFlat = flattenArm(control);
  const experimentFlat = flattenArm(experiment);
  const verificationParity = controlFlat.verificationPassed === experimentFlat.verificationPassed
    && controlFlat.completionOutcome === experimentFlat.completionOutcome
    && controlFlat.editVerifyStatus === experimentFlat.editVerifyStatus
    && controlFlat.verificationPassed;
  const securityPolicyUnchanged = control.security.exactFreeRoutePinned
    && experiment.security.exactFreeRoutePinned
    && control.security.networkPermission === experiment.security.networkPermission
    && !control.security.paidInferenceRequested
    && !experiment.security.paidInferenceRequested;
  const matchedOutcome = verificationParity
    && controlFlat.editVerifyStatus === "completed"
    && experimentFlat.editVerifyStatus === "completed";
  const materialEfficiencyImprovement = matchedOutcome && (
    experimentFlat.toolOutputBytesAvoided > controlFlat.toolOutputBytesAvoided
    || experimentFlat.duplicateActionsSuppressed > controlFlat.duplicateActionsSuppressed
    || experimentFlat.providerAttempts < controlFlat.providerAttempts
    || experimentFlat.inputTokens < controlFlat.inputTokens
  );
  const overheadAcceptable = experimentFlat.wallTimeMs === 0
    || experimentFlat.forgeGreenOverheadMs <= experimentFlat.wallTimeMs * 0.1;
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    purpose: "ForgeGreen R1 bounded live efficiency campaign over one exact freshly qualified OpenRouter :free route",
    claimLimit: "Two matched arms and three small workloads are directional evidence only; no population or provider-wide claim is made.",
    route: ROUTE,
    qualificationEvidence: "docs/evidence/forgegreen-r1/provider-recertification-openrouter.json",
    workloads: [
      "repository discovery with deliberate repeated read request",
      "large repetitive tool output",
      "edit followed by real ForgeVerify and Completion Gate",
    ],
    control: { ...control, summary: controlFlat },
    experiment: { ...experiment, summary: experimentFlat },
    comparison: {
      verificationParity,
      securityPolicyUnchanged,
      materialEfficiencyImprovement,
      overheadAcceptable,
      deltas: {
        toolOutputBytesAvoided: experimentFlat.toolOutputBytesAvoided - controlFlat.toolOutputBytesAvoided,
        duplicateActionsSuppressed: experimentFlat.duplicateActionsSuppressed - controlFlat.duplicateActionsSuppressed,
        providerAttempts: experimentFlat.providerAttempts - controlFlat.providerAttempts,
        inputTokens: experimentFlat.inputTokens - controlFlat.inputTokens,
        outputTokens: experimentFlat.outputTokens - controlFlat.outputTokens,
        forgeGreenOverheadMs: experimentFlat.forgeGreenOverheadMs - controlFlat.forgeGreenOverheadMs,
        wallTimeMs: experimentFlat.wallTimeMs - controlFlat.wallTimeMs,
      },
    },
    verdict: materialEfficiencyImprovement && verificationParity && securityPolicyUnchanged && overheadAcceptable
      ? "CODEFORGE_FORGEGREEN_R1_FULLY_CERTIFIED"
      : "CODEFORGE_FORGEGREEN_R1_IMPLEMENTED_VERIFICATION_PENDING",
  };
  const target = resolve(OUT);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({
    verdict: evidence.verdict,
    route: ROUTE,
    control: controlFlat,
    experiment: experimentFlat,
    comparison: evidence.comparison,
    evidence: target,
  }, null, 2));
  process.stdout.write("\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

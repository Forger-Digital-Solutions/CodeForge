// ForgeEval matched A/B: control (single-agent default path) vs treatment (R1 fixed SubAgent
// topology) on identical frozen fixtures, executed LIVE over the Managed-Free fleet.
//
//   node scripts/managed-free-forgeeval-ab.mjs [--out=<file>]
//
// Both arms run the same goal in fresh identical git fixtures with the same provider fleet and
// the same verification command; a deterministic oracle grades each arm on the real test result.
// One matched experiment is initial empirical evidence only — it supports no statistical claim.
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createGroqAdapter, createCloudflareAdapter } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ForgeEvalHarness } from "@codeforge/benchmark";
import {
  createAgentRuntime,
  createSubagentManager,
  createAutonomousRunOrchestrator,
  createWorkspaceService,
  createWorkspaceEventAdapter,
} from "@codeforge/server";

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", "docs/evidence/managed-free-forgeeval-ab.json");

function fleetRecord(providerId, modelId, overrides = {}) {
  return createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}`, ...overrides });
}

async function buildFixture() {
  const repoDir = await mkdtemp(join(tmpdir(), "cf-forgeeval-"));
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
  await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module", scripts: { test: "node --test" } }), "utf-8");
  await writeFile(join(repoDir, "README.md"), "# math-lib\n\nTiny math utilities. Run `npm test`.\n", "utf-8");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(join(repoDir, "src", "math.mjs"), "export function multiply(a, b) { return 0; }\n\nexport function add(a, b) { return a + b; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "format.mjs"), "export function format(value) { return `result: ${value}`; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "stats.mjs"), "export function mean(values) { if (values.length === 0) return 0; return values.reduce((a, b) => a + b, 0) / values.length; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "index.mjs"), "export { multiply, add } from './math.mjs';\nexport { format } from './format.mjs';\nexport { mean } from './stats.mjs';\n", "utf-8");
  await writeFile(
    join(repoDir, "test", "math.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../src/math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n",
    "utf-8",
  );
  await writeFile(
    join(repoDir, "test", "stats.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean } from '../src/stats.mjs';\ntest('mean', () => assert.equal(mean([2, 4, 6]), 4));\n",
    "utf-8",
  );
  await execFile("git", ["add", "."], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
  return repoDir;
}

const GOAL = "Make the failing test test/math.test.mjs pass by fixing the multiply function in src/math.mjs. Do not modify the tests.";
const VERIFY = ["node --test test/math.test.mjs"];

async function runArm({ r1Enabled, sessionId }) {
  const repoDir = await buildFixture();
  const worktreeBaseDir = await mkdtemp(join(tmpdir(), "cf-forgeeval-worktrees-"));
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(fleetRecord("groq", "openai/gpt-oss-120b", { codingScore: 90, benchmarkProfile: { coding: 92, toolCalling: 85, reasoning: 90, longContext: 85, speed: 80 } }));
  firewall.register(fleetRecord("groq", "openai/gpt-oss-20b", { codingScore: 55, benchmarkProfile: { coding: 60, toolCalling: 75, reasoning: 62, longContext: 60, speed: 92 } }));
  firewall.register(fleetRecord("cloudflare-workers-ai", "@cf/nvidia/nemotron-3-120b-a12b", { codingScore: 70, benchmarkProfile: { coding: 74, toolCalling: 90, reasoning: 78, longContext: 72, speed: 70 } }));
  firewall.register(fleetRecord("cloudflare-workers-ai", "@cf/openai/gpt-oss-120b", { codingScore: 88, benchmarkProfile: { coding: 88, toolCalling: 84, reasoning: 88, longContext: 84, speed: 78 } }));
  firewall.register(fleetRecord("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash", { codingScore: 62, benchmarkProfile: { coding: 66, toolCalling: 70, reasoning: 68, longContext: 64, speed: 85 } }));

  const catalog = new InMemoryProviderCatalog();
  catalog.register(createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 90_000 }));
  catalog.register(createCloudflareAdapter({
    apiKey: process.env.CLOUDFLARE_API_KEY ?? process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    timeoutMs: 90_000,
  }));

  persistence.upsertSession({ id: sessionId, title: `ForgeEval ${sessionId}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle" });
  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
  const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
  const subagentManager = createSubagentManager({ persistence, workspaceService, agentRuntime: runtime, r1Enabled });
  const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime, subagentManager, subagentsR1Enabled: r1Enabled });

  const startedAt = Date.now();
  const result = await orchestrator.startRun({
    sessionId,
    workspacePath: repoDir,
    goal: GOAL,
    verificationCommands: VERIFY,
    adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }),
  });
  const elapsedMs = Date.now() - startedAt;

  const workers = (await persistence.getWorkItemsByKind("subagent_run")).filter((item) => item.kind === "subagent_run");
  const verificationPassed = (result.verification ?? []).every((v) => v.passed);
  const workerModels = [...new Set(workers.map((w) => (w.model ? `${w.model.providerId}/${w.model.modelId}` : null)).filter(Boolean))];
  const tokenCount = workers.reduce((sum, w) => sum + w.telemetry.inputTokens + w.telemetry.outputTokens, 0);
  const toolCalls = workers.reduce((sum, w) => sum + w.telemetry.toolCalls, 0);

  persistence.close();
  await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  await rm(worktreeBaseDir, { recursive: true, force: true }).catch(() => {});

  return {
    status: result.status,
    summary: result.summary,
    elapsedMs,
    verificationPassed,
    verification: (result.verification ?? []).map((v) => ({ command: v.command, passed: v.passed })),
    workerCount: workers.length,
    workerModels,
    tokenCount,
    toolCalls,
    changedFiles: result.changedFiles,
    counters: result.counters,
  };
}

async function main() {
  for (const name of ["GROQ_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!process.env[name] || process.env[name].trim().length === 0) {
      throw new Error(`Operator credential ${name} is required for the live ForgeEval run (presence only; never printed)`);
    }
  }

  process.stdout.write(`[forgeeval-ab] control arm (single-agent): running...\n`);
  const control = await runArm({ r1Enabled: false, sessionId: "session-forgeeval-control" });
  process.stdout.write(`[forgeeval-ab] control: status=${control.status} verified=${control.verificationPassed}\n`);
  process.stdout.write(`[forgeeval-ab] treatment arm (R1 fixed team): running...\n`);
  const treatment = await runArm({ r1Enabled: true, sessionId: "session-forgeeval-treatment" });
  process.stdout.write(`[forgeeval-ab] treatment: status=${treatment.status} verified=${treatment.verificationPassed}\n`);

  const harness = new ForgeEvalHarness();
  const capsule = {
    schemaVersion: 1,
    assignment: "forgeeval matched pair",
    goal: GOAL,
    relevantFiles: ["src/math.mjs", "test/math.test.mjs"],
    knownEvidence: ["test:node --test test/math.test.mjs"],
    constraints: ["Identical frozen fixture; identical verification command; identical fleet."],
    requiredOutput: ["verified test pass"],
  };
  const startingStateDigest = crypto.createHash("sha256").update(JSON.stringify({ goal: GOAL, verify: VERIFY, fixture: "math-lib@1" })).digest("hex");

  const experiment = await harness.runMatchedExperiment({
    experimentId: `forgeeval-ab-${new Date().toISOString().slice(0, 10)}-r1-vs-single`,
    taskId: "math-lib-multiply-fix",
    taskType: "single-file-bug-fix",
    capsule,
    startingStateDigest,
    control: {
      topology: "single_agent",
      execute: async () => ({
        status: control.status === "completed" ? "completed" : control.status === "blocked" ? "blocked" : control.status,
        summary: control.summary,
        elapsedMs: control.elapsedMs,
        retryCount: 0,
        tokenCount: control.tokenCount,
        toolCalls: control.toolCalls,
        workerCount: control.workerCount,
        verificationPassed: control.verificationPassed,
        environmentalDifferences: ["control arm uses the default single-agent topology; R1 worker records are not persisted on this path"],
      }),
    },
    treatment: {
      topology: "fixed_team",
      execute: async () => ({
        status: treatment.status === "completed" ? "completed" : treatment.status === "blocked" ? "blocked" : treatment.status,
        summary: treatment.summary,
        elapsedMs: treatment.elapsedMs,
        retryCount: 0,
        tokenCount: treatment.tokenCount,
        toolCalls: treatment.toolCalls,
        workerCount: treatment.workerCount,
        modelId: treatment.workerModels.join(",") || undefined,
        verificationPassed: treatment.verificationPassed,
        environmentalDifferences: [],
      }),
    },
    oracle: {
      id: "deterministic.node-test",
      tier: "deterministic",
      grade: async ({ candidate }) => ({
        status: candidate.verificationPassed === true && candidate.status === "completed" ? "pass" : "fail",
        verified: candidate.verificationPassed === true && candidate.status === "completed",
        score: candidate.verificationPassed === true && candidate.status === "completed" ? 1 : 0,
        reason: `arm status=${candidate.status}; real verification ${candidate.verificationPassed ? "passed" : "did not pass"}`,
      }),
    },
    environmentalDifferences: [
      "arms ran sequentially against the same live free fleet; provider-side load varies over time",
    ],
  });

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: "ForgeEval matched A/B: single-agent control vs R1 fixed-team treatment, executed live over the Managed-Free fleet (initial empirical evidence only)",
    claimLimit: "One matched pair supports no statistical claim; measurement infrastructure is the deliverable.",
    startingStateDigest,
    control: control,
    treatment: treatment,
    experiment: experiment.experiment,
  };

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
  process.stdout.write(`[forgeeval-ab] control: status=${control.status} verified=${control.verificationPassed} elapsed=${control.elapsedMs}ms workers=${control.workerCount}\n`);
  process.stdout.write(`[forgeeval-ab] treatment: status=${treatment.status} verified=${treatment.verificationPassed} elapsed=${treatment.elapsedMs}ms workers=${treatment.workerCount}\n`);
  process.stdout.write(`[forgeeval-ab] capsuleDigest=${experiment.capsuleDigest.slice(0, 16)} evidence=${target}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

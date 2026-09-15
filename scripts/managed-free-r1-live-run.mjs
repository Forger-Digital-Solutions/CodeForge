// R1 Managed-Free live SubAgent run: one genuine bounded external-model task through the R1
// fixed topology —
//
//   Explore A ─┐
//              ├─ evidence/capsules → SWE Writer (worktree) → Reviewer → Verification → Completion
//   Explore B ─┘
//
//   node scripts/managed-free-r1-live-run.mjs [--out=<file>] [--keep]
//
// Real provider calls only (Groq / Cloudflare Workers AI operator credentials from the
// environment; values are never printed or persisted). Worker records, Task Capsules, router
// selections/failovers, worktree use, verification output, and per-worker telemetry are captured
// as sanitised evidence. Completion requires the run's real verification commands to pass; a run
// that verifies nothing terminates blocked, never "completed".
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createGroqAdapter, createCloudflareAdapter } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
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
const out = option("out", "docs/evidence/managed-free-r1-live-run.json");
const keep = args.includes("--keep");

function fleetRecord(providerId, modelId, overrides = {}) {
  return createGenericFreeRecord({
    providerId,
    modelId,
    displayName: `${providerId} ${modelId}`,
    ...overrides,
  });
}

async function main() {
  for (const name of ["GROQ_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!process.env[name] || process.env[name].trim().length === 0) {
      throw new Error(`Operator credential ${name} is required for the live R1 run (presence only; never printed)`);
    }
  }

  const repoDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "cf-r1-live-repo-"));
  const worktreeBaseDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "cf-r1-live-worktrees-"));

  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  // The live fleet: verified-free records the runtime routes through per role. Ranking is
  // deterministic — explorers rank by tool reliability, the coder by coding capability, the
  // reviewer by role contract + stable tiebreak — so workers can land on different providers.
  firewall.register(fleetRecord("groq", "openai/gpt-oss-120b", {
    codingScore: 90,
    benchmarkProfile: { coding: 92, toolCalling: 85, reasoning: 90, longContext: 85, speed: 80 },
  }));
  firewall.register(fleetRecord("groq", "openai/gpt-oss-20b", {
    codingScore: 55,
    benchmarkProfile: { coding: 60, toolCalling: 75, reasoning: 62, longContext: 60, speed: 92 },
  }));
  firewall.register(fleetRecord("cloudflare-workers-ai", "@cf/nvidia/nemotron-3-120b-a12b", {
    codingScore: 70,
    benchmarkProfile: { coding: 74, toolCalling: 90, reasoning: 78, longContext: 72, speed: 70 },
  }));
  firewall.register(fleetRecord("cloudflare-workers-ai", "@cf/openai/gpt-oss-120b", {
    codingScore: 88,
    benchmarkProfile: { coding: 88, toolCalling: 84, reasoning: 88, longContext: 84, speed: 78 },
  }));
  firewall.register(fleetRecord("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash", {
    codingScore: 62,
    benchmarkProfile: { coding: 66, toolCalling: 70, reasoning: 68, longContext: 64, speed: 85 },
  }));

  const catalog = new InMemoryProviderCatalog();
  const groq = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 90_000 });
  const cloudflare = createCloudflareAdapter({
    apiKey: process.env.CLOUDFLARE_API_KEY ?? process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    timeoutMs: 90_000,
  });
  catalog.register(groq);
  catalog.register(cloudflare);

  const sessionId = "session-r1-live";
  persistence.upsertSession({
    id: sessionId,
    title: "R1 Managed-Free Live Run",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
  });

  // Fixture repository: a real failing test the run must make pass, plus enough surrounding
  // modules that exploration has genuine territory to map.
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
  await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module", scripts: { test: "node --test" } }), "utf-8");
  await writeFile(join(repoDir, "README.md"), "# math-lib\n\nTiny math utilities. Run `npm test`.\n", "utf-8");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(join(repoDir, "src", "math.mjs"), "export function multiply(a, b) { return 0; }\n\nexport function add(a, b) { return a + b; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "format.mjs"), "export function format(value) { return `result: \${value}`; }\n", "utf-8");
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

  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath: repoDir,
  });
  const subagentManager = createSubagentManager({
    persistence,
    workspaceService,
    agentRuntime: runtime,
    r1Enabled: true,
  });
  const orchestrator = createAutonomousRunOrchestrator({
    workspaceService,
    persistence,
    agentRuntime: runtime,
    subagentManager,
    subagentsR1Enabled: true,
  });

  const adapter = createWorkspaceEventAdapter({ sessionId, eventStore, persistence });
  const startedAt = new Date().toISOString();
  const result = await orchestrator.startRun({
    sessionId,
    workspacePath: repoDir,
    goal: "Make the failing test test/math.test.mjs pass by fixing the multiply function in src/math.mjs. Do not modify the tests.",
    verificationCommands: ["node --test test/math.test.mjs"],
    adapter,
  });
  const completedAt = new Date().toISOString();

  const workers = (await persistence.getWorkItemsByKind("subagent_run")).map((item) => item.kind === "subagent_run" ? {
    role: item.role,
    agentId: item.agentId,
    status: item.status,
    model: item.model ?? null,
    workspace: item.workspace,
    capsule: {
      schemaVersion: item.capsule.schemaVersion,
      assignment: item.capsule.assignment,
      goal: item.capsule.goal,
      constraints: item.capsule.constraints,
      requiredOutput: item.capsule.requiredOutput,
      relevantFiles: item.capsule.relevantFiles.slice(0, 10),
    },
    permissions: item.permissions,
    allowedTools: item.allowedTools,
    telemetry: item.telemetry,
    artifacts: item.artifacts,
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? null,
  } : null).filter(Boolean);

  const routerEvents = eventStore.getAll().filter((event) => event.type === "router.selection" || event.type === "router.failover" || event.type === "eightbit.status");
  const lifecycleEvents = eventStore.getAll().filter((event) => event.type === "subagent.lifecycle").map((event) => ({
    role: event.payload.role,
    state: event.payload.state,
    model: event.payload.model ?? null,
  }));
  const toolEvents = eventStore.getAll().filter((event) => event.type === "tool.completed" || event.type === "tool.started").length;

  // Final fixture state + verification output are the honest completion proof.
  const finalMath = await (await import("node:fs/promises")).readFile(join(repoDir, "src", "math.mjs"), "utf-8").catch(() => null);
  let verificationOutput = null;
  try {
    const probe = await execFile("node", ["--test", "test/math.test.mjs"], { cwd: repoDir });
    verificationOutput = { ok: true, stdout: `${probe.stdout}`.slice(0, 2_000) };
  } catch (err) {
    verificationOutput = { ok: false, stdout: `${err.stdout ?? ""}`.slice(0, 2_000) };
  }

  const evidence = {
    schemaVersion: 1,
    generatedAt: completedAt,
    startedAt,
    purpose: "R1 live SubAgent run over the Managed-Free fleet (real external model calls; credentials never recorded)",
    goal: "Implement the multiply function in math.mjs so that the focused test test/math.test.mjs passes.",
    runStatus: result.status,
    runSummary: result.summary,
    changedFiles: result.changedFiles,
    review: result.review,
    verification: result.verification?.map((v) => ({ command: v.command, passed: v.passed, exitCode: v.exitCode ?? null, outputSample: `${v.output ?? ""}`.slice(0, 400) })) ?? null,
    integration: result.integration,
    counters: result.counters,
    workers,
    routing: routerEvents.map((event) => ({ type: event.type, payload: event.payload })),
    lifecycleEvents,
    toolEventCount: toolEvents,
    finalMathContents: finalMath,
    independentVerificationProbe: verificationOutput,
    providerCredentialsUsed: ["GROQ_API_KEY (present)", "CLOUDFLARE_API_KEY (present)", "CLOUDFLARE_ACCOUNT_ID (present)"],
  };

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  process.stdout.write(`[r1-live] status=${result.status} workers=${workers.length}\n`);
  for (const worker of workers) {
    process.stdout.write(`[r1-live]   ${worker.role}: ${worker.status} via ${worker.model ? `${worker.model.providerId}/${worker.model.modelId}` : "(no model)"} in ${worker.workspace.kind}${worker.telemetry ? ` · ${worker.telemetry.modelRequests} model requests · ${worker.telemetry.inputTokens + worker.telemetry.outputTokens} tokens · ${worker.telemetry.toolCalls} tools` : ""}\n`);
  }
  process.stdout.write(`[r1-live] verification=${JSON.stringify(evidence.verification?.map((v) => ({ command: v.command, passed: v.passed })))}\n`);
  process.stdout.write(`[r1-live] evidence=${target}\n`);

  if (!keep) {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await rm(worktreeBaseDir, { recursive: true, force: true }).catch(() => {});
  }
  persistence.close();

  if (result.status !== "completed") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

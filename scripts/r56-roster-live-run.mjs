// R56 live roster proof: one genuine bounded ForgeAuto/Free autonomous task through the
// production orchestrator WITH an owner-selected ForgeAuto roster attached —
//
//   roster (owner-scoped, PINNED CODER + AUTO free workers)
//     → Explore → Writer → Reviewer → Verification → Completion gate
//
//   node scripts/r56-roster-live-run.mjs [--out=<file>] [--keep] [--timeout-ms=<n>]
//
// Real provider calls only (Groq operator credential from the environment; the value is never
// printed or persisted). On top of the R1 harness evidence this captures the R55-specific
// surfaces: forgeauto_decision_receipt work items, shilling_entry usage records, and the
// per-worker persisted roster allowance. Completion still requires the run's real
// verification commands to pass; a run that verifies nothing terminates blocked.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  InMemoryProviderCatalog,
  createGroqAdapter,
  createOpenRouterAdapter,
  ProviderCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority } from "@codeforge/eight-bit";
import {
  createAgentRuntime,
  createSubagentManager,
  createAutonomousRunOrchestrator,
  createWorkspaceService,
  createWorkspaceEventAdapter,
  validateForgeAutoRoster,
} from "@codeforge/server";

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", "docs/evidence/r56-golden-backend-freeze/roster-live-run.json");
const keep = args.includes("--keep");
const timeoutMs = Number(option("timeout-ms", "420000"));
const pinModel = option("pin-model", "openai/gpt-oss-120b");
const pinExplorer = option("pin-explorer", "");

const OWNER = "r56-live-owner";

function fleetRecord(providerId, modelId, overrides = {}) {
  return createGenericFreeRecord({
    providerId,
    modelId,
    displayName: `${providerId} ${modelId}`,
    ...overrides,
  });
}

async function main() {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.trim().length === 0) {
    throw new Error("Operator credential GROQ_API_KEY is required for the live roster run (presence only; never printed)");
  }

  const repoDir = await mkdtemp(join(tmpdir(), "cf-r56-repo-"));
  const worktreeBaseDir = await mkdtemp(join(tmpdir(), "cf-r56-worktrees-"));

  // File-backed persistence: the run's work items must survive a real process boundary —
  // this is also the durability surface Workstream G re-opens in a second process.
  const dbPath = join(worktreeBaseDir, "r56-live.db");
  const persistence = createSessionPersistence({ dbPath });
  await persistence.init();
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  const governor = new ProviderCapacityGovernor({
    limits: {
      groq: { maxTokensPerMinute: 7500, maxRequestsPerMinute: 28, maxConcurrent: 2 },
      openrouter: { maxTokensPerMinute: 60000, maxRequestsPerMinute: 18, maxConcurrent: 2 },
    },
  });

  const catalog = new InMemoryProviderCatalog();
  // The shared route-health authority is wired so the model-scoped failure marking (R56
  // fix) is exercised by the live path — a 429 on one model cools only that route.
  // freeCloud is deliberately not wired: full fabric admission requires a live catalog
  // refresh + qualification cycle, which this harness does not run; without it every
  // route fails closed (verified on roster-live-run-blocked-fabric.json evidence).
  const routeHealth = createEightBitRouteHealthAuthority();
  const groq = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 120_000 });
  catalog.register(governor.wrapAdapter(groq));

  // Second managed-free lane: OpenRouter `:free` variants (live-verified $0 price cards).
  // Optional — when OPENROUTER_API_KEY is absent the roster simply offers the Groq pool.
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const hasOpenRouter = typeof openrouterKey === "string" && openrouterKey.trim().length > 0;
  if (hasOpenRouter) {
    catalog.register(governor.wrapAdapter(createOpenRouterAdapter({ timeoutMs: 120_000 })));
  }

  // Verified-free fleet records — gpt-oss-120b holds a live CODER qualification receipt
  // from the R56 supply certification; gpt-oss-20b is the lighter free sibling.
  firewall.register(fleetRecord("groq", "openai/gpt-oss-120b", {
    codingScore: 90,
    benchmarkProfile: { coding: 92, toolCalling: 85, reasoning: 90, longContext: 85, speed: 80 },
  }));
  firewall.register(fleetRecord("groq", "openai/gpt-oss-20b", {
    codingScore: 55,
    benchmarkProfile: { coding: 60, toolCalling: 75, reasoning: 62, longContext: 60, speed: 92 },
  }));
  // qwen3.8-27b holds a live QUALIFIED receipt for CODER from the R56 supply
  // certification — admitted so a pinned lane or AUTO rotation may use it.
  firewall.register(fleetRecord("groq", "qwen/qwen3.8-27b", {
    codingScore: 75,
    benchmarkProfile: { coding: 78, toolCalling: 80, reasoning: 75, longContext: 70, speed: 85 },
  }));

  // OpenRouter free variants — live /models response verified pricing.prompt/completion = "0"
  // and supported_parameters includes tools for each of these (checked 2026-09-29).
  if (hasOpenRouter) {
    firewall.register(fleetRecord("openrouter", "qwen/qwen3.8-27b:free", {
      codingScore: 75,
      benchmarkProfile: { coding: 78, toolCalling: 80, reasoning: 75, longContext: 70, speed: 70 },
    }));
    firewall.register(fleetRecord("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", {
      codingScore: 82,
      benchmarkProfile: { coding: 84, toolCalling: 78, reasoning: 88, longContext: 80, speed: 55 },
    }));
    firewall.register(fleetRecord("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", {
      codingScore: 85,
      benchmarkProfile: { coding: 86, toolCalling: 78, reasoning: 90, longContext: 85, speed: 45 },
    }));
  }

  // Roster candidate catalog: what the owner's roster may select from. qualifiedRoles are
  // harness-declared eligibility inputs; CODER on 120b is backed by the live compact-suite
  // receipt captured in live-supply-inventory.json.
  const ALL_ROLES = ["EXPLORER", "PLANNER", "CODER", "TESTER", "REVIEWER", "LEAD"];
  const rosterCatalog = [
    { modelId: "openai/gpt-oss-120b", providerId: "groq", providerModelId: "openai/gpt-oss-120b", familyId: "gpt-oss", version: "120b", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ALL_ROLES, dataPolicy: { privateCode: true } },
    { modelId: "openai/gpt-oss-20b", providerId: "groq", providerModelId: "openai/gpt-oss-20b", familyId: "gpt-oss", version: "20b", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE_ECONOMY", available: true, approved: true, qualifiedRoles: ALL_ROLES, dataPolicy: { privateCode: true } },
    { modelId: "qwen/qwen3.8-27b", providerId: "groq", providerModelId: "qwen/qwen3.8-27b", familyId: "qwen3", version: "3.8-27b", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ALL_ROLES, dataPolicy: { privateCode: true } },
    ...(hasOpenRouter ? [
      { modelId: "qwen/qwen3.8-27b:free", providerId: "openrouter", providerModelId: "qwen/qwen3.8-27b:free", familyId: "qwen3", version: "3.8-27b", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ALL_ROLES, dataPolicy: { privateCode: true } },
      { modelId: "nvidia/nemotron-3-super-120b-a12b:free", providerId: "openrouter", providerModelId: "nvidia/nemotron-3-super-120b-a12b:free", familyId: "nemotron3", version: "super-120b", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ALL_ROLES, dataPolicy: { privateCode: true } },
      { modelId: "nvidia/nemotron-3-ultra-550b-a55b:free", providerId: "openrouter", providerModelId: "nvidia/nemotron-3-ultra-550b-a55b:free", familyId: "nemotron3", version: "ultra-550b", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ALL_ROLES, dataPolicy: { privateCode: true } },
    ] : []),
  ];

  // Owner roster: CODER is pinned to the selected lane (default 120b — the qualified
  // model; --pin-model overrides when the lane is quota-exhausted). Every other role
  // draws from the AUTO managed-free pool, which ranks 120b first and must fail over
  // to 20b on a real 429. Disjoint allowedRoles keep the slots non-conflicting.
  const roster = {
    ownerUserId: OWNER,
    entitlement: "FREE",
    slots: [
      { kind: "PINNED_VERSION", modelId: pinModel, enabled: true, allowedRoles: ["CODER"] },
      // Optional second pin keeps the explorer off the coder's lane — Groq free windows
      // are thin enough that contention on the builder's model is a real failure mode.
      ...(pinExplorer
        ? [{ kind: "PINNED_VERSION", modelId: pinExplorer, enabled: true, allowedRoles: ["EXPLORER"] }]
        : []),
      { kind: "AUTO", sourceClass: "MANAGED_FREE", enabled: true, allowedRoles: pinExplorer ? ["PLANNER", "TESTER", "REVIEWER", "LEAD"] : ["EXPLORER", "PLANNER", "TESTER", "REVIEWER", "LEAD"] },
    ],
    lead: { mode: "NONE" },
    updatedAt: new Date().toISOString(),
  };
  validateForgeAutoRoster(roster, rosterCatalog);

  const sessionId = "session-r56-live";
  await persistence.upsertSession({
    id: sessionId,
    title: "R56 Roster Live Run",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
  });

  // Fixture repository: two real failing tests the run must make pass.
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
  await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module", scripts: { test: "node --test" } }), "utf-8");
  await writeFile(join(repoDir, "README.md"), "# math-lib\n\nTiny math utilities. Run `npm test`.\n", "utf-8");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(join(repoDir, "src", "math.mjs"), "export function multiply(a, b) { return 0; }\n\nexport function add(a, b) { return a + b; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "format.mjs"), "export function format(value) { return `value: ${value}`; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "stats.mjs"), "export function mean(values) { if (values.length === 0) return 0; return values.reduce((a, b) => a + b, 0) / values.length; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "index.mjs"), "export { multiply, add } from './math.mjs';\nexport { format } from './format.mjs';\nexport { mean } from './stats.mjs';\n", "utf-8");
  await writeFile(join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../src/math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n", "utf-8");
  await writeFile(join(repoDir, "test", "format.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { format } from '../src/format.mjs';\ntest('format', () => assert.equal(format(42), 'result: 42'));\n", "utf-8");
  await writeFile(join(repoDir, "test", "stats.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean } from '../src/stats.mjs';\ntest('mean', () => assert.equal(mean([2, 4, 6]), 4));\n", "utf-8");
  await execFile("git", ["add", "."], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
  const baselineHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();

  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath: repoDir,
    userId: OWNER,
    routeHealth,
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
  const runController = new AbortController();
  const timeout = setTimeout(() => runController.abort(), timeoutMs);
  let result;
  try {
    result = await orchestrator.startRun({
      sessionId,
      workspacePath: repoDir,
      goal: "Inspect the repository and make both failing tests pass by fixing multiply in src/math.mjs and the public output format in src/format.mjs. Do not modify the tests.",
      verificationCommands: ["node --test test/math.test.mjs test/format.test.mjs"],
      adapter,
      signal: runController.signal,
      rosterContext: { roster, catalog: rosterCatalog },
    });
  } finally {
    clearTimeout(timeout);
  }
  const completedAt = new Date().toISOString();

  const workers = (await persistence.getWorkItemsByKind("subagent_run")).map((item) => ({
    role: item.role,
    agentId: item.agentId,
    status: item.status,
    model: item.model ?? null,
    rosterAllowance: item.rosterAllowance
      ? {
          freeRoutes: item.rosterAllowance.freeRoutes,
          paidModelIds: item.rosterAllowance.paidModelIds,
          userRoutes: item.rosterAllowance.userRoutes,
          decisionOwner: item.rosterAllowance.decision?.ownerUserId ?? null,
        }
      : null,
    telemetry: item.telemetry,
    workspace: { kind: item.workspace?.kind },
  }));

  const routerEvents = eventStore.getAll().filter((event) => event.type === "router.selection" || event.type === "router.failover" || event.type === "eightbit.status");
  const decisionReceipts = (await persistence.getWorkItemsByKind("forgeauto_decision_receipt")).map((item) => item.decision);
  const shillingEntries = (await persistence.getWorkItemsByKind("shilling_entry")).map((item) => item.entry);
  const toolEvents = eventStore.getAll().filter((event) => event.type === "tool.completed" || event.type === "tool.started").length;

  const finalMath = await readFile(join(repoDir, "src", "math.mjs"), "utf-8").catch(() => null);
  const finalFormat = await readFile(join(repoDir, "src", "format.mjs"), "utf-8").catch(() => null);
  let verificationOutput = null;
  try {
    const probe = await execFile("node", ["--test", "test/math.test.mjs", "test/format.test.mjs"], { cwd: repoDir });
    verificationOutput = { ok: true, stdout: `${probe.stdout}`.slice(0, 2_000) };
  } catch (err) {
    verificationOutput = { ok: false, stdout: `${err.stdout ?? ""}`.slice(0, 2_000) };
  }
  let finalHead = null;
  try {
    finalHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
  } catch {}
  const dirtyTree = (await execFile("git", ["status", "--porcelain"], { cwd: repoDir })).stdout.trim();

  const evidence = {
    schemaVersion: 1,
    generatedAt: completedAt,
    startedAt,
    purpose: "R56 live ForgeAuto/Free roster run over real managed-free lanes (Groq + OpenRouter :free when keyed; real external model calls; credentials never recorded)",
    owner: OWNER,
    roster: { entitlement: roster.entitlement, slots: roster.slots, lead: roster.lead },
    goal: "Implement multiply and repair the formatter so the focused math and format tests pass.",
    runStatus: result.status,
    runSummary: result.summary,
    changedFiles: result.changedFiles,
    completion: result.completion ?? null,
    verification: result.verification?.map((v) => ({ command: v.command, passed: v.passed, exitCode: v.exitCode ?? null, outputSample: `${v.output ?? ""}`.slice(0, 400) })) ?? null,
    integration: result.integration,
    counters: result.counters,
    workers,
    routing: routerEvents.map((event) => ({ type: event.type, payload: event.payload })),
    decisionReceipts,
    shillingEntries: shillingEntries.map((entry) => ({
      id: entry.id, role: entry.role, sourceClass: entry.sourceClass,
      providerId: entry.providerId, modelId: entry.modelId,
      rawUsage: entry.rawUsage, rawUnit: entry.conversion?.rawUnit,
      shConsumed: entry.shConsumed, confidence: entry.conversion?.confidence,
      managedSpendUsd: entry.managedSpendUsd, userProviderSpendUsd: entry.userProviderSpendUsd,
    })),
    toolEventCount: toolEvents,
    fixture: { baselineHead, finalHead, dirtyTree },
    finalMathContents: finalMath,
    finalFormatContents: finalFormat,
    independentVerificationProbe: verificationOutput,
    governorCapacityReports: { groq: governor.getCapacityReport("groq") },
    providerCredentialsUsed: [
      "GROQ_API_KEY (present)",
      ...(hasOpenRouter ? ["OPENROUTER_API_KEY (present; resolved by EnvironmentCredentialStore at request time)"] : []),
    ],
    dbPath,
  };

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  process.stdout.write(`[r56-live] status=${result.status} workers=${workers.length} db=${dbPath}\n`);
  for (const worker of workers) {
    process.stdout.write(`[r56-live]   ${worker.role}: ${worker.status} via ${worker.model ? `${worker.model.providerId}/${worker.model.modelId}` : "(no model)"} · allowance=${JSON.stringify(worker.rosterAllowance?.freeRoutes ?? worker.rosterAllowance?.paidModelIds ?? [])}${worker.telemetry ? ` · ${worker.telemetry.modelRequests} model requests · ${worker.telemetry.inputTokens + worker.telemetry.outputTokens} tokens` : ""}\n`);
  }
  process.stdout.write(`[r56-live] receipts=${decisionReceipts.length} shillings=${shillingEntries.length} verification=${JSON.stringify(evidence.verification?.map((v) => v.passed))}\n`);
  process.stdout.write(`[r56-live] evidence=${target}\n`);

  await persistence.close();
  if (!keep) {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    // The db is evidence — keep the worktree dir so Workstream G can reopen it.
  }

  if (result.status !== "completed") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

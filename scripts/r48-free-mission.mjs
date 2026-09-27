// R48 E2 live managed-free mission: one real multi-role engineering task through the full
// production routing stack —
//
//   FreeCloudService (real account pools) → FreeFabric admission → per-role qualification floor
//   → explorer/planner/coder/reviewer role routing → ForgeVerify + completion gate.
//
// Unlike scripts/managed-free-r1-live-run.mjs (bare router), this run admits every role turn
// through the fabric with the R48 per-role verdict floor and physical-pool independence hints.
// Durable qualification receipts come from the shared probe database, so quota is spent on the
// mission, not on re-measuring routes.
//
//   node scripts/r48-free-mission.mjs [--out=<file>] [--keep] [--qual-db=<path>] [--qualify-budget=<n>]
//
// Credentials are read from the environment by presence only; values are never printed or
// persisted. Evidence lands under docs/evidence/r48-role-routing/.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ForgeZero, CapacityReservationLedger } from "@codeforge/forge-zero";
import {
  createProviderCatalog,
  createProviderAdapterById,
  createOpenRouterAdapter,
  defaultCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import {
  createEightBitRouteHealthAuthority,
  EightBitRouteHealthLedger,
  FreeFabric,
  SqliteQualificationPersistence,
} from "@codeforge/eight-bit";
import { createFreeCloudService, NormalizedModelRegistry } from "@codeforge/model-registry";
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
const out = option("out", "docs/evidence/r48-role-routing/r48-free-mission.json");
const keep = args.includes("--keep");
const qualDbPath = option("qual-db", join(tmpdir(), "r46-qualification.db"));
const qualifyBudget = Number(option("qualify-budget", "0"));
const timeoutMs = Number(option("timeout-ms", "600000"));

// Accounts with durable qualification receipts. Presence is checked per-provider; absent keys
// skip that account rather than fail the whole run.
const PROVIDERS = ["groq", "mistral", "openrouter"];
const ENV_KEY = { groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", openrouter: "OPENROUTER_API_KEY" };

async function main() {
  const present = PROVIDERS.filter((id) => (process.env[ENV_KEY[id]] ?? "").trim().length > 0);
  if (present.length === 0) {
    throw new Error(`No provider credentials present (need at least one of ${Object.values(ENV_KEY).join(", ")})`);
  }
  console.log(`[r48-free] providers with credentials: ${present.join(", ")}`);

  const repoDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "r48-free-repo-"));
  const worktreeBaseDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "r48-free-wt-"));

  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  const routeHealth = createEightBitRouteHealthAuthority();
  const registry = new NormalizedModelRegistry();
  const catalog = createProviderCatalog();
  const freeCloud = createFreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth });
  const healthLedger = new EightBitRouteHealthLedger(persistence);
  healthLedger.attach(routeHealth);

  // One managed pool per real account — the physical quota domains the fabric schedules
  // against and the unit reviewer independence is measured in.
  for (const id of present) freeCloud.registerManagedPool(id, `live-acct-${id}`);

  const adapters = [];
  for (const id of present) {
    const adapter = id === "openrouter"
      ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1", onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) })
      : createProviderAdapterById(id, { onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) });
    if (adapter) adapters.push(adapter);
  }
  for (const adapter of adapters) catalog.register(adapter);
  console.log(`[r48-free] adapters: ${adapters.map((a) => a.providerId).join(", ")}`);

  const refresh = freeCloud.createCatalogRefresh({ maxAllowanceProbes: 0, requireCredentials: true });
  const refreshResult = await refresh.refresh();
  console.log(`[r48-free] catalog refresh: ${refreshResult.errors.length} errors`);
  for (const adapter of adapters) {
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ENVIRONMENT", authState: "ok", planAttested: true });
  }

  // Durable measured verdicts — the per-role floor runs on evidence, not hope.
  const qualDb = createSessionPersistence({ dbPath: qualDbPath });
  await qualDb.init();
  freeCloud.attachQualificationStore(new SqliteQualificationPersistence(qualDb));
  const restored = await freeCloud.loadQualification();
  console.log(`[r48-free] qualification receipts restored: ${restored}`);

  if (qualifyBudget > 0) {
    for (const id of present) {
      const receipts = await freeCloud.qualifyPending({ budget: qualifyBudget, providerId: id });
      for (const rec of receipts) {
        const roles = Object.entries(rec.roleResults ?? {}).map(([role, rr]) => `${role}=${rr.status}`).join(" ");
        console.log(`[r48-free] qualified ${rec.providerId}/${rec.modelId}: ${rec.qualificationState} ${roles}`);
      }
    }
  }

  const routes = freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL");
  const pools = freeCloud.capacityPools().filter((pool) => pool.scope !== "PER_USER_POOL");
  console.log(`[r48-free] capacity routes: ${routes.length} across ${pools.length} pools`);
  for (const route of routes) {
    const receipt = freeCloud.getQualificationReceipt(route.providerId, route.modelId);
    const roles = receipt ? Object.entries(receipt.roleResults ?? {}).filter(([, r]) => r.status === "QUALIFIED" || r.status === "PROBATION").map(([role, r]) => `${role}:${r.status}`).join(",") : "no-receipt";
    console.log(`[r48-free]   ${route.providerId}/${route.modelId} pool=${route.capacityPoolId} eligible=${freeCloud.isForgeAutoEligible(route.providerId, route.modelId)} roles=[${roles}]`);
  }

  const freeFabric = new FreeFabric({
    managedRoutes: () => freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"),
    managedPools: () => freeCloud.capacityPools().filter((pool) => pool.scope !== "PER_USER_POOL"),
    userSources: [{ routesForUser: (userId) => freeCloud.routesForUser(userId), poolsForUser: (userId) => freeCloud.poolsForUser(userId) }],
    health: routeHealth,
    reservations: new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 }),
    tokenizerRatioFor: (providerId) =>
      defaultCapacityGovernor.tokenizerRatio(providerId) ?? defaultCapacityGovernor.maxObservedTokenizerRatio(),
  });
  const fabricContext = ({ userId }) => {
    const uid = userId ?? "r48-live-operator";
    return { userId: uid, userIdentities: freeCloud.capacityIdentitiesFor(uid) };
  };

  // The mission repository: two real failing tests across a small module set — enough for
  // explorers to map and a coder to fix without touching tests.
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

  const sessionId = "session-r48-free";
  persistence.upsertSession({ id: sessionId, title: "R48 Free Role-Routed Mission", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle" });

  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
  const runtime = createAgentRuntime({
    sessionId, eventStore, persistence, firewall, providerCatalog: catalog,
    workspacePath: repoDir, freeCloud, freeFabric, fabricContext, routeHealth,
    userId: "r48-live-operator",
  });
  const subagentManager = createSubagentManager({ persistence, workspaceService, agentRuntime: runtime, r1Enabled: true });
  const orchestrator = createAutonomousRunOrchestrator({
    workspaceService, persistence, agentRuntime: runtime, subagentManager, subagentsR1Enabled: true,
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
    });
  } finally {
    clearTimeout(timeout);
  }
  const completedAt = new Date().toISOString();

  // ---- Evidence assembly -------------------------------------------------
  const journals = (await persistence.getWorkItemsByKind("agent_run_journal")).map((item) => ({
    runId: item.runId, role: item.role, state: item.state,
    route: item.route ?? null,
    routeFailovers: item.routing?.routeFailovers ?? [],
  }));
  const workers = (await persistence.getWorkItemsByKind("subagent_run")).map((item) => ({
    role: item.role, agentId: item.agentId, status: item.status,
    model: item.model ?? null, routePoolId: item.routePoolId ?? null,
    telemetry: item.telemetry ?? null,
  }));
  const routerEvents = eventStore.getAll()
    .filter((event) => event.type === "router.selection" || event.type === "router.failover")
    .map((event) => ({ type: event.type, payload: event.payload }));

  const finalMath = await readFile(join(repoDir, "src", "math.mjs"), "utf-8").catch(() => null);
  const finalFormat = await readFile(join(repoDir, "src", "format.mjs"), "utf-8").catch(() => null);
  let verificationProbe = null;
  try {
    const probe = await execFile("node", ["--test", "test/math.test.mjs", "test/format.test.mjs"], { cwd: repoDir });
    verificationProbe = { ok: true, output: `${probe.stdout}`.slice(0, 2_000) };
  } catch (err) {
    verificationProbe = { ok: false, output: `${err.stdout ?? ""}`.slice(0, 2_000) };
  }

  // Pool-independence summary: which physical pool served each role.
  const poolByRole = {};
  for (const journal of journals) {
    if (journal.route?.capacityPoolId) poolByRole[journal.role] = [...new Set([...(poolByRole[journal.role] ?? []), journal.route.capacityPoolId])];
  }

  const evidence = {
    schemaVersion: 1,
    round: "R48-E2",
    generatedAt: completedAt,
    startedAt,
    purpose: "Live managed-free mission through the real Free Fabric: per-role qualification floor, physical-pool admission, reviewer independence, durable route provenance.",
    providersPresent: present,
    capacityRoutes: routes.map((route) => ({ providerId: route.providerId, modelId: route.modelId, pool: route.capacityPoolId, eligible: freeCloud.isForgeAutoEligible(route.providerId, route.modelId) })),
    runStatus: result.status,
    runSummary: result.summary ?? null,
    changedFiles: result.changedFiles ?? [],
    verification: result.verification?.map((v) => ({ command: v.command, passed: v.passed, exitCode: v.exitCode ?? null, outputSample: `${v.output ?? ""}`.slice(0, 400) })) ?? null,
    workers,
    journals,
    routerEvents,
    poolByRole,
    finalMathContents: finalMath,
    finalFormatContents: finalFormat,
    independentVerificationProbe: verificationProbe,
    credentialsUsed: present.map((id) => `${ENV_KEY[id]} (present)`),
  };

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  console.log(`[r48-free] status=${result.status} workers=${workers.length}`);
  for (const journal of journals) {
    console.log(`[r48-free]   ${journal.role}: ${journal.state} via ${journal.route ? `${journal.route.providerId}/${journal.route.modelId}` : "(none)"} pool=${journal.route?.capacityPoolId ?? "-"}${journal.routeFailovers.length ? ` failovers=${journal.routeFailovers.length}` : ""}`);
  }
  console.log(`[r48-free] evidence=${target}`);

  if (!keep) {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await rm(worktreeBaseDir, { recursive: true, force: true }).catch(() => {});
  }
  persistence.close();
  qualDb.close?.();

  if (result.status !== "completed") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

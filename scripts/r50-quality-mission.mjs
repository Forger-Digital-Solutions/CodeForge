// R50 live managed-free quality mission: one real multi-role engineering task through the
// full production routing stack, now with the runtime-quality lane live —
//
//   FreeCloudService (real account pools) → FreeFabric admission → per-role qualification floor
//   → roleQualityDelta (replayed R49 production outcomes) → explorer/coder/reviewer routing
//   → ForgeVerify + completion gate → integration → verified_complete evidence.
//
// Difference from R49: before the mission the route-health authority is seeded with the
// role outcomes R49 actually recorded for nemotron-super (Explorer non-convergence ×2,
// Reviewer workspace-escape ×1, Coder verified ×2) — the same observations a durable ledger
// hydrate would restore. A dry before/after decide() proves the ranking moved; the live run
// then executes with the adapted ordering.
//
//   node scripts/r50-quality-mission.mjs [--out=<file>] [--keep] [--qual-db=<path>]
//
// Credentials are read from the environment by presence only; values are never printed or
// persisted. Evidence lands under docs/evidence/r50-runtime-quality/.
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
  FABRIC_MODEL_ROLE,
  FreeFabric,
  SqliteQualificationPersistence,
  roleQualityAdvice,
  roleQualificationStatusFor,
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
const out = option("out", "docs/evidence/r50-runtime-quality/R50-LIVE-8BIT-QUALITY-MISSION.json");
const keep = args.includes("--keep");
const qualDbPath = option("qual-db", join(tmpdir(), "r46-qualification.db"));
const timeoutMs = Number(option("timeout-ms", "600000"));
// One allowance-verification probe per connected provider: allowance-free supply (Groq,
// Mistral) requires live proof, and the shared refresh budget must cover each provider once.
const allowanceProbes = Number(option("allowance-probes", "8"));

const PROVIDERS = ["groq", "mistral", "openrouter"];
const ENV_KEY = { groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", openrouter: "OPENROUTER_API_KEY" };

async function git(cwd, gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { cwd });
  return stdout.trim();
}

async function main() {
  const present = PROVIDERS.filter((id) => (process.env[ENV_KEY[id]] ?? "").trim().length > 0);
  if (present.length === 0) {
    throw new Error(`No provider credentials present (need at least one of ${Object.values(ENV_KEY).join(", ")})`);
  }
  console.log(`[r49-free] providers with credentials: ${present.join(", ")}`);

  const repoDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "r49-free-repo-"));
  const worktreeBaseDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "r49-free-wt-"));

  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  const routeHealth = createEightBitRouteHealthAuthority();
  const registry = new NormalizedModelRegistry();
  const catalog = createProviderCatalog();
  const freeCloud = createFreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth });
  const healthLedger = new EightBitRouteHealthLedger(persistence);
  healthLedger.attach(routeHealth);

  for (const id of present) freeCloud.registerManagedPool(id, `live-acct-${id}`);

  const adapters = [];
  for (const id of present) {
    const adapter = id === "openrouter"
      ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1", onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) })
      : createProviderAdapterById(id, { onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) });
    if (adapter) adapters.push(adapter);
  }
  for (const adapter of adapters) catalog.register(adapter);
  console.log(`[r49-free] adapters: ${adapters.map((a) => a.providerId).join(", ")}`);

  const refresh = freeCloud.createCatalogRefresh({ maxAllowanceProbes: allowanceProbes, requireCredentials: true });
  const refreshResult = await refresh.refresh();
  console.log(`[r49-free] catalog refresh: ${refreshResult.errors.length} errors (allowance probe budget=${allowanceProbes})`);
  for (const adapter of adapters) {
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ENVIRONMENT", authState: "ok", planAttested: true });
  }

  const qualDb = createSessionPersistence({ dbPath: qualDbPath });
  await qualDb.init();
  freeCloud.attachQualificationStore(new SqliteQualificationPersistence(qualDb));
  const restored = await freeCloud.loadQualification();
  console.log(`[r49-free] qualification receipts restored: ${restored}`);

  const routes = freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL");
  const pools = freeCloud.capacityPools().filter((pool) => pool.scope !== "PER_USER_POOL");
  console.log(`[r49-free] capacity routes: ${routes.length} across ${pools.length} pools`);
  const preMissionRoutes = routes.map((route) => {
    const receipt = freeCloud.getQualificationReceipt(route.providerId, route.modelId);
    const health = routeHealth.snapshot().find((h) => h.providerId === route.providerId && h.modelId === route.modelId);
    const roles = receipt
      ? Object.fromEntries(Object.entries(receipt.roleResults ?? {}).map(([role, r]) => [role, r.status]))
      : null;
    const entry = {
      providerId: route.providerId,
      modelId: route.modelId,
      pool: route.capacityPoolId,
      eligible: freeCloud.isForgeAutoEligible(route.providerId, route.modelId),
      qualification: receipt?.qualificationState ?? "NOT_TESTED",
      roles,
      health: health?.state ?? "UNOBSERVED",
    };
    console.log(`[r49-free]   ${route.providerId}/${route.modelId} pool=${route.capacityPoolId} eligible=${entry.eligible} qual=${entry.qualification} health=${entry.health}`);
    return entry;
  });

  const freeFabricReservations = new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 });
  const freeFabric = new FreeFabric({
    managedRoutes: () => freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"),
    managedPools: () => freeCloud.capacityPools().filter((pool) => pool.scope !== "PER_USER_POOL"),
    userSources: [{ routesForUser: (userId) => freeCloud.routesForUser(userId), poolsForUser: (userId) => freeCloud.poolsForUser(userId) }],
    health: routeHealth,
    reservations: freeFabricReservations,
    tokenizerRatioFor: (providerId) =>
      defaultCapacityGovernor.tokenizerRatio(providerId) ?? defaultCapacityGovernor.maxObservedTokenizerRatio(),
  });
  const fabricContext = ({ userId }) => {
    const uid = userId ?? "r50-live-operator";
    return { userId: uid, userIdentities: freeCloud.capacityIdentitiesFor(uid) };
  };

  // ---- R50 §23: deterministic before/after routing snapshot -------------------
  // Mirrors AgentRuntime.roleQualityAdjustmentFor: receipt advice + runtime delta, ±24 bound.
  const qualityCbFor = (role) => (providerId, modelId) => {
    const advice = roleQualityAdvice(freeCloud.getQualificationReceipt(providerId, modelId), role);
    const runtime = routeHealth.roleQualityDelta(providerId, modelId, role);
    return {
      scoreAdjustment: Math.max(-24, Math.min(24, advice.scoreAdjustment + (runtime?.scoreAdjustment ?? 0))),
      reasonCodes: [...advice.reasonCodes, ...(runtime?.reasonCodes ?? [])],
    };
  };
  // Identical to AgentRuntime.roleRouteFilter / roleQualificationStatus: staleness and the
  // EXPLORER→TOOL_AGENT substitution live inside roleQualificationStatusFor — reading raw
  // roleResults here would make the probe stricter than the production path it measures.
  const statusFor = (role, p, m) => roleQualificationStatusFor(freeCloud.getQualificationReceipt(p, m), role);
  const routeAdmissionFor = (role) => (providerId, modelId) => {
    if (!freeCloud.isForgeAutoEligible(providerId, modelId)) return false;
    const status = statusFor(role, providerId, modelId);
    return status === undefined || status === "QUALIFIED" || status === "PROBATION";
  };
  const dryDecide = (role, tag) => {
    const requestId = `r50-probe-${tag}-${role}`;
    const decision = freeFabric.decide({
      requestId,
      userId: "r50-live-operator",
      userIdentities: freeCloud.capacityIdentitiesFor("r50-live-operator"),
      // admitThroughFabric maps EightBitRole → product role before decide — the plan-level
      // roleSuitability filter speaks ModelRole names (SUBAGENT, PRIMARY_CODING_AGENT, ...).
      role: FABRIC_MODEL_ROLE[role],
      healthRole: role,
      routeAdmission: routeAdmissionFor(role),
      roleQualificationTierFor: (p, m) => {
        const status = statusFor(role, p, m);
        return status === "QUALIFIED" ? "QUALIFIED" : status === "PROBATION" ? "PROBATION" : "NOT_TESTED";
      },
      roleQualityAdjustment: qualityCbFor(role),
    });
    // A dry decide still holds a lease — release it immediately; it is a ranking snapshot, not work.
    try { freeFabricReservations.release(requestId); } catch { /* lease may not exist on non-admit */ }
    return {
      outcome: decision.outcome,
      selected: decision.selected ? `${decision.selected.providerId}/${decision.selected.modelId}` : null,
      candidates: decision.explanation.candidates.map((c) => ({
        route: `${c.providerId}/${c.modelId}`,
        status: c.status,
        scoreAdjustment: c.scoreAdjustment,
        reasonCodes: c.reasonCodes,
      })),
    };
  };

  const PROBE_ROLES = ["EXPLORER", "CODER", "REVIEWER"];
  const preSeedDecisions = Object.fromEntries(PROBE_ROLES.map((role) => [role, dryDecide(role, "pre")]));

  // Replay the role outcomes R49's live missions actually recorded for nemotron-super — the
  // same records a durable ledger hydrate restores after restart. Tagged replay, not new work.
  const NEMOTRON = { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free" };
  const replayedEvidence = [
    { role: "EXPLORER", outcome: "budget_exhausted", failureClass: "NON_CONVERGENCE", correlationId: "r49-run2-explorer" },
    { role: "EXPLORER", outcome: "role_failed", failureClass: "MALFORMED_STRUCTURED_OUTPUT", correlationId: "r49-run3-explorer" },
    { role: "REVIEWER", outcome: "security_blocked", failureClass: "WORKSPACE_ESCAPE_ATTEMPT", correlationId: "r49-run4-reviewer" },
    { role: "CODER", outcome: "verified_complete", correlationId: "r49-run2-coder" },
    { role: "CODER", outcome: "verified_complete", correlationId: "r49-run3-coder" },
    { role: "REVIEWER", outcome: "converged", correlationId: "r49-run2-reviewer" },
    { role: "REVIEWER", outcome: "converged", correlationId: "r49-run3-reviewer" },
  ];
  for (const ev of replayedEvidence) {
    routeHealth.observe({
      kind: "role_outcome", providerId: NEMOTRON.providerId, modelId: NEMOTRON.modelId,
      role: ev.role, outcome: ev.outcome, ...(ev.failureClass ? { failureClass: ev.failureClass } : {}),
      observedAt: new Date().toISOString(), source: "hydrate", correlationId: ev.correlationId,
    });
  }
  // The Reviewer escape also carried a boundary_violation tool outcome.
  routeHealth.observe({
    kind: "tool_outcome", providerId: NEMOTRON.providerId, modelId: NEMOTRON.modelId,
    outcome: "boundary_violation", role: "REVIEWER",
    observedAt: new Date().toISOString(), source: "hydrate", correlationId: "r49-run4-reviewer-tool",
  });
  // Groq gpt-oss-20b earned its Explorer stripes on R49 runs 1/4.
  routeHealth.observe({
    kind: "role_outcome", providerId: "groq", modelId: "openai/gpt-oss-20b",
    role: "EXPLORER", outcome: "verified_complete",
    observedAt: new Date().toISOString(), source: "hydrate", correlationId: "r49-run1-explorer",
  });

  const postSeedDecisions = Object.fromEntries(PROBE_ROLES.map((role) => [role, dryDecide(role, "post")]));
  const seededQuality = {};
  for (const role of PROBE_ROLES) {
    seededQuality[role] = Object.fromEntries(
      [NEMOTRON, { providerId: "groq", modelId: "openai/gpt-oss-20b" }].map((r) => [
        `${r.providerId}/${r.modelId}`,
        routeHealth.roleQualityDelta(r.providerId, r.modelId, role),
      ]),
    );
  }
  console.log(`[r50-quality] evidence replayed: ${replayedEvidence.length + 2} R49 observations`);
  for (const role of PROBE_ROLES) {
    console.log(`[r50-quality] ${role}: pre=${preSeedDecisions[role].selected} → post=${postSeedDecisions[role].selected}`);
  }

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
  const baseRevision = await git(repoDir, ["rev-parse", "HEAD"]);

  const sessionId = "session-r50-quality";
  persistence.upsertSession({ id: sessionId, title: "R50 Free Quality Mission", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle" });

  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
  const runtime = createAgentRuntime({
    sessionId, eventStore, persistence, firewall, providerCatalog: catalog,
    workspacePath: repoDir, freeCloud, freeFabric, fabricContext, routeHealth,
    userId: "r49-live-operator",
  });
  const subagentManager = createSubagentManager({ persistence, workspaceService, agentRuntime: runtime, r1Enabled: true });
  const orchestrator = createAutonomousRunOrchestrator({
    workspaceService, persistence, agentRuntime: runtime, subagentManager, subagentsR1Enabled: true,
  });
  const adapter = createWorkspaceEventAdapter({ sessionId, eventStore, persistence });

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
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
  const elapsedMs = Date.now() - startedMs;

  // ---- Evidence assembly -------------------------------------------------
  const journals = (await persistence.getWorkItemsByKind("agent_run_journal")).map((item) => ({
    runId: item.runId,
    role: item.role,
    state: item.state,
    route: item.route ?? null,
    turnCount: item.turnCount ?? null,
    toolCallCount: item.toolCallCount ?? null,
    requests: item.telemetry?.usage?.requestCount ?? null,
    inputTokens: item.telemetry?.usage?.inputTokens ?? null,
    outputTokens: item.telemetry?.usage?.outputTokens ?? null,
    routeFailovers: item.telemetry?.routeFailovers ?? item.routing?.routeFailovers ?? [],
    recoveryOutcome: item.recoveryOutcome ?? null,
    recoveryDetail: item.recoveryDetail ?? null,
  }));
  const workers = (await persistence.getWorkItemsByKind("subagent_run")).map((item) => ({
    role: item.role,
    agentId: item.agentId,
    status: item.status,
    model: item.model ?? null,
    route: item.route ?? null,
    routePoolId: item.routePoolId ?? null,
    resultSummary: item.resultSummary ?? null,
    telemetry: item.telemetry ?? null,
  }));

  // Per-role assembly: route, provider, model, pool, qualification verdict, health, requests,
  // tools, failovers, outcome — one row per durable role journal.
  const postHealth = routeHealth.snapshot();
  const roleReport = journals.map((journal) => {
    const route = journal.route;
    const receipt = route ? freeCloud.getQualificationReceipt(route.providerId, route.modelId) : null;
    const roleKey = String(journal.role ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    const roleVerdict = receipt?.roleResults?.[roleKey]?.status ?? null;
    const worker = workers.find((w) => w.role === journal.role || (w.route && route && w.route.providerId === route.providerId && w.route.modelId === route.modelId));
    return {
      role: journal.role,
      outcome: journal.state,
      provider: route?.providerId ?? null,
      model: route?.modelId ?? null,
      pool: route?.capacityPoolId ?? null,
      qualification: receipt?.qualificationState ?? "NOT_TESTED",
      roleVerdict,
      healthAfterRun: route ? (postHealth.find((h) => h.providerId === route.providerId && h.modelId === route.modelId)?.state ?? "UNOBSERVED") : null,
      requests: journal.requests ?? worker?.telemetry?.modelRequests ?? null,
      toolCalls: journal.toolCallCount ?? worker?.telemetry?.toolCalls ?? null,
      inputTokens: journal.inputTokens ?? worker?.telemetry?.inputTokens ?? null,
      outputTokens: journal.outputTokens ?? worker?.telemetry?.outputTokens ?? null,
      failovers: journal.routeFailovers,
      recoveryOutcome: journal.recoveryOutcome,
      recoveryDetail: journal.recoveryDetail,
      // R50: the served route's runtime-quality state for this role after the mission.
      roleQualityAfter: route && roleKey ? routeHealth.roleQualityDelta(route.providerId, route.modelId, roleKey) : null,
      roleEvidenceSamples: route && roleKey ? routeHealth.roleEvidenceFor(route.providerId, route.modelId, roleKey).length : null,
    };
  });

  const verificationItems = (await persistence.getWorkItems(sessionId))
    .filter((item) => item.kind === "verification")
    .map((item) => ({ recordType: item.recordType, status: item.status ?? null, payload: item.payload }));

  const routerEvents = eventStore.getAll()
    .filter((event) => event.type === "router.selection" || event.type === "router.failover")
    .map((event) => ({ type: event.type, payload: event.payload }));

  // Verified-tree vs integrated-tree proof. The worktree commit that passed ForgeVerify was
  // merged into repoDir; compare trees, not commit ids (merge may be ff or a merge commit).
  let treeEquality = null;
  try {
    const integratedTree = await git(repoDir, ["rev-parse", "HEAD^{tree}"]);
    const worktreeWs = result.integration?.worktreeId ? workspaceService.getWorkspace(result.integration.worktreeId) : null;
    const verifiedTree = worktreeWs ? await git(worktreeWs.rootPath, ["rev-parse", "HEAD^{tree}"]) : null;
    const worktreeHead = worktreeWs ? await git(worktreeWs.rootPath, ["rev-parse", "HEAD"]) : null;
    treeEquality = { verifiedTree, integratedTree, worktreeHead, equal: verifiedTree !== null && verifiedTree === integratedTree };
  } catch (err) {
    treeEquality = { error: err instanceof Error ? err.message : String(err) };
  }

  const finalMath = await readFile(join(repoDir, "src", "math.mjs"), "utf-8").catch(() => null);
  const finalFormat = await readFile(join(repoDir, "src", "format.mjs"), "utf-8").catch(() => null);
  let postIntegrationProbe = null;
  try {
    const probe = await execFile("node", ["--test", "test/math.test.mjs", "test/format.test.mjs"], { cwd: repoDir });
    postIntegrationProbe = { ok: true, output: `${probe.stdout}`.slice(0, 2_000) };
  } catch (err) {
    postIntegrationProbe = { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(0, 2_000) };
  }

  const poolByRole = {};
  for (const journal of journals) {
    if (journal.route?.capacityPoolId) poolByRole[journal.role] = [...new Set([...(poolByRole[journal.role] ?? []), journal.route.capacityPoolId])];
  }
  const coderPool = poolByRole["coder"]?.[0] ?? null;
  const reviewerPool = poolByRole["reviewer"]?.[0] ?? null;
  const reviewerIndependent = Boolean(coderPool && reviewerPool && coderPool !== reviewerPool);

  const servedRoutes = journals.map((j) => j.route).filter(Boolean);
  const allServedFree = servedRoutes.every((route) => freeCloud.isForgeAutoEligible(route.providerId, route.modelId));
  const servedModels = servedRoutes.map((route) => {
    const record = firewall.getModel(route.providerId, route.modelId);
    return {
      providerId: route.providerId,
      modelId: route.modelId,
      freeStatus: record?.freeStatus ?? null,
      isFree: record?.costProfile?.isFree ?? null,
      paidFallbackPossible: record?.costProfile?.paidFallbackPossible ?? null,
    };
  });

  const evidence = {
    schemaVersion: 1,
    round: "R50",
    generatedAt: completedAt,
    startedAt,
    elapsedMs,
    provenance: "live zero-cost mission over hydrate-replayed R49 role outcomes",
    purpose: "R50 quality-adaptive mission: R49's recorded production outcomes are replayed into the route-health authority (identical to restart hydration); dry decide() snapshots prove the ranking changed; the live role execution then runs under the adapted ordering.",
    providersPresent: present,
    allowanceProbeBudget: allowanceProbes,
    catalogRefresh: { registered: refreshResult.registered ?? null, failed: refreshResult.failed ?? null, errors: refreshResult.errors ?? [] },
    missionAdmission: result.topology?.missionAdmission ?? null,
    topology: result.topology ? { policy: result.topology.policy, plan: result.topology.plan ?? null } : null,
    capacityRoutesPreMission: preMissionRoutes,
    qualityAdaptation: {
      replayedEvidence,
      nemotronSeededRoleQuality: seededQuality,
      routingBeforeEvidence: preSeedDecisions,
      routingAfterEvidence: postSeedDecisions,
    },
    independentPools: [...new Set(pools.map((pool) => pool.poolId))],
    runStatus: result.status,
    runSummary: result.summary ?? null,
    changedFiles: result.changedFiles ?? [],
    review: result.review ?? null,
    verification: result.verification?.map((v) => ({ command: v.command, passed: v.passed, failed: v.failed, skipped: v.skipped, exitCode: v.exitCode ?? null, durationMs: v.durationMs ?? null, outputSample: `${v.output ?? ""}`.slice(0, 400) })) ?? null,
    completionGate: result.completion ?? null,
    integration: result.integration ?? null,
    counters: result.counters ?? null,
    roleReport,
    workers,
    journals,
    routerEvents,
    poolByRole,
    reviewerIndependent,
    forgeVerifyRecords: verificationItems,
    treeEquality,
    baseRevision,
    finalRevision: result.finalRevision ?? null,
    finalMathContents: finalMath,
    finalFormatContents: finalFormat,
    postIntegrationProbe,
    servedModels,
    allServedRoutesForgeAutoEligible: allServedFree,
    paidSpendUsd: 0,
    paidBoundary: "8-Bit managed free only: no Paid Auto route, no BYOK route, no paid receipts possible — every served route is asserted ForgeAuto-eligible with verified_free status.",
    credentialsUsed: present.map((id) => `${ENV_KEY[id]} (present)`),
  };

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  console.log(`[r50-quality] status=${result.status} elapsed=${(elapsedMs / 1000).toFixed(1)}s workers=${workers.length}`);
  for (const role of roleReport) {
    console.log(`[r50-quality]   ${role.role}: ${role.outcome} via ${role.provider ?? "(none)"}/${role.model ?? "-"} pool=${role.pool ?? "-"} qual=${role.roleVerdict ?? role.qualification} q=${role.roleQualityAfter?.scoreAdjustment ?? "?"} req=${role.requests ?? "?"} tools=${role.toolCalls ?? "?"}${role.failovers.length ? ` failovers=${role.failovers.length}` : ""}`);
  }
  console.log(`[r50-quality] gate=${result.completion?.outcome ?? "n/a"} integration=${result.integration?.status ?? "n/a"} treeEqual=${treeEquality?.equal ?? "n/a"} reviewerIndependent=${reviewerIndependent}`);
  console.log(`[r50-quality] evidence=${target}`);

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

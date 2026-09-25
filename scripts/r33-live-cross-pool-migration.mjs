// R33 Mission E/F/G — live capacity-transition proof (cross-pool migration when a second
// admissible pool exists; wait→recovery→completion when pool A is the only admissible pool —
// both outcomes are recorded honestly by the waitTrace/waitRecovery evidence fields).
//
//   node scripts/r33-live-cross-pool-migration.mjs [--out=<file>] [--task=<slug>]
//
// Drives a REAL workflow task through the production path — AgentRuntime, WorkflowService,
// FreeFabric decide, CapacityReservationLedger, route health authority, completion gate —
// with REAL provider adapters (Groq, Mistral, GitHub Models via the stock OpenAI-compatible
// transport). The only synthetic element is a one-call RATE_LIMITED injection on the first
// provider after useful progress, which is exactly the signal a real 429 produces. Every
// successful model call is real inference billed against real free quota.
//
// Evidence records which quota pool served implementation, which served continuation, which
// served review, the failover receipt, and the completion-gate verdict — never credentials,
// prompts, or model text.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", "docs/evidence/r33-free-capacity-fabric/live-supply/cross-pool-migration-2026-09-25.json");
const deadlineMs = Number(option("deadline-ms", "1200000"));
const log = (msg) => console.error(`[r33-live-migration ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const { ForgeZero, createGenericFreeRecord, CapacityReservationLedger } = await import("@codeforge/forge-zero");
const { InMemoryProviderCatalog, createGroqAdapter, createMistralAdapter, OpenAICompatibleAdapter, ProviderError } = await import("@codeforge/providers");
const { EventStore, createSessionPersistence } = await import("@codeforge/sessions");
const { createEightBitRouteHealthAuthority, createFreeFabric } = await import("@codeforge/eight-bit");
const { createTaskAuthority } = await import("@codeforge/permissions");
const { createAgentRuntime, WorkflowService } = await import("@codeforge/server");

const OBSERVED_AT = new Date().toISOString();
const NO_RESET = "9999-12-31T23:59:59.999Z";
const FABRIC_ROLES = ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"];

/** Passthrough wrapper: real calls flow to the wrapped adapter until failNext(n) arms a
 * one-shot RATE_LIMITED — the real-equivalent provider-pressure signal, injected without
 * burning quota. */
class InjectOnceAdapter {
  constructor(inner) {
    this.inner = inner;
    this.providerId = inner.providerId;
    this.isTestProvider = inner.isTestProvider;
    this.armed = false;
    this.injections = 0;
    this.servedStreams = 0;
    this.usage = [];
  }
  failNextCall() { this.armed = true; }
  listModels() { return this.inner.listModels(); }
  healthCheck() { return this.inner.healthCheck(); }
  async chat(req) { return this.inner.chat(req); }
  async *streamChat(req, signal) {
    if (this.armed) {
      this.armed = false;
      this.injections += 1;
      // Wording matters: the health authority maps "quota"/"daily" phrasing to a 6h
      // DAILY_QUOTA_EXHAUSTED exclusion. A real per-minute 429 carries no such phrasing,
      // so the injection must not either — 60s RATE_LIMITED is the honest equivalent.
      throw new ProviderError(`${this.providerId} request rate limited (429): rate limit exceeded, please retry later`, "RATE_LIMITED", true, { status: 429 });
    }
    this.servedStreams += 1;
    const promptChars = (req.system?.length ?? 0) + req.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
    for await (const ev of this.inner.streamChat(req, signal)) {
      if (ev.type === "usage" && ev.usage) {
        this.usage.push({ promptChars, inputTokens: ev.usage.inputTokens ?? null, outputTokens: ev.usage.outputTokens ?? null });
      }
      yield ev;
    }
  }
}

function routeFor(providerId, modelId, qualityScore, windows, overrides = {}) {
  return {
    routeId: `fabric:${providerId}/${modelId}`,
    providerId,
    modelId,
    canonicalModelId: modelId,
    family: providerId,
    gateway: providerId,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `shared:${providerId}`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: FABRIC_ROLES,
    qualityScore,
    healthy: true,
    enabled: true,
    windows,
    ...overrides,
  };
}

function poolFor(route) {
  return {
    poolId: route.capacityPoolId,
    providerId: route.providerId,
    scope: route.capacityPoolScope,
    supplyClass: route.supplyClass,
    windows: route.windows,
    observedAt: OBSERVED_AT,
    authoritative: route.windows.length > 0,
  };
}

const win = (unit, limit, remaining) => ({
  unit, limit, remaining, resetAt: NO_RESET, scope: "ORG", observedAt: OBSERVED_AT, authoritative: true,
});

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: "LIVE_INFERENCE_WITH_ONE_INJECTED_RATE_LIMIT",
    note: "All successful model calls are real provider inference. Exactly one RATE_LIMITED is injected on pool A after useful progress — the same signal a real 429 produces. No quota was burned to force exhaustion.",
    providers: {},
    turns: [],
    migration: null,
    review: null,
    completion: null,
    errors: [],
  };

  const have = (name) => Boolean(process.env[name]?.trim());
  const missing = ["GROQ_API_KEY", "MISTRAL_API_KEY", "GITHUB_MODELS_TOKEN"].filter((n) => !have(n));
  if (missing.length) {
    evidence.errors.push(`EXTERNAL_AUTHORIZATION_REQUIRED: missing ${missing.join(", ")}`);
    await emit();
    process.exit(2);
  }

  // Workspace: a trivially fixable bug a real model can complete in a few turns.
  const tmpDir = await mkdtemp(join(os.tmpdir(), "cf-r33-live-"));
  await mkdir(join(tmpDir, "src"), { recursive: true });
  await writeFile(join(tmpDir, "src", "calc.ts"), "export function add(a:number,b:number){return a-b}\n");
  await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));

  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  const catalog = new InMemoryProviderCatalog();
  const authority = createEightBitRouteHealthAuthority();

  const MODELS = {
    groq: "openai/gpt-oss-20b",
    mistral: "codestral-latest",
    "github-models": "openai/gpt-4.1-mini",
  };

  for (const [providerId, modelId] of Object.entries(MODELS)) {
    firewall.register(createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}` }));
  }

  const groq = new InjectOnceAdapter(createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 90_000 }));
  const mistral = new InjectOnceAdapter(createMistralAdapter({ apiKey: process.env.MISTRAL_API_KEY, timeoutMs: 90_000 }));
  const github = new InjectOnceAdapter(new OpenAICompatibleAdapter({
    providerId: "github-models",
    baseUrl: "https://models.github.ai/inference",
    apiKey: process.env.GITHUB_MODELS_TOKEN,
    timeoutMs: 90_000,
  }));
  catalog.register(groq);
  catalog.register(mistral);
  catalog.register(github);

  // Measured live windows (INVENTORY-2026-09-24): Groq per-model 1000 req/8000 TPM,
  // Mistral codestral 125 RPM/625k TPM. GitHub Models exposes no quota headers —
  // unknown stays unknown (no windows), never invented.
  const routes = [
    routeFor("groq", MODELS.groq, 95, [win("requests", 1000, 1000), win("input_tokens", 8000, 8000)]),
    routeFor("mistral", MODELS.mistral, 80, [win("requests", 125, 125), win("input_tokens", 625_000, 625_000)]),
    routeFor("github-models", MODELS["github-models"], 60, []),
  ];
  const pools = routes.map(poolFor);

  // R34 Mission D: auto-detect which pools can actually admit this task BEFORE driving it.
  // A real CapacityReservationLedger over the same topology is the production admission
  // code — a probe reservation per pool answers "is there a second pool?" without inventing
  // capacity math. The demand bound covers the measured interactive-turn demand post-Mission E
  // (~3-4k input + 2048 output); a windowless pool (GitHub Models) is inadmissible by
  // construction — the ledger reads absent input windows as zero, never invented supply.
  const probeLedger = new CapacityReservationLedger({
    routes,
    pools,
    firstRunReserveRequests: 0,
    firstRunReserveTokens: 0,
    maxActiveReservationsPerUser: 10,
  });
  const probeDemand = { requests: 1, inputTokens: 4096, outputTokens: 2048 };
  evidence.supplyProbe = {
    demand: probeDemand,
    pools: routes.map((route) => {
      const res = probeLedger.reserve({
        reservationId: `probe-${route.routeId}`,
        routeIds: [route.routeId],
        userId: "supply-probe",
        role: "PRIMARY_CODING_AGENT",
        taskKind: "interactive_turn",
        ...probeDemand,
        isNewUser: false,
        priority: "normal",
        createdAt: OBSERVED_AT,
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      if (res.admitted) probeLedger.release(res.reservationId);
      return { poolId: route.capacityPoolId, providerId: route.providerId, admissible: res.admitted, reason: res.reason ?? null };
    }),
  };
  const admissiblePools = evidence.supplyProbe.pools.filter((p) => p.admissible).map((p) => p.poolId);
  evidence.supplyProbe.admissiblePools = admissiblePools;
  evidence.supplyProbe.classification = admissiblePools.length >= 2 ? "MULTI_POOL_ADMISSIBLE" : "BLOCKED_BY_AVAILABLE_SUPPLY";
  log(`supply probe: ${admissiblePools.length} admissible pool(s) → ${evidence.supplyProbe.classification} (${admissiblePools.join(", ") || "none"})`);
  const fabric = createFreeFabric({
    managedRoutes: () => routes,
    managedPools: () => pools,
    userSources: [],
    health: authority,
    reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
  });

  const workspacePath = tmpDir;
  const sessionId = "sess-r33-live-migration";
  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall,
    providerCatalog: catalog,
    workspacePath,
    routeHealth: authority,
    freeFabric: fabric,
    fabricContext: () => ({ userId: "user-r33-live", userIdentities: [] }),
    authorityFor: () => createTaskAuthority({
      sessionId,
      workspaceRoot: workspacePath,
      permissionMode: "full_autonomy",
      planMode: "auto",
      grants: [],
      createdAt: new Date().toISOString(),
    }),
  });

  const service = new WorkflowService({
    eventStore,
    persistence,
    workspacePath,
    getOrCreateRuntime: () => runtime,
    useRealRuntime: () => true,
    capacityWaitPollMs: 500,
    agentWorkingBudgetMs: deadlineMs,
    authorityFor: () => createTaskAuthority({
      sessionId,
      workspaceRoot: workspacePath,
      permissionMode: "full_autonomy",
      planMode: "auto",
      grants: [],
      createdAt: new Date().toISOString(),
    }),
  });
  await service.init();

  const { taskId } = await service.startWorkflow({
    sessionId,
    message: "Read src/calc.ts and fix add() so it returns a + b instead of a - b. Then run the verification command.",
    workspacePath,
    verificationCommands: ['node -e "const fs=require(\'fs\');const s=fs.readFileSync(\'src/calc.ts\',\'utf8\');process.exit(/a\\s*\\+\\s*b/.test(s)?0:1)"'],
  });
  log(`workflow started taskId=${taskId}`);
  await emit();

  // Arm the injection on whichever pool the fabric admitted first — the broker owns that
  // decision, and the proof is that it re-decides onto a different pool afterwards.
  const adapters = { groq, mistral, "github-models": github };
  let armed = false;
  let poolA = null;
  const started = Date.now();
  const entry = service.getWorkflow(taskId);
  let lastLog = 0;
  evidence.waitTrace = [];
  const tracePoll = setInterval(async () => {
    try {
      for (const t of await persistence.getTurns(sessionId)) {
        const rt = runtime.getTurn(t.id);
        const last = evidence.waitTrace[evidence.waitTrace.length - 1];
        if (!last || last.turnId !== t.id || last.status !== t.status || last.providerId !== (rt?.providerId ?? null)) {
          evidence.waitTrace.push({ t: Date.now() - started, turnId: t.id, status: t.status, providerId: rt?.providerId ?? null, capacityPoolId: rt?.capacityPoolId ?? null });
        }
      }
    } catch { /* tracing must never break the proof */ }
  }, 500);
  tracePoll.unref?.();
  while (!armed && Date.now() - started < deadlineMs) {
    const serving = Object.entries(adapters).find(([, a]) => a.servedStreams >= 1);
    if (serving) {
      const [name, adapter] = serving;
      poolA = name;
      adapter.failNextCall();
      armed = true;
      evidence.migration = { poolA, injectedAfterServedStreams: adapter.servedStreams, injection: `RATE_LIMITED once on ${name}`, admissiblePools, supplyClassification: evidence.supplyProbe.classification };
      log(`injected RATE_LIMITED on ${name} after ${adapter.servedStreams} served stream(s)`);
      await emit();
      break;
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const phase = service.getWorkflow(taskId)?.task?.phase;
      log(`waiting for pool-A progress… phase=${phase} groq.streams=${groq.servedStreams} mistral.streams=${mistral.servedStreams} github.streams=${github.servedStreams}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const result = await Promise.race([
    entry.promise.then((r) => { log(`workflow resolved phase=${r.phase}`); return r; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`workflow exceeded ${deadlineMs}ms deadline`)), deadlineMs)),
  ]).catch((err) => ({ phase: "harness_error", status: String(err?.message ?? err) }));
  clearInterval(tracePoll);

  // Collect the truth: which pool served which phase.
  const turnIds = (await persistence.getTurns(sessionId)).map((t) => t.id);
  for (const id of turnIds) {
    const t = runtime.getTurn(id);
    if (!t) continue;
    evidence.turns.push({
      turnId: t.turnId,
      status: t.status,
      providerId: t.providerId,
      modelId: t.modelId,
      capacityPoolId: t.capacityPoolId ?? null,
    });
  }
  evidence.served = {
    groq: { streams: groq.servedStreams, injections: groq.injections, usage: groq.usage },
    mistral: { streams: mistral.servedStreams, injections: mistral.injections, usage: mistral.usage },
    "github-models": { streams: github.servedStreams, injections: github.injections, usage: github.usage },
  };
  const implTurn = evidence.turns.find((t) => t.capacityPoolId && t.capacityPoolId !== `shared:${poolA}`) ?? evidence.turns[0];
  const reviewTurn = evidence.turns.find((t) => implTurn && t.turnId !== implTurn.turnId);
  // Pool B auto-detection: any adapter other than pool A that served a stream AFTER the
  // injection armed is physical proof the broker re-decided onto different quota.
  const injectedAtStreams = poolA ? adapters[poolA].servedStreams : 0;
  const poolBServed = Object.entries(adapters).find(([name, a]) => name !== poolA && a.servedStreams > 0);
  evidence.review = reviewTurn
    ? { providerId: reviewTurn.providerId, capacityPoolId: reviewTurn.capacityPoolId, independentOfImplementation: reviewTurn.capacityPoolId !== (implTurn?.capacityPoolId ?? null) }
    : { independentOfImplementation: false, note: "no distinct review turn observed" };
  const finalCalc = await readFile(join(tmpDir, "src", "calc.ts"), "utf8").catch(() => "");
  const poolB = implTurn?.capacityPoolId ?? null;

  // Wait→recovery proof (distinct from migration): a turn that entered
  // waiting_for_free_capacity and later left it resumed on real supply — the durable
  // park→probe→resume path running live, even when pool A is the pool that recovers.
  const waitEntry = evidence.waitTrace.find((e) => e.status === "waiting_for_free_capacity");
  const waitExit = waitEntry && evidence.waitTrace.find((e) => e.turnId === waitEntry.turnId && e.t > waitEntry.t && e.status !== "waiting_for_free_capacity");
  evidence.waitRecovery = waitEntry
    ? {
        parked: true,
        parkedAtMs: waitEntry.t,
        resumed: Boolean(waitExit),
        resumedStatus: waitExit?.status ?? null,
        resumedPoolId: waitExit?.capacityPoolId ?? null,
        waitMs: waitExit ? waitExit.t - waitEntry.t : null,
      }
    : { parked: false };

  // Migration can only be certified when the supply probe found a second admissible pool —
  // otherwise "not migrated" is a supply statement, not a failover failure. The evidence
  // distinguishes BLOCKED_BY_AVAILABLE_SUPPLY (topology couldn't offer a second pool) from
  // FAILOVER_FAILED (a second pool existed and the broker still stranded the turn).
  const multiPool = admissiblePools.length >= 2;
  const migrationProven = Boolean(poolA && poolB && poolB !== `shared:${poolA}` && adapters[poolB?.replace("shared:", "")]?.servedStreams > 0);
  evidence.completion = {
    phase: result.phase ?? "unknown",
    status: result.status ?? "unknown",
    fileFixed: /a\s*\+\s*b/.test(finalCalc),
    poolA,
    poolB,
    poolBServedStreams: poolBServed ? poolBServed[1].servedStreams : 0,
    poolAStreamsAtInjection: injectedAtStreams,
    admissiblePools,
    supplyClassification: evidence.supplyProbe.classification,
    migrationProven,
    migrationVerdict: migrationProven
      ? "MIGRATION_PROVEN"
      : multiPool
        ? "FAILOVER_FAILED"
        : "BLOCKED_BY_AVAILABLE_SUPPLY",
  };

  await runtime.shutdown().catch(() => {});
  await persistence.close().catch(() => {});
  await emit();

  async function emit() {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

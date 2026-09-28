// R52 live production-scale missions: real zero-cost multi-role runs through the production
// routing stack, exercising the capacity fabric end to end —
//
//   FreeCloudService (real account pools) → FreeFabric admission → demand-driven
//   probeRouteCapacity on unmeasured quota domains → role execution → ForgeVerify →
//   completion gate → integration.
//
// Scenarios:
//   unmeasured        — refresh runs with zero bootstrap probes: every quota domain starts
//                       unmeasured, so the first admission denies CAPACITY_UNMEASURED.
//                       Re-proves the R51 seam on the R52 tree.
//   healthy           — normal bootstrap probes; supply measured before the mission.
//   reviewer-scarcity — every REVIEWER-capable route but one is health-blocked; the
//                       surviving reviewer must serve or the run fails honestly.
//   provider-outage   — every route of the provider with the most eligible routes is
//                       rate-limited; the mission must complete on another provider.
//   multi-step        — a three-file mission (multiply + format + median) driving
//                       explorer + coder + reviewer through more turns.
//
//   node scripts/r52-capacity-mission.mjs --scenario=unmeasured [--out=<file>] [--keep]
//                                        [--qual-db=<path>] [--timeout-ms=600000]
//
// Credentials are read from the environment by presence only; values are never printed or
// persisted. Evidence lands under docs/evidence/r52-production-scale/.
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
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
const scenario = option("scenario", "unmeasured");
const out = option("out", `docs/evidence/r52-production-scale/R52-LIVE-MISSION-${scenario.toUpperCase()}.json`);
const keep = args.includes("--keep");
const syntheticConsent = args.includes("--synthetic-consent");
const qualDbPath = option("qual-db", join(tmpdir(), "r46-qualification.db"));
const timeoutMs = Number(option("timeout-ms", "600000"));
const allowanceProbes = Number(option("allowance-probes", scenario === "unmeasured" ? "0" : "8"));
const roleEvidenceFrom = option("role-evidence-from", "");
const capacityEvidenceFrom = option("capacity-evidence-from", "");
const complexityHint = option("complexity-hint", "");
const evidenceRound = option("round", scenario === "feature" || scenario === "refactor" ? "R53" : "R52");

const PROVIDERS = ["groq", "mistral", "openrouter", "cerebras"];
const ENV_KEY = { groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", openrouter: "OPENROUTER_API_KEY", cerebras: "CEREBRAS_API_KEY" };

async function git(cwd, gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { cwd });
  return stdout.trim();
}

async function main() {
  const present = PROVIDERS.filter((id) => (process.env[ENV_KEY[id]] ?? "").trim().length > 0);
  if (present.length === 0) {
    throw new Error(`No provider credentials present (need at least one of ${Object.values(ENV_KEY).join(", ")})`);
  }
  console.log(`[r52] scenario=${scenario} providers with credentials: ${present.join(", ")}`);

  const repoDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "r51-repo-"));
  const worktreeBaseDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "r51-wt-"));

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
  console.log(`[r52] adapters: ${adapters.map((a) => a.providerId).join(", ")}`);

  const refresh = freeCloud.createCatalogRefresh({ maxAllowanceProbes: allowanceProbes, requireCredentials: true });
  const refreshResult = await refresh.refresh();
  console.log(`[r52] catalog refresh: ${refreshResult.errors.length} notices (allowance probe budget=${allowanceProbes})`);
  for (const adapter of adapters) {
    freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ENVIRONMENT", authState: "ok", planAttested: true });
  }

  const qualDb = createSessionPersistence({ dbPath: qualDbPath });
  await qualDb.init();
  freeCloud.attachQualificationStore(new SqliteQualificationPersistence(qualDb));
  const restored = await freeCloud.loadQualification();
  console.log(`[r52] qualification receipts restored: ${restored}`);

  let replayedRoleEvidence = null;
  if (roleEvidenceFrom) {
    replayedRoleEvidence = [];
    for (const source of roleEvidenceFrom.split(",").filter(Boolean)) {
      const prior = JSON.parse(await readFile(resolve(source), "utf-8"));
      const coders = (prior.roleReport ?? []).filter((item) =>
        item.role === "coder"
        && item.provider
        && item.model
        && item.outcome === "converged_failed"
        && /(?:budget_exhausted|no_progress_detected|tool_loop_detected)/.test(item.recoveryDetail ?? "")
      );
      if (prior.runStatus !== "blocked" || coders.length === 0) {
        throw new Error("Role-evidence replay requires a blocked mission with a witnessed Coder non-convergence.");
      }
      for (const coder of coders) {
        routeHealth.observe({
          kind: "role_outcome",
          providerId: coder.provider,
          modelId: coder.model,
          role: "CODER",
          outcome: "budget_exhausted",
          failureClass: "NON_CONVERGENCE",
          source: "runtime",
          observedAt: new Date().toISOString(),
          correlationId: `replay:${prior.baseRevision}:${prior.scenario}:${coder.model}`,
        });
        replayedRoleEvidence.push({
          source,
          providerId: coder.provider,
          modelId: coder.model,
          role: "CODER",
          outcome: "budget_exhausted",
          failureClass: "NON_CONVERGENCE",
        });
      }
    }
  }
  let replayedCapacityEvidence = [];
  if (capacityEvidenceFrom) {
    for (const source of capacityEvidenceFrom.split(",").filter(Boolean)) {
      const prior = JSON.parse(await readFile(resolve(source), "utf-8"));
      const witnessed = new Map();
      for (const row of prior.rows ?? []) {
        if (row.providerId && row.modelId && Object.values(row.receipt?.roleResults ?? {}).some((role) =>
          (role.cases ?? []).some((testCase) => testCase.errorKind === "RATE_LIMITED")
        )) {
          witnessed.set(`${row.providerId}/${row.modelId}`, { providerId: row.providerId, modelId: row.modelId, reason: "RATE_LIMITED" });
        }
      }
      for (const report of prior.roleReport ?? []) {
        for (const failover of report.failovers ?? []) {
          if (failover.reason !== "RATE_LIMITED" && failover.reason !== "TEMPORARY_CAPACITY") continue;
          const separator = failover.from.indexOf("/");
          if (separator < 1) continue;
          const providerId = failover.from.slice(0, separator);
          const modelId = failover.from.slice(separator + 1);
          witnessed.set(`${providerId}/${modelId}`, { providerId, modelId, reason: failover.reason });
        }
      }
      for (const worker of prior.workers ?? []) {
        if (!worker.model?.providerId || !worker.model?.modelId) continue;
        const reason = /RATE_LIMITED|429/.test(worker.resultSummary ?? "")
          ? "RATE_LIMITED"
          : /PROVIDER_UNAVAILABLE|503|overload/i.test(worker.resultSummary ?? "")
            ? "TEMPORARY_CAPACITY"
            : null;
        if (reason) witnessed.set(`${worker.model.providerId}/${worker.model.modelId}`, {
          providerId: worker.model.providerId,
          modelId: worker.model.modelId,
          reason,
        });
      }
      if (witnessed.size === 0) {
        throw new Error(`Capacity-evidence replay found no witnessed provider capacity failure in ${source}.`);
      }
      for (const item of witnessed.values()) {
        routeHealth.observe({
          kind: "call_failure",
          providerId: item.providerId,
          modelId: item.modelId,
          reason: item.reason,
          observedAt: new Date().toISOString(),
          source: "runtime",
          correlationId: `capacity-replay:${prior.generatedAt}:${item.modelId}`,
        });
        replayedCapacityEvidence.push({ source, ...item });
      }
    }
  }

  const routes = freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL");
  const pools = freeCloud.capacityPools().filter((pool) => pool.scope !== "PER_USER_POOL");
  console.log(`[r52] capacity routes: ${routes.length} across ${pools.length} pools`);

  // Quota observation snapshot — the core R51 evidence. Route windows are what the
  // reservation ledger reads: non-empty = measured. Re-projects each call because
  // capacityRoutes() derives windows from the live quota tracker. In `unmeasured`
  // scenario every route should start with zero windows; in `healthy` most should be
  // measured.
  const quotaSnapshot = () => {
    const observed = [];
    const unmeasured = [];
    for (const route of freeCloud.capacityRoutes().filter((r) => r.capacityPoolScope !== "PER_USER_POOL")) {
      (route.windows.length > 0 ? observed : unmeasured).push(`${route.providerId}/${route.modelId}`);
    }
    return { observed, unmeasured };
  };
  const quotaBefore = quotaSnapshot();
  console.log(`[r52] quota domains observed=${quotaBefore.observed.length} unmeasured=${quotaBefore.unmeasured.length}`);

  const preMissionRoutes = routes.map((route) => {
    const receipt = freeCloud.getQualificationReceipt(route.providerId, route.modelId);
    const health = routeHealth.snapshot().find((h) => h.providerId === route.providerId && h.modelId === route.modelId);
    const entry = {
      providerId: route.providerId,
      modelId: route.modelId,
      pool: route.capacityPoolId,
      eligible: freeCloud.isForgeAutoEligible(route.providerId, route.modelId),
      qualification: receipt?.qualificationState ?? "NOT_TESTED",
      roles: receipt ? Object.fromEntries(Object.entries(receipt.roleResults ?? {}).map(([role, r]) => [role, r.status])) : null,
      health: health?.state ?? "UNOBSERVED",
    };
    console.log(`[r52]   ${route.providerId}/${route.modelId} pool=${route.capacityPoolId} eligible=${entry.eligible} qual=${entry.qualification} health=${entry.health}`);
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
    const uid = userId ?? "r52-live-operator";
    return {
      userId: uid,
      userIdentities: freeCloud.capacityIdentitiesFor(uid),
      ...(syntheticConsent ? { dataContext: { dataClass: "SYNTHETIC", userConsented: true } } : {}),
    };
  };

  // ---- R52 scenario seeding ------------------------------------------------
  if (scenario === "reviewer-scarcity") {
    // Every REVIEWER-capable route but one is rate-limited — the survivor must serve or the
    // run fails honestly. Picking the survivor deterministically keeps the run auditable.
    const reviewerCapable = preMissionRoutes.filter((r) => r.eligible && (r.roles?.REVIEWER === "QUALIFIED" || r.roles?.REVIEWER === "PROBATION"));
    const survivor = reviewerCapable[0];
    for (const route of reviewerCapable.slice(1)) {
      routeHealth.observe({
        kind: "call_failure", providerId: route.providerId, modelId: route.modelId,
        reason: "RATE_LIMITED", observedAt: new Date().toISOString(), source: "test", correlationId: `r52-scarcity-${route.modelId}`,
      });
    }
    console.log(`[r52] reviewer-scarcity: ${reviewerCapable.length - 1} reviewer routes rate-limited; survivor=${survivor ? `${survivor.providerId}/${survivor.modelId}` : "(none)"}`);
  }
  if (scenario === "provider-outage") {
    // The provider holding the most eligible routes loses every route to 429s — the mission
    // must complete on a different provider or report honest scarcity.
    const byProvider = new Map();
    for (const r of preMissionRoutes.filter((r) => r.eligible)) {
      byProvider.set(r.providerId, [...(byProvider.get(r.providerId) ?? []), r]);
    }
    const [providerId, providerRoutes] = [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    for (const route of providerRoutes ?? []) {
      routeHealth.observe({
        kind: "call_failure", providerId: route.providerId, modelId: route.modelId,
        reason: "RATE_LIMITED", observedAt: new Date().toISOString(), source: "test", correlationId: `r52-outage-${route.modelId}`,
      });
    }
    console.log(`[r52] provider-outage: ${providerRoutes?.length ?? 0} routes on ${providerId ?? "(none)"} rate-limited`);
  }

  // ---- Deterministic admission snapshot ------------------------------------
  const statusFor = (role, p, m) => roleQualificationStatusFor(freeCloud.getQualificationReceipt(p, m), role);
  const routeAdmissionFor = (role) => (providerId, modelId) => {
    if (!freeCloud.isForgeAutoEligible(providerId, modelId)) return false;
    const status = statusFor(role, providerId, modelId);
    return status === undefined || status === "QUALIFIED" || status === "PROBATION";
  };
  const dryDecide = (role, tag) => {
    const requestId = `r52-probe-${tag}-${role}`;
    const decision = freeFabric.decide({
      requestId,
      userId: "r52-live-operator",
      userIdentities: freeCloud.capacityIdentitiesFor("r52-live-operator"),
      role: FABRIC_MODEL_ROLE[role],
      healthRole: role,
      routeAdmission: routeAdmissionFor(role),
      roleQualificationTierFor: (p, m) => {
        const status = statusFor(role, p, m);
        return status === "QUALIFIED" ? "QUALIFIED" : status === "PROBATION" ? "PROBATION" : "NOT_TESTED";
      },
    });
    try { freeFabricReservations.release(requestId); } catch { /* lease may not exist on non-admit */ }
    return {
      outcome: decision.outcome,
      nextAvailableAt: decision.nextAvailableAt ?? null,
      selected: decision.selected ? `${decision.selected.providerId}/${decision.selected.modelId}` : null,
      reasonCodes: decision.explanation.reasonCodes ?? [],
      candidates: decision.explanation.candidates.map((c) => ({
        route: `${c.providerId}/${c.modelId}`,
        status: c.status,
        pool: c.capacityPoolId ?? null,
        reasonCodes: c.reasonCodes,
      })),
    };
  };
  const PROBE_ROLES = ["EXPLORER", "CODER", "REVIEWER"];
  const preMissionDecisions = Object.fromEntries(PROBE_ROLES.map((role) => [role, dryDecide(role, "pre")]));
  for (const role of PROBE_ROLES) {
    const d = preMissionDecisions[role];
    console.log(`[r52] pre-decide ${role}: outcome=${d.outcome} selected=${d.selected ?? "-"} unmeasured=${d.candidates.filter((c) => c.status === "CAPACITY_UNMEASURED").length}`);
  }

  // ---- Mission repository --------------------------------------------------
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "CodeForge Agent"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "agent@codeforge.local"], { cwd: repoDir });
  await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module", scripts: { test: "node --test" } }), "utf-8");
  await writeFile(join(repoDir, "README.md"), "# math-lib\n\nTiny math utilities. Run `npm test`.\n", "utf-8");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(join(repoDir, "src", "math.mjs"), ["feature", "refactor", "cross-package"].includes(scenario) ? "export function multiply(a, b) { return a * b; }\n\nexport function add(a, b) { return a + b; }\n" : "export function multiply(a, b) { return 0; }\n\nexport function add(a, b) { return a + b; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "format.mjs"), ["feature", "refactor", "cross-package"].includes(scenario) ? "export function format(value) { return `result: ${value}`; }\n" : "export function format(value) { return `value: ${value}`; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "stats.mjs"), "export function mean(values) { if (values.length === 0) return 0; return values.reduce((a, b) => a + b, 0) / values.length; }\n", "utf-8");
  await writeFile(join(repoDir, "src", "index.mjs"), "export { multiply, add } from './math.mjs';\nexport { format } from './format.mjs';\nexport { mean } from './stats.mjs';\n", "utf-8");
  await writeFile(join(repoDir, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../src/math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n", "utf-8");
  await writeFile(join(repoDir, "test", "format.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { format } from '../src/format.mjs';\ntest('format', () => assert.equal(format(42), 'result: 42'));\n", "utf-8");
  await writeFile(join(repoDir, "test", "stats.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean } from '../src/stats.mjs';\ntest('mean', () => assert.equal(mean([2, 4, 6]), 4));\n", "utf-8");
  if (scenario === "multi-step") {
    // Third file with its own bug and test — explorer must map three targets, the coder
    // must edit three files, the reviewer must verify all of it: more turns, more roles.
    await writeFile(join(repoDir, "src", "median.mjs"), "export function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[0]; }\n", "utf-8");
    await writeFile(join(repoDir, "test", "median.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { median } from '../src/median.mjs';\ntest('median odd', () => assert.equal(median([3, 1, 2]), 2));\ntest('median even', () => assert.equal(median([4, 1, 3, 2]), 2.5));\n", "utf-8");
  }
  if (scenario === "feature") {
    await writeFile(join(repoDir, "src", "cart.mjs"), "export function subtotalCents(items) { return 0; }\n", "utf-8");
    await writeFile(join(repoDir, "src", "coupons.mjs"), "export function applyCoupon(totalCents, coupon) { return totalCents; }\n", "utf-8");
    await writeFile(join(repoDir, "test", "cart.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { subtotalCents } from '../src/cart.mjs';\ntest('quantity-aware subtotal', () => assert.equal(subtotalCents([{ unitCents: 199, quantity: 2 }, { unitCents: 50, quantity: 1 }]), 448));\ntest('empty cart', () => assert.equal(subtotalCents([]), 0));\ntest('negative quantity is rejected', () => assert.throws(() => subtotalCents([{ unitCents: 100, quantity: -1 }])));\n", "utf-8");
    await writeFile(join(repoDir, "test", "coupons.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyCoupon } from '../src/coupons.mjs';\ntest('SAVE10 rounds to cents', () => assert.equal(applyCoupon(448, 'SAVE10'), 403));\ntest('unknown coupon is rejected', () => assert.throws(() => applyCoupon(448, 'UNKNOWN')));\n", "utf-8");
    await writeFile(join(repoDir, "test", "checkout.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { checkoutTotal } from '../src/index.mjs';\ntest('public checkout composes cart and coupon', () => assert.equal(checkoutTotal([{ unitCents: 199, quantity: 2 }, { unitCents: 50, quantity: 1 }], 'SAVE10'), 403));\ntest('checkout without coupon', () => assert.equal(checkoutTotal([{ unitCents: 199, quantity: 2 }]), 398));\n", "utf-8");
  }
  if (scenario === "refactor") {
    await writeFile(join(repoDir, "src", "report.mjs"), "export function summarize(values) { return {}; }\n", "utf-8");
    await writeFile(join(repoDir, "test", "stats-refactor.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum, mean } from '../src/stats.mjs';\ntest('sum of several values', () => assert.equal(sum([2, 4, 6]), 12));\ntest('empty sum', () => assert.equal(sum([]), 0));\ntest('mean preserves behavior', () => assert.equal(mean([2, 4, 6]), 4));\n", "utf-8");
    await writeFile(join(repoDir, "test", "report.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { summarize } from '../src/index.mjs';\ntest('summary composes shared aggregation and formatter', () => assert.deepEqual(summarize([2, 4, 6]), { count: 3, total: 12, mean: 4, label: 'result: 12' }));\ntest('empty summary preserves zero conventions', () => assert.deepEqual(summarize([]), { count: 0, total: 0, mean: 0, label: 'result: 0' }));\n", "utf-8");
  }
  if (scenario === "cross-package") {
    await mkdir(join(repoDir, "packages", "contracts", "src"), { recursive: true });
    await mkdir(join(repoDir, "packages", "checkout", "src"), { recursive: true });
    await writeFile(join(repoDir, "packages", "contracts", "src", "index.mjs"), "export function priceLine(line) { return { amountCents: line.unitCents * line.quantity, currency: 'USD' }; }\n", "utf-8");
    await writeFile(join(repoDir, "packages", "checkout", "src", "index.mjs"), "import { priceLine } from '../../contracts/src/index.mjs';\nexport function checkoutTotal(lines, discountPercent = 0) { const subtotal = lines.reduce((sum, line) => sum + priceLine(line), 0); return Math.round(subtotal * (100 - discountPercent) / 100); }\n", "utf-8");
    await writeFile(join(repoDir, "test", "contracts.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { priceLine } from '../packages/contracts/src/index.mjs';\ntest('contract returns integer cents and currency', () => assert.deepEqual(priceLine({ unitCents: 199, quantity: 2 }), { amountCents: 398, currency: 'USD' }));\ntest('contract rejects negative quantity', () => assert.throws(() => priceLine({ unitCents: 199, quantity: -1 })));\ntest('contract rejects fractional cents', () => assert.throws(() => priceLine({ unitCents: 1.5, quantity: 2 })));\n", "utf-8");
    await writeFile(join(repoDir, "test", "checkout-integration.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { checkoutTotal } from '../packages/checkout/src/index.mjs';\ntest('checkout composes line contracts', () => assert.equal(checkoutTotal([{ unitCents: 199, quantity: 2 }, { unitCents: 50, quantity: 1 }]), 448));\ntest('checkout applies discount at aggregate boundary', () => assert.equal(checkoutTotal([{ unitCents: 199, quantity: 2 }, { unitCents: 50, quantity: 1 }], 10), 403));\ntest('empty checkout is zero', () => assert.equal(checkoutTotal([]), 0));\ntest('invalid discount is rejected', () => assert.throws(() => checkoutTotal([{ unitCents: 100, quantity: 1 }], 110)));\n", "utf-8");
  }
  await execFile("git", ["add", "."], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
  const baseRevision = await git(repoDir, ["rev-parse", "HEAD"]);
  let preMissionIntegration = null;
  if (scenario === "cross-package") {
    try {
      await execFile("node", ["--test", "test/contracts.test.mjs", "test/checkout-integration.test.mjs"], { cwd: repoDir });
      preMissionIntegration = { failed: false, exitCode: 0 };
    } catch (error) {
      preMissionIntegration = { failed: true, exitCode: error.code ?? null, output: `${error.stdout ?? ""}\n${error.stderr ?? ""}`.slice(0, 6000) };
    }
    if (!preMissionIntegration.failed) throw new Error("Cross-package mission fixture unexpectedly passes before repair.");
  }

  const sessionId = `session-r52-${scenario}`;
  persistence.upsertSession({ id: sessionId, title: `R52 Capacity Mission (${scenario})`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle" });

  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBaseDir });
  const runtime = createAgentRuntime({
    sessionId, eventStore, persistence, firewall, providerCatalog: catalog,
    workspacePath: repoDir, freeCloud, freeFabric, fabricContext, routeHealth,
    userId: "r52-live-operator",
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
      goal: scenario === "multi-step"
        ? "Inspect the repository and make all failing tests pass: fix multiply in src/math.mjs, the public output format in src/format.mjs, and median (both odd- and even-length inputs) in src/median.mjs. Do not modify the tests."
        : scenario === "feature"
          ? "Add a quantity-aware checkout feature using integer cents. Implement subtotalCents in src/cart.mjs, coupon policy in src/coupons.mjs (SAVE10 is 10% off rounded to cents; reject unknown coupons), and a public checkoutTotal composition exported from src/index.mjs. Reject invalid negative quantities. Preserve existing math and format behavior. Inspect the tests but do not edit them."
          : scenario === "refactor"
            ? "Refactor shared aggregation: export sum(values) from src/stats.mjs, make mean reuse it while preserving empty-array behavior, implement summarize(values) in src/report.mjs using sum, mean, and format, and export summarize publicly from src/index.mjs. Preserve existing math, format, and stats behavior. Inspect the tests but do not edit them."
            : scenario === "cross-package"
              ? "Diagnose and repair the failing checkout integration across packages/contracts and packages/checkout. Keep the priceLine public contract as an object with integer amountCents and USD currency. Validate invalid quantities and fractional cents at the contract boundary; make checkoutTotal compose contract outputs, apply percentage discount to the aggregate rounded to cents, and reject invalid discount percentages. Preserve unrelated math/format behavior. Inspect the tests but do not edit them."
          : "Inspect the repository and make both failing tests pass by fixing multiply in src/math.mjs and the public output format in src/format.mjs. Do not modify the tests.",
      verificationCommands: scenario === "multi-step"
        ? ["node --test test/math.test.mjs test/format.test.mjs test/median.test.mjs"]
        : scenario === "feature"
          ? ["node --test test/cart.test.mjs test/coupons.test.mjs test/checkout.test.mjs test/math.test.mjs test/format.test.mjs"]
          : scenario === "refactor"
            ? ["node --test test/stats.test.mjs test/stats-refactor.test.mjs test/report.test.mjs test/math.test.mjs test/format.test.mjs"]
            : scenario === "cross-package"
              ? ["node --test test/contracts.test.mjs test/checkout-integration.test.mjs test/math.test.mjs test/format.test.mjs"]
          : ["node --test test/math.test.mjs test/format.test.mjs"],
      adapter,
      signal: runController.signal,
      ...(complexityHint ? { complexityHint } : {}),
    });
  } finally {
    clearTimeout(timeout);
  }
  const completedAt = new Date().toISOString();
  const elapsedMs = Date.now() - startedMs;

  // ---- Evidence assembly ---------------------------------------------------
  const quotaAfter = quotaSnapshot();
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
    stopReason: item.telemetry?.stopReason ?? null,
    turnTrace: (item.telemetry?.toolTrace ?? []).map((turn) => ({
      turn: turn.turn,
      batchSize: turn.batchSize,
      calls: (turn.calls ?? []).map((call) => ({
        tool: call.tool,
        targetHash: typeof call.target === "string" ? createHash("sha256").update(call.target).digest("hex").slice(0, 16) : null,
        requestHash: call.requestHash ?? null,
        outcome: call.outcome,
        bytes: call.bytes ?? null,
        observationHash: call.observationHash ?? null,
      })),
    })),
    editAttempts: (item.telemetry?.editAttempts ?? []).map((edit) => ({
      turn: edit.turn,
      tool: edit.tool,
      pathHash: typeof edit.path === "string" ? createHash("sha256").update(edit.path).digest("hex").slice(0, 16) : null,
      outcome: edit.outcome,
      failureClass: edit.failureClass ?? null,
    })),
    roleProgress: item.telemetry?.roleProgress ?? null,
  }));
  const modelTurns = (await persistence.getWorkItemsByKind("agent_model_turn")).map((item) => ({
    runId: item.runId,
    agentId: item.agentId,
    turnId: item.turnId,
    state: item.state,
    transcriptBytes: item.transcriptBytes ?? null,
    provider: item.servedProviderId ?? null,
    model: item.servedModelId ?? null,
    usageSource: item.usageSource ?? "UNKNOWN",
    inputTokens: item.usageSource === "PROVIDER_REPORTED" ? item.inputTokens ?? null : null,
    outputTokens: item.usageSource === "PROVIDER_REPORTED" ? item.outputTokens ?? null : null,
    finishReason: item.finishReason ?? null,
    toolRequests: item.toolRequests ?? null,
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
  const roleQualityHandoffs = (await persistence.getWorkItemsByKind("role_quality_handoff")).map((item) => ({
    runId: item.runId,
    role: item.role,
    reason: item.reason,
    oldOwner: item.oldOwner ?? null,
    newOwner: item.newOwner ?? null,
    changedFiles: item.changedFiles ?? [],
    pendingGoal: item.pendingGoal ?? null,
    requiredVerificationCommands: item.requiredVerificationCommands ?? [],
    priorFailure: item.priorFailure ?? null,
    outcome: item.outcome ?? null,
  }));
  const semanticVerifierHandoffs = (await persistence.getWorkItemsByKind("semantic_verifier_handoff")).map((item) => ({
    runId: item.runId,
    reason: item.reason ?? null,
    oldOwner: item.oldOwner ?? null,
    newOwner: item.newOwner ?? null,
    priorVerdict: item.priorVerdict ?? null,
    outcome: item.outcome ?? null,
  }));

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
    };
  });

  const verificationItems = (await persistence.getWorkItems(sessionId))
    .filter((item) => item.kind === "verification")
    .map((item) => ({ recordType: item.recordType, status: item.status ?? null, payload: item.payload }));

  const routerEvents = eventStore.getAll()
    .filter((event) => event.type === "router.selection" || event.type === "router.failover")
    .map((event) => ({ type: event.type, payload: event.payload }));
  const toolTrace = eventStore.getAll()
    .filter((event) => event.type.startsWith("tool.execution_"))
    .map((event) => {
      const payload = event.payload ?? {};
      const argsJson = typeof payload.argsJson === "string" ? payload.argsJson : null;
      return {
        type: event.type,
        turnId: payload.turnId ?? null,
        toolCallId: payload.toolCallId ?? null,
        toolName: payload.toolName ?? null,
        argsHash: argsJson === null ? null : createHash("sha256").update(argsJson).digest("hex").slice(0, 16),
        resultLength: typeof payload.result === "string" ? payload.result.length : null,
        errorKind: typeof payload.error === "string" ? (payload.error.match(/\b(?:429|RATE_LIMITED|TOOL_WORKSPACE_ESCAPE|TIMEOUT)\b/i)?.[0] ?? "OTHER") : null,
      };
    });

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
    const probe = await execFile("node", ["--test", ...(scenario === "multi-step" ? ["test/math.test.mjs", "test/format.test.mjs", "test/median.test.mjs"] : scenario === "feature" ? ["test/cart.test.mjs", "test/coupons.test.mjs", "test/checkout.test.mjs", "test/math.test.mjs", "test/format.test.mjs"] : scenario === "refactor" ? ["test/stats.test.mjs", "test/stats-refactor.test.mjs", "test/report.test.mjs", "test/math.test.mjs", "test/format.test.mjs"] : scenario === "cross-package" ? ["test/contracts.test.mjs", "test/checkout-integration.test.mjs", "test/math.test.mjs", "test/format.test.mjs"] : ["test/math.test.mjs", "test/format.test.mjs"])], { cwd: repoDir });
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
  const allServedRoutesVerifiedFree = servedModels.every((model) =>
    model.freeStatus === "verified_free" && model.paidFallbackPossible === false
  );

  const evidence = {
    schemaVersion: 1,
    round: evidenceRound,
    scenario,
    complexityHint: complexityHint || null,
    generatedAt: completedAt,
    startedAt,
    elapsedMs,
    provenance: "live zero-cost mission over the R52 capacity fabric",
    purpose: scenario === "unmeasured"
      ? "R52 re-proof mission: every quota domain starts unmeasured (zero bootstrap probes). Pre-R51 this parked forever; the runtime now measures on demand via probeRouteCapacity and completes."
      : scenario === "reviewer-scarcity"
        ? "R52 scarcity mission: every REVIEWER-capable route but one is rate-limited; the surviving route must serve or the run fails honestly."
        : scenario === "provider-outage"
          ? "R52 provider-outage mission: the provider holding the most eligible routes loses every route to 429s; the mission must complete on a different provider."
          : scenario === "multi-step"
            ? "R52 multi-step mission: a three-file task exercising explorer + coder + reviewer through more turns on the live free fabric."
            : scenario === "feature"
              ? "R53 feature mission: quantity-aware integer-cents checkout across cart, coupon, composition, public export, and independent tests."
              : scenario === "refactor"
                ? "R53 refactor mission: shared aggregation, public summary composition, behavioral preservation, and independent tests."
                : scenario === "cross-package"
                  ? "R54 cross-package integration: failing contract and checkout tests require diagnosis and source edits in both packages."
            : "R52 healthy mission: bootstrap probes measure supply normally; the mission completes through the standard fabric.",
    providersPresent: present,
    allowanceProbeBudget: allowanceProbes,
    dataContext: syntheticConsent ? { dataClass: "SYNTHETIC", userConsented: true } : { dataClass: "PRIVATE_CODE", userConsented: false },
    catalogRefresh: { registered: refreshResult.registered ?? null, failed: refreshResult.failed ?? null, errors: refreshResult.errors ?? [] },
    quotaDomains: { beforeMission: quotaBefore, afterMission: quotaAfter },
    replayedRoleEvidence,
    replayedCapacityEvidence,
    missionAdmission: result.topology?.missionAdmission ?? null,
    topology: result.topology ? { policy: result.topology.policy, plan: result.topology.plan ?? null } : null,
    capacityRoutesPreMission: preMissionRoutes,
    preMissionDecisions,
    independentPools: [...new Set(pools.map((pool) => pool.poolId))],
    runStatus: result.status,
    preMissionIntegration,
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
    modelTurns,
    roleQualityHandoffs,
    semanticVerifierHandoffs,
    routerEvents,
    toolTrace,
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
    allServedRoutesForgeAutoEligibleAtEvidenceAssembly: allServedFree,
    allServedRoutesVerifiedFree,
    paidSpendUsd: 0,
    paidBoundary: "8-Bit managed free only: no Paid Auto route, no BYOK route, and no paid receipt path. Served-route cost provenance is reported separately; UNKNOWN does not count as verified free.",
    credentialsUsed: present.map((id) => `${ENV_KEY[id]} (present)`),
  };

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");

  console.log(`[r52] status=${result.status} elapsed=${(elapsedMs / 1000).toFixed(1)}s workers=${workers.length} quota after: observed=${quotaAfter.observed.length} unmeasured=${quotaAfter.unmeasured.length}`);
  for (const role of roleReport) {
    console.log(`[r52]   ${role.role}: ${role.outcome} via ${role.provider ?? "(none)"}/${role.model ?? "-"} pool=${role.pool ?? "-"} qual=${role.roleVerdict ?? role.qualification} req=${role.requests ?? "?"} tools=${role.toolCalls ?? "?"}${role.failovers.length ? ` failovers=${role.failovers.length}` : ""}`);
  }
  console.log(`[r52] gate=${result.completion?.outcome ?? "n/a"} integration=${result.integration?.status ?? "n/a"} treeEqual=${treeEquality?.equal ?? "n/a"} reviewerIndependent=${reviewerIndependent}`);
  console.log(`[r52] evidence=${target}`);

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

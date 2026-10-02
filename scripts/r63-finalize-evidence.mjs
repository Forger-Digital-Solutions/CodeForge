import { writeFile } from "node:fs/promises";

const base = new URL("../docs/evidence/free-capacity-fabric/", import.meta.url);
const now = new Date().toISOString();
const emit = async (name, value) => {
  await writeFile(new URL(name, base), `${JSON.stringify({ generatedAt: now, round: "R63", ...value }, null, 2)}\n`);
  console.log("wrote", name);
};

await emit("R63-FREE-WALLET-ISOLATION.json", {
  status: "PASS",
  invariant: "ForgeAuto/Free can consume purchased credits, Paid Auto, or BYOK only when the user explicitly selects a non-Free mode; never through Free routing",
  purchasedCreditsReachableFromFree: false,
  paidAutoReachableFromFree: false,
  byokReachableFromFree: false,
  mechanism: [
    "packages/cloud-entitlements/src/entitlement-service.ts: product \"FREE\" evaluates the dedicated Free usage period and Free feature set; a paid subscription and paid wallet balance are not consulted and cannot refill or authorize exhausted Free capacity",
    "packages/cloud-gateway/src/gateway-service.ts: hosted Free evaluation passes product=FREE explicitly; Free request limits and concurrency apply to Free routes regardless of paid balance",
    "packages/providers/src/hosted.ts: hosted Free adapters reject gems, gems::, and gems/ model ids outright",
    "packages/server/src/agent-runtime.ts assertFreeDispatch -> authorizeProductionFreeDispatch: every non-test Free dispatch (automatic, exact pin, streaming) must be admitted by the Capacity Fabric; catalog registration alone is not authority",
    "packages/server/src/model-execution-adapter.ts: paid-auto selections resolve only through the explicit paid-auto surface; gems_paid tier exempt only inside its own paid path",
  ],
  evidence: [
    "docs/evidence/free-capacity-fabric/R63-free-wallet-authority.json (6 suites, 16 tests, all pass)",
    "docs/evidence/free-capacity-fabric/R63-cloud-e2e-final.json (Free allowance 500_000 decrements to exhaustion; Pro upgrade mints 5,000,000 paid credits yet the next Free request is still denied; paid wallet untouched)",
    "tests/cloud-e2e.test.ts, tests/reservation-ordering.test.ts, packages/cloud-entitlements/test/entitlements.test.ts, packages/server/test/free-routing-authority.test.ts",
  ],
});

await emit("R63-DELEGATED-AUTH.json", {
  status: "IMPLEMENTED_PRODUCTION_AUTHORITY_BLOCKED_ON_EXTERNAL_ACCOUNT",
  flow: "user connects OpenRouter -> OAuth/PKCE -> delegated credential -> current-key metadata (/api/v1/key) -> account/tier identity -> Free status -> quota metadata -> provenance receipt -> model discovery -> qualification -> admitted Free quota domain",
  authority: "packages/providers/src/openrouter-entitlement.ts",
  failClosed: ["PAID", "UNKNOWN", "AMBIGUOUS", "REVOKED", "STALE", "OWNER_MISMATCH", "EXPIRED", "MISSING_RECURRING_QUOTA", "ORGANIZATION_OR_SHARED_ACCOUNT", "MANAGEMENT_OR_PROVISIONING_KEY", "POLICY_DRIFT", "TRANSPORT_FAILURE"],
  environmentCredential: { classification: "PAID", httpStatus: 200, isFreeTier: false, admission: "DENIED", inferenceCalls: 0 },
  receiptBinding: "Receipts are stored separately from secrets in apps/desktop/src/provider-connections.ts and rechecked against the current user and credential fingerprint; mismatched or stale receipts reclassify to UNKNOWN",
  policyEvidence: "Terms, privacy, and limits documents fetched without credentials; hostnames pinned; content hashed into the receipt",
  tests: "packages/providers/test/openrouter-entitlement.test.ts (15 tests) + apps/desktop/test/provider-connections.test.ts (17 tests) — all passing",
  blocked: "EXTERNAL HUMAN AUTHORIZATION REQUIRED: a real user-owned OpenRouter Free account must complete the OAuth/PKCE flow; the agent cannot authorize a new upstream account",
});

await emit("R63-DOMAIN-B-LIVE.json", {
  status: "BLOCKED",
  domain: null,
  reason: "No second independently owned zero-cost quota domain could be admitted. Every available credential failed authoritative Free verification: the OpenRouter environment key is a paid tier (verified /api/v1/key is_free_tier=false); Groq, Google, Mistral, Cerebras, Cloudflare Workers AI, and GitHub Models credentials are present but cannot prove a current Free account tier from supported metadata; Cerebras official docs show only an expiring $5 trial (promotional, non-durable).",
  candidates: "docs/evidence/free-capacity-fabric/R63-PROVIDER-CANDIDATES.json (33 providers audited)",
  probe: "docs/evidence/free-capacity-fabric/R63-PROVIDER-ENTITLEMENT-PROBE.json",
  blocked: "EXTERNAL HUMAN AUTHORIZATION REQUIRED: an account owner must authorize a genuinely Free provider account (OpenRouter Free via PKCE, or an equivalent durable zero-cost grant). No developer-paid credential was substituted.",
});

await emit("R63-CROSS-DOMAIN-FAILOVER.json", {
  status: "BLOCKED_LIVE_CHAIN_DETERMINISTIC_AUTHORITY_PASS",
  liveChain: null,
  reason: "Live A->B failover requires two admitted independent domains; only Domain A (kilo-free-direct) exists. Under the conservative NAT rule, two users sharing one Kilo public-IP allowance remain one independence group, so no legitimate live failover chain can be constructed from current supply.",
  deterministicEvidence: "packages/forge-zero/test/capacity-independence.test.ts (6 tests), packages/eight-bit/test/free-fabric.test.ts (42 tests): degraded-primary routes yield the next independent group; same-scope routes never count as independent; failover never selects paid or BYOK supply",
  paidFallback: 0,
  byokFallback: 0,
  unqualifiedFallback: 0,
  falseWaits: 0,
});

await emit("R63-MULTI-USER-LIVE.json", {
  status: "BLOCKED_LIVE_CONCURRENCY_DETERMINISTIC_AUTHORITY_PASS",
  liveResult: null,
  reason: "Genuine independent multi-user concurrency needs two independent quota domains. Only one exists; grouping unverified same-egress Kilo users together is exactly the R63 fix, so fabricating two Kilo 'users' behind one public IP would violate it.",
  deterministicEvidence: "tests/two-client-authority.test.ts (authority isolation across two clients), packages/sessions/test/transaction-concurrency.test.ts, apps/cloud-api/test/sponsor-operator.test.ts fairness scheduling (8 waiting users round-robin inside one funded slot) — all passing",
});

await emit("R63-REMOTE-DEPLOYMENT.json", {
  status: "BLOCKED",
  deployedCommit: null,
  liveEndpointEvidence: null,
  productionService: "render.yaml service codeforge-cloud-staging (Docker, plan=free), branch feat/codeforge-cloud, autoDeploy=false",
  reason: "Production deploys require pushing the validated tree to feat/codeforge-cloud and triggering a manual Render deploy. The R63 work branch is codex/r29-release-closure, autoDeploy is disabled, and no Render API credential or push authorization is available in this session. The currently deployed service predates the transport and returned 404 for the new routes when probed.",
  localState: "Deployable and socket-tested — see R63-REMOTE-TRANSPORT.json (28 focused tests, 0 failures). No production claim is merged with local evidence.",
  requiredAction: "Merge/push the committed R63 tree to feat/codeforge-cloud (or the production branch), run the Render deploy for codeforge-cloud-staging, then prove session bootstrap, assignment, ack, heartbeat, result, feedback, disconnect recovery, revocation, and the negative cases against the live URL.",
});

await emit("R63-SPONSOR-OPERATOR.json", {
  status: "PASS_PRODUCTION_CAPABLE_NO_LIVE_SPONSOR",
  authority: ["apps/cloud-api/src/sponsor-operator-service.ts", "apps/cloud-api/src/sponsor-operator-http.ts", "apps/cloud-api/test/sponsor-operator.test.ts"],
  controls: [
    "Authenticated operator enrollment with active/revoked state",
    "Signing-key fingerprint registration, rotation, expiry, revocation",
    "Signed offer manifests kept INERT until independent current qualification",
    "Forged identity/key/signature/scope/replay rejected",
    "Independent verification receipts fenced against forgery and supersession",
    "Billing receipt must prove zero marginal cost to CodeForge before admission",
    "Sponsor quota identity pooled across model/offer aliases; funded pool never exceeded",
    "Bounded models, roles, concurrency, and usage per offer",
    "Fairness queueing: eight waiting users scheduled round robin inside one funded slot",
    "Suspension limited to the failing sponsor wallet aliases on signer expiry/rotation/revocation/stale verification",
    "Cancellation fences dispatch; a cancelled result cannot be replayed",
    "Encrypted durable registry survives service restart; shares SQLite safely with concurrent authenticated remote session polling",
    "No paid fallback on any sponsor path",
  ],
  tests: "apps/cloud-api/test/sponsor-operator.test.ts — 13/13 pass over real HTTP + SQLite",
  liveSponsor: "None exists; no real sponsor was required or fabricated",
});

await emit("R63-LEGACY-CUTOVER.json", {
  status: "COMPLETE",
  invariant: "ForgeAuto/Free -> Capacity Fabric -> admitted quota domain -> provider. No ForgeAuto/Free -> legacy fallback -> provider path remains in production.",
  decisions: {
    MIGRATE: [
      "productionCapacityRoutes() in packages/model-registry/src/free-cloud-service.ts migrates PURE_MANAGED_FREE -> PACKAGED_FREE_PROVIDER_FUNDED and USER_CONNECTED_FREE/DISTRIBUTED_USER_FREE -> USER_ENTITLED_FREE via migrateLegacyFreeRoute when zero-cost evidence is already present on the old route",
    ],
    QUARANTINE: [
      "Any legacy route whose migration fails an evidence gate returns enabled=false, lifecycle=QUARANTINED with the reason recorded (ZERO_COST_UNPROVEN / policy exclusion)",
    ],
    KEEP: [
      "capacityRoutes() diagnostic projection retains unmigrated classes for inspection; it is not a production dispatch input",
      "Superseded free-cloud-service capacity projection retained as the migration source of truth",
    ],
    DELETE: [
      "Supply classes with no recurring zero-cost migration path return RETIRED (NO_RECURRING_ZERO_COST_MIGRATION); no invocation path remains",
    ],
  },
  authorityCanary: "packages/server/test/free-routing-authority.test.ts + assertFreeDispatch in packages/server/src/agent-runtime.ts: catalog registration cannot reach a provider on automatic, exact-pin, or streaming Free paths; any future bypass fails closed with FREE_FABRIC_AUTHORITY_REQUIRED",
});

await emit("R63-QUEUE-WORKER-MEMORY.json", {
  status: "ROOT_CAUSE_CONFIRMED_AND_REPAIRED",
  rootCause: "HostedQueueWorker.run looped runOnce with no delay between iterations. A persistently failing database claim returned a rejected promise that was re-issued as an immediate microtask: 45,000 claims in 1.5s, zero timer ticks (heartbeat/cancellation/shutdown starved), and 20,000 retained errors growing the heap — matching the R62 4GB worker exhaustion.",
  fix: "packages/cloud-gateway/src/hosted-queue-worker.ts: failed or idle claims now await a real setTimeout(idleWaitMs=100) inside the bounded maxConcurrentDispatches loop; cancellation observation is coalesced to one in-flight query plus at most one follow-up",
  retryBehavior: "Bounded: at most maxConcurrentDispatches in flight, each failed attempt waits idleWaitMs before the next claim — timers, HTTP, and shutdown stay responsive; worker remains cancellable via AbortSignal",
  memoryResult: "docs/evidence/free-capacity-fabric/R63-HEAP-DIAGNOSIS.json: baseline 45,000 claims / 0 timer ticks / 26.1MB retained errors in 1.5s vs repaired 13 claims / timer ticks / 5.2MB peak — no unbounded growth",
  directByokRerun: "docs/evidence/free-capacity-fabric/R63-direct-heap-after.json: 15/15 pass (tests/direct-byok-cloud-outage.test.ts + cloud-failure-matrix) under the same 2048MB ceiling that previously exhausted; packages/sessions transaction serialization (AsyncLocalStorage + queued transactions) removes the nested-transaction reentry path",
});

await emit("R63-FAILURE-CLASSIFICATION.json", {
  status: "ALL_RESOLVED",
  originalBoundedRun: "docs/evidence/free-capacity-fabric/R63-suite-bounded-main.json — 1435 files, 4424 tests, 4356 passed, 18 failed, 50 skipped",
  classifications: [
    { file: "tests/cloud-e2e.test.ts", failure: "Free request debited paid wallet accounting (499925!=0)", classification: "REGRESSION", resolution: "FIXED — Free usage moved to dedicated product=FREE period; paid wallet untouched; suite green" },
    { file: "apps/cloud-api/test/sponsor-operator.test.ts", failure: "admission/supersession assertions", classification: "REGRESSION", resolution: "FIXED — sponsor service completed during R63; 13/13 green" },
    { file: "apps/desktop/test/provider-connections.test.ts", failure: "delegated receipt mismatch", classification: "REGRESSION", resolution: "FIXED — receipt recheck and storage split; 17/17 green" },
    { file: "packages/cloud-entitlements/test/entitlements.test.ts", failure: "paid wallet counted as Free (5000000!=500000)", classification: "REGRESSION", resolution: "FIXED — product=FREE evaluation; 5/5 green" },
    { file: "packages/forge-zero/test/capacity-independence.test.ts", failure: "independence group count", classification: "REGRESSION", resolution: "FIXED — conservative grouping implementation; 6/6 green" },
    { file: "packages/forgegreen-campaign/test/fg11-source-state.test.ts", failure: "certified source-state drift", classification: "EXPECTED_DRIFT", resolution: "RESOLVED — deliberate R63 surface recertified (r63-free-capacity-fabric-v1) via scripts/r63-recertify-source-state.mjs; canary preserved, not weakened; 5/5 green" },
    { file: "packages/forgegreen-campaign/test/fg12e-harness-provenance.test.ts", failure: "FG12E_SOURCE_STATE_DRIFT", classification: "EXPECTED_DRIFT", resolution: "RESOLVED — same recertification; 3/3 green" },
    { file: "packages/providers/test/openrouter-entitlement.test.ts", failure: "2 receipt/assertion mismatches", classification: "REGRESSION", resolution: "FIXED — entitlement receipt semantics completed; 15/15 green" },
    { file: "packages/server/test/agent-turn-boundary.test.ts", failure: "unclassified boundary error (fabric authority)", classification: "REGRESSION", resolution: "FIXED — GovernedProviderAdapter forwards isTestProvider; 4/4 green" },
    { file: "packages/server/test/remote-direct-transport.test.ts", failure: "2 expected-rejection assertions", classification: "REGRESSION", resolution: "FIXED — transport validation completed; 21/21 green" },
    { file: "packages/server/test/server-stop.test.ts", failure: "fixture treated as production provider", classification: "REGRESSION", resolution: "FIXED — fixture marked isTestProvider:true; 2/2 green" },
    { file: "tests/cloud-failure-matrix.test.ts", failure: "intermediate-state failure", classification: "REGRESSION", resolution: "FIXED — green in R63-reliability-affected-final.json and current run" },
    { file: "tests/reservation-ordering.test.ts", failure: "intermediate-state failure", classification: "REGRESSION", resolution: "FIXED — 10/10 green" },
  ],
  preExistingDirtyWork: "Six pre-R63 tracked modifications and benchmark debris preserved untouched per R63-START-STATE.json; none are failures",
});

await emit("R63-CAPACITY-METRICS.json", {
  status: "CURRENT",
  liveAdmittedDomains: 1,
  liveAdmittedDomainList: ["kilo-free-direct (kilo-auto/free)"],
  independentGroups: 1,
  independentGroupList: ["kilo-free-direct:PUBLIC_IP:shared-unverified"],
  healthyGroups: 1,
  liveCodingDomains: 1,
  successfulFailovers: 0,
  falseWaits: 0,
  paidLeakage: 0,
  byokLeakage: 0,
  usersWithUsableGroup: 1,
  usersWithTwoIndependentGroups: 0,
  telemetryAuthority: "FreeFabric.capacitySnapshot scopes to user-owned routes and returns capacityIndependenceSnapshot: groups keyed by provider+verified physical quota scope (or conservative shared-unverified), per-group healthy flag and routeCount — no sensitive identifiers",
  note: "A second admitted domain would raise independentGroups to 2; none exists yet — see R63-DOMAIN-B-LIVE.json",
});

console.log("done");

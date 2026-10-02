import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

// R63 lands the free-capacity fabric authority surface: quota-independence grouping, delegated
// OpenRouter entitlement verification, production Free dispatch authorization, the remote direct
// transport, the sponsor operator service, and serialized session transactions. These files are
// the seams R63 changed or created — they belong in the certified material set for the same reason
// R42/R44 added the policy files they introduced.
const ADDITIONS = [
  "apps/cloud-api/src/remote-direct-host.ts",
  "apps/cloud-api/src/remote-direct-http.ts",
  "apps/cloud-api/src/sponsor-operator-http.ts",
  "apps/cloud-api/src/sponsor-operator-service.ts",
  "apps/cloud-api/test/remote-direct-http.test.ts",
  "apps/cloud-api/test/sponsor-operator.test.ts",
  "packages/forge-zero/src/capacity-independence.ts",
  "packages/forge-zero/test/capacity-independence.test.ts",
  "packages/providers/src/openrouter-entitlement.ts",
  "packages/providers/test/openrouter-entitlement.test.ts",
  "packages/server/src/remote-direct-admission.ts",
  "packages/server/src/remote-direct-client.ts",
  "packages/server/src/remote-direct-provider.ts",
  "packages/server/src/remote-direct-transport.ts",
  "packages/server/test/free-routing-authority.test.ts",
  "packages/server/test/remote-direct-transport.test.ts",
  "packages/sessions/test/transaction-concurrency.test.ts",
];

for (const file of ADDITIONS) {
  if (!doc.materialFiles.includes(file)) doc.materialFiles.push(file);
}

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");

const priorId = doc.sourceStateId;
const priorSurface = doc.surfaceVersion;
const changedFiles = entries.filter((e) => doc.materialFileHashes[e.path] !== e.blobHash).map((e) => e.path);

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "r63-free-capacity-fabric-v1";
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
doc.recertifiedAt = new Date().toISOString().slice(0, 10);

doc.recertifications.push({
  label: "R63 free-capacity fabric authority recertification",
  reason:
    "R63 closes the free-capacity correctness and isolation faults found during the R62/R63 audit, without touching ForgeGreen detector semantics, admission policy, cost policy, or the completion gate. (1) Free-wallet isolation: the hosted Free allowance now lives in its own usage period and product scope, so ForgeAuto/Free can never consume a paid subscription, purchased credits, or a BYOK credential — Free exhaustion with a funded wallet still fails closed. (2) Delegated OpenRouter entitlement: user-connected OpenRouter supply now requires an authoritative FREE_VERIFIED account receipt (current-key metadata, credential fingerprint, account-owner binding, policy evidence), so the paid environment key and every unverifiable account class fail closed. (3) Quota independence: capacity-independence groups are keyed by verified physical quota scope; unverified Kilo egress collapses into one shared-unverified group so same-NAT users can no longer manufacture a second domain. (4) Production dispatch authority: every non-test Free dispatch — automatic, exact-pin, and streaming — must pass Fabric admission, closing the catalog-registration bypass. (5) Remote direct transport and sponsor operator service are new certified seams. (6) Session transactions moved from a process-global flag to AsyncLocalStorage-scoped serialization, removing the zero-delay claim retry path that starved timers and exhausted the queue-worker heap. No gate was weakened: paid/BYOK supply is still unreachable from Free routing, evaluateCompletion remains the only completion authority, and unverifiable free status still fails closed.",
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "r63-free-capacity-fabric-v1",
  changes: [
    { file: "apps/desktop/src/main.ts", change: "Delegated OpenRouter connection flow wired to entitlement verification and receipt recheck.", addedToMaterialFiles: false },
    { file: "apps/cloud-api/src/remote-direct-host.ts", change: "Hosted remote direct transport host: authenticated session bootstrap, assignment delivery, heartbeat lease, result/feedback intake.", addedToMaterialFiles: true },
    { file: "apps/cloud-api/src/remote-direct-http.ts", change: "Cloud HTTP routes for remote direct session/assignment/heartbeat/result/feedback.", addedToMaterialFiles: true },
    { file: "apps/cloud-api/src/sponsor-operator-http.ts", change: "Authenticated sponsor operator HTTP authority bound to the enrolled operator identity.", addedToMaterialFiles: true },
    { file: "apps/cloud-api/src/sponsor-operator-service.ts", change: "Sponsor operator pipeline: enrollment, signing-key rotation/revocation, signed manifests, independent verification, funded-pool accounting, fairness queueing.", addedToMaterialFiles: true },
    { file: "apps/cloud-api/test/remote-direct-http.test.ts", change: "Socket-level hosted transport validation.", addedToMaterialFiles: true },
    { file: "apps/cloud-api/test/sponsor-operator.test.ts", change: "Sponsor pipeline: inert offers, forged receipt fencing, suspension on expiry/rotation/revocation, alias-bounded funded pool, fairness, restart durability.", addedToMaterialFiles: true },
    { file: "packages/cloud-gateway/src/provider-registry.ts", change: "Hosted provider registration tightened for Free admission.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/src/failover.ts", change: "Failover honors independence-group boundaries.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/src/free-fabric.ts", change: "capacitySnapshot exposes independence groups; decide() scopes user-owned routes.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/src/health.ts", change: "Health classification integrated with independence grouping.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/src/route-ledger.ts", change: "Ledger carries quotaScopeEvidence and independenceKey per route.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/src/runtime.ts", change: "Runtime routes through independence-aware fabric decisions.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/src/types.ts", change: "Types extended for independence evidence.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/test/free-fabric.test.ts", change: "Independence-group and conservative-pooling coverage.", addedToMaterialFiles: false },
    { file: "packages/eight-bit/test/runtime.test.ts", change: "Runtime coverage for the new routing surface.", addedToMaterialFiles: false },
    { file: "packages/forge-zero/src/capacity-independence.ts", change: "hashQuotaScope, quotaScopeEvidenceExclusionReason, deriveCapacityIndependence, capacityIndependenceKey, haveIndependentQuotaScopes, capacityIndependenceSnapshot — verified physical scopes distinguish groups; unknown scopes pool conservatively.", addedToMaterialFiles: true },
    { file: "packages/forge-zero/src/capacity-reservations.ts", change: "Reservations track independence groups.", addedToMaterialFiles: false },
    { file: "packages/forge-zero/src/capacity-types.ts", change: "quotaScopeEvidence and independence key types.", addedToMaterialFiles: false },
    { file: "packages/forge-zero/test/capacity-independence.test.ts", change: "Deterministic authority tests for grouping rules.", addedToMaterialFiles: true },
    { file: "packages/model-registry/src/free-cloud-service.ts", change: "productionCapacityRoutes migrates/quarantines legacy supply; delegated entitlement receipts feed USER_ENTITLED_FREE windows; per-user pools carry quota scope evidence.", addedToMaterialFiles: false },
    { file: "packages/model-registry/src/provider-definitions.ts", change: "Provider catalog entries updated for R63 candidates.", addedToMaterialFiles: false },
    { file: "packages/model-registry/test/free-cloud-registry.test.ts", change: "Registry coverage for delegated and migrated supply.", addedToMaterialFiles: false },
    { file: "packages/providers/src/capacity-governor.ts", change: "GovernedProviderAdapter transparently forwards isTestProvider and USER_API markers so governed test fixtures stay exempt from production dispatch authority.", addedToMaterialFiles: false },
    { file: "packages/providers/src/index.ts", change: "openrouter-entitlement exports.", addedToMaterialFiles: false },
    { file: "packages/providers/src/openrouter-entitlement.ts", change: "Authoritative delegated OpenRouter entitlement: account classification, credential fingerprint, receipt currency, fail-closed FREE_VERIFIED admission.", addedToMaterialFiles: true },
    { file: "packages/providers/test/openrouter-entitlement.test.ts", change: "PAID/UNKNOWN/STALE/OWNER_MISMATCH/REVOKED negative coverage.", addedToMaterialFiles: true },
    { file: "packages/server/src/agent-runtime.ts", change: "assertFreeDispatch/authorizeProductionFreeDispatch gates every non-test Free route through Fabric authority.", addedToMaterialFiles: false },
    { file: "packages/server/src/index.ts", change: "Remote direct wiring surfaced in server options.", addedToMaterialFiles: false },
    { file: "packages/server/src/model-execution-adapter.ts", change: "Dispatch authorization seam added after resolveModel.", addedToMaterialFiles: false },
    { file: "packages/server/src/remote-direct-admission.ts", change: "Trusted user/device/workspace authorization plus quota-domain admission; unspecified admission denies.", addedToMaterialFiles: true },
    { file: "packages/server/src/remote-direct-client.ts", change: "Client-side transport: bounded reconnect, HTTPS/public-host restrictions.", addedToMaterialFiles: true },
    { file: "packages/server/src/remote-direct-provider.ts", change: "RemoteDirectProviderAdapter routes accepted tools through governed AgentRuntime execution.", addedToMaterialFiles: true },
    { file: "packages/server/src/remote-direct-transport.ts", change: "Durable sessions, MAC-bound single-use ack, bounded leases, generation fencing, PROPOSED_ONLY validation, zero-cost enforcement.", addedToMaterialFiles: true },
    { file: "packages/server/test/free-routing-authority.test.ts", change: "Authority canary: catalog registration alone cannot reach a provider on automatic, exact, or streaming paths.", addedToMaterialFiles: true },
    { file: "packages/server/test/remote-direct-transport.test.ts", change: "21-test transport validation.", addedToMaterialFiles: true },
    { file: "packages/sessions/src/persistence.ts", change: "AsyncLocalStorage transaction context replaces process-global flag; serialized transaction queue awaited on close/clear; remote/sponsor work-item types persisted.", addedToMaterialFiles: false },
    { file: "packages/sessions/src/session-state.ts", change: "Transaction concurrency state.", addedToMaterialFiles: false },
    { file: "packages/sessions/test/transaction-concurrency.test.ts", change: "Serialization and nested-transaction prevention coverage.", addedToMaterialFiles: true },
  ],
  regressionEvidence:
    "R63 bounded validation: main pass plus four serial heavy suites under 2 workers / 2048MB heap ceiling (docs/evidence/free-capacity-fabric/R63-REPOSITORY-TESTS.json). Focused authority suites green: free-routing-authority, capacity-independence (6), openrouter-entitlement (15), remote-direct-transport (21), remote-direct-http (3), sponsor-operator (13), transaction-concurrency (2), cloud-e2e free-wallet isolation, hosted-queue-worker (9).",
  recertifiedAt: doc.recertifiedAt,
  sourceStateConstant: "R63_FREE_CAPACITY_FABRIC_SOURCE_STATE",
});

doc.recertification = {
  phase: "R63 free-capacity fabric authority reconciliation",
  reason: "Re-issue the frozen ForgeGreen source-state over the reviewed R63 surface so the fg11/fg12e provenance canaries certify the current tree.",
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};

doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through R63 implementation surface present on the recovered lineage, including the FG-11, FG-12D, FG-12F, R18, R37, R41, R42, R43, R44, R59, and R63 recertifications above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`re-issued ${doc.surfaceVersion}: ${sourceStateId} (changed: ${changedFiles.join(", ") || "none"})`);

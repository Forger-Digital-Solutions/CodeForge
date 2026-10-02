import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const certificatePath = resolve(root, "docs/evidence/free-capacity-fabric/source-certification.json");
const certificate = JSON.parse(await readFile(certificatePath, "utf8"));

const addSource = [
  "apps/cloud-api/src/remote-direct-host.ts",
  "apps/cloud-api/src/remote-direct-http.ts",
  "apps/cloud-api/src/sponsor-operator-http.ts",
  "apps/cloud-api/src/sponsor-operator-service.ts",
  "apps/cloud-api/test/remote-direct-http.test.ts",
  "apps/cloud-api/test/sponsor-operator.test.ts",
  "packages/cloud-entitlements/src/entitlement-service.ts",
  "packages/cloud-gateway/src/gateway-service.ts",
  "packages/cloud-gateway/src/hosted-queue-worker.ts",
  "packages/eight-bit/src/route-ledger.ts",
  "packages/forge-zero/src/capacity-independence.ts",
  "packages/forge-zero/test/capacity-independence.test.ts",
  "packages/providers/src/capacity-governor.ts",
  "packages/providers/src/hosted.ts",
  "packages/providers/src/openrouter-entitlement.ts",
  "packages/providers/test/openrouter-entitlement.test.ts",
  "packages/server/src/model-execution-adapter.ts",
  "packages/server/src/remote-direct-admission.ts",
  "packages/server/src/remote-direct-client.ts",
  "packages/server/src/remote-direct-provider.ts",
  "packages/server/src/remote-direct-transport.ts",
  "packages/server/test/free-routing-authority.test.ts",
  "packages/server/test/remote-direct-transport.test.ts",
  "packages/sessions/src/persistence.ts",
  "packages/sessions/src/session-state.ts",
  "packages/sessions/test/transaction-concurrency.test.ts",
  "scripts/cloud/remote-direct-worker.mjs",
  "scripts/r63-bounded-tests.mjs",
  "scripts/r63-heap-diagnosis.mjs",
  "scripts/r63-provider-candidates.mjs",
  "scripts/r63-provider-entitlement-probe.mjs",
  "scripts/r63-recertify-source-state.mjs",
];

const addEvidence = [
  "docs/evidence/free-capacity-fabric/R63-CAPACITY-METRICS.json",
  "docs/evidence/free-capacity-fabric/R63-CROSS-DOMAIN-FAILOVER.json",
  "docs/evidence/free-capacity-fabric/R63-DELEGATED-AUTH.json",
  "docs/evidence/free-capacity-fabric/R63-DOMAIN-A-LIVE.json",
  "docs/evidence/free-capacity-fabric/R63-DOMAIN-B-LIVE.json",
  "docs/evidence/free-capacity-fabric/R63-DOMAIN-INDEPENDENCE.json",
  "docs/evidence/free-capacity-fabric/R63-FAILURE-CLASSIFICATION.json",
  "docs/evidence/free-capacity-fabric/R63-FINAL-REPORT.md",
  "docs/evidence/free-capacity-fabric/R63-FREE-WALLET-ISOLATION.json",
  "docs/evidence/free-capacity-fabric/R63-HEAP-DIAGNOSIS.json",
  "docs/evidence/free-capacity-fabric/R63-KILO-NAT-SCOPE.json",
  "docs/evidence/free-capacity-fabric/R63-LEGACY-CUTOVER.json",
  "docs/evidence/free-capacity-fabric/R63-MULTI-USER-LIVE.json",
  "docs/evidence/free-capacity-fabric/R63-PROVIDER-CANDIDATES.json",
  "docs/evidence/free-capacity-fabric/R63-PROVIDER-ENTITLEMENT-PROBE.json",
  "docs/evidence/free-capacity-fabric/R63-QUEUE-WORKER-MEMORY.json",
  "docs/evidence/free-capacity-fabric/R63-REMOTE-DEPLOYMENT.json",
  "docs/evidence/free-capacity-fabric/R63-REMOTE-LIVE-LOCAL.json",
  "docs/evidence/free-capacity-fabric/R63-REMOTE-TRANSPORT.json",
  "docs/evidence/free-capacity-fabric/R63-REPOSITORY-TESTS.json",
  "docs/evidence/free-capacity-fabric/R63-SPONSOR-OPERATOR.json",
  "docs/evidence/free-capacity-fabric/R63-START-STATE.json",
  "docs/evidence/free-capacity-fabric/R63-cloud-e2e-final.json",
  "docs/evidence/free-capacity-fabric/R63-delegated-cutover-tests.json",
  "docs/evidence/free-capacity-fabric/R63-direct-heap-after.json",
  "docs/evidence/free-capacity-fabric/R63-free-wallet-authority.json",
  "docs/evidence/free-capacity-fabric/R63-reliability-affected-final.json",
  "docs/evidence/free-capacity-fabric/R63-scripted-provider-fixtures.json",
  "docs/evidence/free-capacity-fabric/R63-suite-bounded-main.json",
  "docs/evidence/free-capacity-fabric/R63-suite-serial-heavy-1.json",
  "docs/evidence/free-capacity-fabric/R63-suite-serial-heavy-2.json",
  "docs/evidence/free-capacity-fabric/R63-suite-serial-heavy-3.json",
  "docs/evidence/free-capacity-fabric/R63-suite-serial-heavy-4.json",
];

const merge = (existing, additions) => {
  const paths = new Set(existing.map((e) => e.path));
  for (const p of additions) if (!paths.has(p)) existing.push({ path: p, sha256: "" });
  return existing;
};

certificate.sourceFiles = merge(certificate.sourceFiles, addSource);
certificate.evidenceFiles = merge(certificate.evidenceFiles, addEvidence);
await writeFile(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`);
console.log(`lists updated: ${certificate.sourceFiles.length} source, ${certificate.evidenceFiles.length} evidence`);

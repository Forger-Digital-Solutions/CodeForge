import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ForgeZero } from "@codeforge/forge-zero";
import { createEightBitRuntime, runCompactQualification } from "@codeforge/eight-bit";
import { createFreeModelCatalogRefresh } from "@codeforge/model-registry";
import { createOpenRouterAdapter, createProviderCatalog } from "@codeforge/providers";

const outputPath = resolve("apps/desktop/release/r4-evidence/free-route-qualification.json");
const modelId = "nvidia/nemotron-3-super-120b-a12b:free";

function safeCase(caseResult) {
  return {
    caseId: caseResult.caseId,
    category: caseResult.category,
    passed: caseResult.passed,
    hardFailure: caseResult.hardFailure,
    latencyMs: caseResult.latencyMs,
    retries: caseResult.retries,
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is unavailable to the R4 qualification harness");
  }

  const adapter = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
  const catalog = createProviderCatalog();
  catalog.register(adapter);
  const firewall = new ForgeZero();
  const eightBit = createEightBitRuntime({
    firewall,
    persistence: {
      upsertWorkItem: async () => {}, getWorkItem: async () => null,
      deleteWorkItem: async () => {}, listWorkItems: async () => [], close: async () => {},
    },
  });
  const refresh = createFreeModelCatalogRefresh({ firewall, eightBit, providerCatalog: catalog, requireCredentials: true, maxAllowanceProbes: 0 });
  const discovered = await refresh.refresh();
  const candidate = discovered.discovery.flatMap((entry) => entry.records).find((record) => record.providerId === "openrouter" && record.modelId === modelId);
  if (!candidate || candidate.freeStatus !== "verified_free" || !candidate.modelId.endsWith(":free")) {
    throw new Error("Selected route is not a currently verified zero-unit OpenRouter free route");
  }

  const receipt = await runCompactQualification(candidate, adapter, { timeoutMs: 45_000 });
  const evidence = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    purpose: "R4 bounded production qualification; not a packaged UI or completion-gated task certification",
    providerId: receipt.providerId,
    modelId: receipt.modelId,
    freeEligibility: "live catalog verified_free and :free route identifier",
    qualificationState: receipt.qualificationState,
    suiteVersion: receipt.suiteVersion,
    totalLatencyMs: receipt.totalLatencyMs,
    requestCount: receipt.metadata.requests,
    transient: receipt.metadata.transient,
    roles: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, result]) => [role, {
      status: result.status,
      overallScore: result.overallScore,
      cases: result.testCases.map(safeCase),
    }])),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence));
}

main().catch(async (error) => {
  const evidence = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    purpose: "R4 bounded production qualification; not a packaged UI or completion-gated task certification",
    providerId: "openrouter",
    modelId,
    result: "inconclusive",
    errorClass: error instanceof Error && /rate.?limit|quota|429/i.test(error.message) ? "temporarily_rate_limited" : "failed_before_qualification",
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
});

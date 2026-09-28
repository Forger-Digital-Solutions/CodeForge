import { readFile, writeFile } from "node:fs/promises";
import { createProviderAdapterById, createOpenRouterAdapter } from "@codeforge/providers";
import { runRoleAwareQualification } from "@codeforge/eight-bit";

const root = "docs/evidence/r53-role-intelligence";
const inventory = JSON.parse(await readFile(`${root}/R53-FREE-ROUTE-INVENTORY.json`, "utf8"));
const selected = [
  ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
  ["groq", "openai/gpt-oss-20b"],
  ["mistral", "codestral-2508"],
];
const rows = [];
for (const [providerId, modelId] of selected) {
  const route = inventory.routes.find((entry) => entry.providerId === providerId && entry.modelId === modelId && entry.pool.startsWith("managed:") && entry.eligible && entry.enabled && entry.explicitZeroPrice && entry.paidFallbackDisabled && entry.capacityState === "CAPACITY_MEASURED");
  if (!route) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_MEASURED_FREE_ROUTE" });
    continue;
  }
  const adapter = providerId === "openrouter"
    ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" })
    : createProviderAdapterById(providerId);
  if (!adapter?.streamChat) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_ADAPTER" });
    continue;
  }
  const started = Date.now();
  const receipt = await runRoleAwareQualification({
    providerId,
    modelId,
    displayName: modelId,
    accessClass: providerId === "openrouter" ? "FREE_ROUTED" : "FREE_ALLOWANCE",
    freeStatus: "verified_free",
  }, adapter, { caseTimeoutMs: 30_000 });
  const roles = Object.fromEntries(["EXPLORER", "PLANNER", "CODER", "REVIEWER"].map((role) => {
    const result = receipt.roleResults[role];
    return [role, {
      status: result?.status ?? "NOT_TESTED",
      passed: result?.testCases.filter((item) => item.passed).length ?? 0,
      failed: result?.testCases.filter((item) => !item.passed && !item.error).length ?? 0,
      inconclusive: result?.testCases.filter((item) => Boolean(item.error)).length ?? 0,
      cases: result?.testCases.map((item) => ({ caseId: item.caseId, passed: item.passed, hardFailure: item.hardFailure, latencyMs: item.latencyMs, retries: item.retries, error: item.error ? /429|rate.?limit/i.test(item.error) ? "RATE_LIMITED_429" : "PROVIDER_OR_MODEL_ERROR" : null, details: item.details })) ?? [],
    }];
  }));
  rows.push({ providerId, modelId, status: receipt.metadata?.transient === true ? "INCONCLUSIVE_PROVIDER" : "EXECUTED", suiteVersion: receipt.suiteVersion, qualificationState: receipt.qualificationState, requests: receipt.metadata?.requests ?? null, wallTimeMs: Date.now() - started, transient: receipt.metadata?.transient === true, roles });
  console.log(`${providerId}/${modelId}: E=${roles.EXPLORER.status} P=${roles.PLANNER.status} C=${roles.CODER.status} R=${roles.REVIEWER.status}`);
}
await writeFile(`${root}/R53-ROLE-BENCHMARK.json`, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), sourceInventory: inventory.generatedAt, rows, paidSpendUsd: 0, note: "Current live production qualification probes over measured eligible managed-free models. Results are benchmark evidence; this script does not mutate persisted qualification receipts." }, null, 2)}\n`);

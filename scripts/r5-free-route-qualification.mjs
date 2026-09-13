// R5 free-route harness: quota-free live discovery and bounded, detail-preserving compact probes.
//
//   node scripts/r5-free-route-qualification.mjs discover [--out=<file>]
//   node scripts/r5-free-route-qualification.mjs probe-edit <modelId> [--out=<file>] [--max-tokens=<n>]
//   node scripts/r5-free-route-qualification.mjs qualify <modelId> [--out=<file>]
//
// Discovery lists the currently verified zero-unit OpenRouter routes from the same registry and
// ForgeZero path the desktop uses (pricing metadata only; no chat requests). probe-edit runs the
// compact suite's edit probe once (≤3 model calls, no retry) and keeps the sanitised probe details
// (tool names, argument shape checks, finish state) that the R4 receipt dropped, so a PROBATION
// result can be attributed to the model or to the probe. qualify runs the full compact suite via
// the production runner. Evidence never contains the credential, request bodies, or model text.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ForgeZero } from "@codeforge/forge-zero";
import { createEightBitRuntime, runCompactQualification, probeCompactEditForDiagnostics } from "@codeforge/eight-bit";
import { createFreeModelCatalogRefresh } from "@codeforge/model-registry";
import { createOpenRouterAdapter, createProviderCatalog } from "@codeforge/providers";

const args = process.argv.slice(2);
const command = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is unavailable to the R5 harness (environment credential only; never printed)");
}

async function discover() {
  const adapter = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
  const catalog = createProviderCatalog();
  catalog.register(adapter);
  const firewall = new ForgeZero();
  const eightBit = createEightBitRuntime({
    firewall,
    persistence: { upsertWorkItem: async () => {}, getWorkItem: async () => null, deleteWorkItem: async () => {}, listWorkItems: async () => [], close: async () => {} },
  });
  const refresh = createFreeModelCatalogRefresh({ firewall, eightBit, providerCatalog: catalog, requireCredentials: true, maxAllowanceProbes: 0 });
  const result = await refresh.refresh();
  const records = result.discovery.flatMap((entry) => entry.records).filter((r) => r.providerId === "openrouter");
  return { adapter, firewall, result, records };
}

function describe(record) {
  return {
    modelId: record.modelId,
    displayName: record.displayName,
    family: record.family ?? null,
    freeStatus: record.freeStatus,
    accessClass: record.accessClass ?? null,
    contextWindow: record.contextWindow ?? null,
    maxOutput: record.maxOutput ?? null,
    toolCalling: record.capabilities?.toolCalling ?? false,
    coding: record.capabilities?.coding ?? false,
    structuredOutput: record.capabilities?.structuredOutput ?? false,
    deprecated: record.deprecated ?? false,
  };
}

async function writeEvidence(file, payload) {
  if (!file) return;
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const out = option("out");
  if (command === "discover") {
    const { result, records } = await discover();
    const total = result.discovery.reduce((n, entry) => n + (entry.totalDiscovered ?? entry.records.length), 0);
    const evidence = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      purpose: "R5 live zero-unit discovery (pricing metadata; no inference requests)",
      providerId: "openrouter",
      upstreamModels: total,
      verifiedZeroUnit: records.length,
      toolCapable: records.filter((r) => r.capabilities?.toolCalling).length,
      errors: result.errors,
      candidates: records.map(describe).sort((a, b) => (Number(b.toolCalling) - Number(a.toolCalling)) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0)),
    };
    await writeEvidence(out, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  const modelId = positional[0];
  if (!modelId) throw new Error("model id required");
  const { adapter, records } = await discover();
  const candidate = records.find((r) => r.modelId === modelId);
  if (!candidate || candidate.freeStatus !== "verified_free" || !candidate.modelId.endsWith(":free")) {
    throw new Error(`${modelId} is not a currently verified zero-unit OpenRouter :free route`);
  }

  if (command === "probe-edit") {
    const maxTokens = Number(option("max-tokens", "400"));
    const started = Date.now();
    const probe = await probeCompactEditForDiagnostics(adapter, candidate.modelId, { timeoutMs: 45_000, maxTokens });
    const evidence = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      purpose: "R5 edit-probe reassessment (single attempt, no retry); sanitised probe details only",
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      maxTokens,
      elapsedMs: Date.now() - started,
      passed: probe.passed,
      hardFailure: probe.hardFailure,
      error: probe.error ?? null,
      details: probe.details ?? null,
    };
    await writeEvidence(out, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  if (command === "qualify") {
    const receipt = await runCompactQualification(candidate, adapter, { timeoutMs: 45_000 });
    const evidence = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      purpose: "R5 bounded production compact qualification (harness run; the packaged product keeps its own receipts)",
      providerId: receipt.providerId,
      modelId: receipt.modelId,
      qualificationState: receipt.qualificationState,
      suiteVersion: receipt.suiteVersion,
      totalLatencyMs: receipt.totalLatencyMs,
      requestCount: receipt.metadata.requests,
      transient: receipt.metadata.transient,
      roles: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, result]) => [role, {
        status: result.status,
        overallScore: result.overallScore,
        cases: result.testCases.map((c) => ({ caseId: c.caseId, category: c.category, passed: c.passed, hardFailure: c.hardFailure, latencyMs: c.latencyMs, retries: c.retries, error: c.error ?? null, details: c.details ?? null })),
      }])),
    };
    await writeEvidence(out, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }
  throw new Error(`unknown command ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ result: "failed", errorClass: /rate.?limit|quota|429/i.test(message) ? "temporarily_rate_limited" : "failed", message: message.slice(0, 300) }));
  process.exitCode = 1;
});

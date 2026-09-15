// R1 Managed-Free live certification harness: real, bounded external calls against the
// CodeForge operator-configured free providers (Groq, Cloudflare Workers AI, Z.AI).
//
//   node scripts/managed-free-live-certification.mjs [--out=<file>] [--max-models=<n>]
//
// For each provider whose operator credential is present in the environment: authenticate via a
// live catalog listing, verify the target candidate models exist on the provider TODAY, then run
// the production 8-Bit compact qualification suite (≤3 bounded probes + bounded retries) per
// candidate. Evidence records authentication, catalog facts, latency, and provider-observed
// rate-limit/quota headers — never the credential, request bodies, or model text.
//
// A provider with no credential is recorded as EXTERNAL_AUTHORIZATION_REQUIRED (the exact
// environment variable names are listed) and does not fail the run. A provider WITH a credential
// whose live calls fail is recorded as a failure. Nothing here can spend money: the adapters talk
// only to the free endpoints, and no upgrade/purchase path is touched.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runCompactQualification } from "@codeforge/eight-bit";
import {
  createGroqAdapter,
  createCloudflareAdapter,
  createZaiAdapter,
} from "@codeforge/providers";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", "docs/evidence/managed-free-live-certification.json");
const maxModelsPerProvider = Math.max(1, Number(option("max-models", "3")));

function providerSpec(id, displayName, required, candidates) {
  return { id, displayName, required, candidates };
}

// Candidate model IDs are the qualification targets from the R1 Managed-Free plan. Presence is
// verified against the provider's LIVE catalog before any probe; stale IDs are reported as
// absent rather than probed blind.
const PROVIDERS = [
  providerSpec("groq", "Groq", ["GROQ_API_KEY"], [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
  ]),
  providerSpec("cloudflare-workers-ai", "Cloudflare Workers AI", ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"], [
    "@cf/openai/gpt-oss-120b",
    "@cf/zai-org/glm-4.7-flash",
    "@cf/nvidia/nemotron-3-120b-a12b",
    "@cf/qwen/qwen3.8-27b",
    "@cf/qwen/qwen2.5-coder-32b-instruct",
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/google/gemma-4-26b-a4b-it",
  ]),
  providerSpec("zai", "Z.AI", ["ZAI_API_KEY"], [
    "glm-4.7-flash",
    "glm-4.5-flash",
    "glm-4.6v-flash",
  ]),
];

function credentialFor(spec) {
  const missing = spec.required.filter((name) => !process.env[name] || process.env[name].trim().length === 0);
  return missing.length === 0 ? { present: true } : { present: false, missing };
}

function adapterFor(spec, observations) {
  const onResponse = (observation) => observations.push(observation);
  if (spec.id === "groq") return createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 60_000, onResponse });
  if (spec.id === "cloudflare-workers-ai") {
    return createCloudflareAdapter({
      apiKey: process.env.CLOUDFLARE_API_KEY ?? process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      timeoutMs: 60_000,
      onResponse,
    });
  }
  if (spec.id === "zai") return createZaiAdapter({ apiKey: process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY, timeoutMs: 60_000, onResponse });
  throw new Error(`No adapter for provider ${spec.id}`);
}

// Cloudflare's OpenAI-compatible endpoint has no GET /models (405), so discovery uses the native
// models/search API with the same operator token. Inference itself still goes through the
// production OpenAI-compatible adapter (POST /ai/v1/chat/completions).
async function discoverCloudflareModels() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_KEY ?? process.env.CLOUDFLARE_API_TOKEN;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=100&task=Text%20Generation`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`cloudflare models/search error (${res.status})`);
  const body = await res.json();
  const list = Array.isArray(body?.result) ? body.result : [];
  return list
    .map((entry) => ({
      modelId: typeof entry?.name === "string" ? entry.name : null,
      displayName: typeof entry?.name === "string" ? entry.name.replace(/^@cf\//, "") : null,
    }))
    .filter((m) => typeof m.modelId === "string" && m.modelId.length > 0);
}

async function certifyProvider(spec) {
  const credential = credentialFor(spec);
  if (!credential.present) {
    return {
      providerId: spec.id,
      displayName: spec.displayName,
      status: "EXTERNAL_AUTHORIZATION_REQUIRED",
      requiredEnvironmentVariables: credential.missing,
      note: "Operator credential absent; no live call attempted. All other providers proceeded independently.",
    };
  }

  const observations = [];
  const adapter = adapterFor(spec, observations);

  const result = {
    providerId: spec.id,
    displayName: spec.displayName,
    status: "FAILED",
    auth: { ok: false },
    catalog: { ok: false, modelCount: 0, candidatesPresent: [], candidatesAbsent: [] },
    qualifications: [],
    observedResponses: [],
    errors: [],
  };

  let models;
  const authStarted = Date.now();
  try {
    models = spec.id === "cloudflare-workers-ai" ? await discoverCloudflareModels() : await adapter.listModels();
    result.auth = { ok: true, elapsedMs: Date.now() - authStarted };
    result.catalog.modelCount = models.length;
  } catch (err) {
    result.auth.elapsedMs = Date.now() - authStarted;
    result.errors.push(`listModels: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const presentIds = new Set(models.map((m) => m.modelId));
  for (const candidate of spec.candidates) {
    (presentIds.has(candidate) ? result.catalog.candidatesPresent : result.catalog.candidatesAbsent).push(candidate);
  }

  const qualified = [];
  for (const modelId of result.catalog.candidatesPresent.slice(0, maxModelsPerProvider)) {
    const match = models.find((m) => m.modelId === modelId);
    const record = {
      providerId: spec.id,
      modelId,
      displayName: match?.displayName ?? modelId,
      freeStatus: "verified_free",
      accessClass: "FREE_NATIVE",
      contextWindow: match?.contextWindow,
      capabilities: match?.capabilities,
    };
    const started = Date.now();
    try {
      const receipt = await runCompactQualification(record, adapter, { timeoutMs: 45_000 });
      result.qualifications.push({
        modelId,
        elapsedMs: Date.now() - started,
        qualificationState: receipt.qualificationState,
        hardFailureRoles: receipt.hardFailureRoles,
        roleStatuses: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, r]) => [role, r.status])),
        caseDetails: Object.fromEntries(Object.entries(receipt.roleResults).flatMap(([role, r]) => r.testCases.map((c) => [`${role}:${c.caseId}`, { passed: c.passed, latencyMs: c.latencyMs, error: c.error ?? null }]))),
        metadata: receipt.metadata ?? {},
      });
      qualified.push(receipt.qualificationState);
    } catch (err) {
      result.qualifications.push({
        modelId,
        elapsedMs: Date.now() - started,
        qualificationState: "ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Provider-observed quota/rate-limit headers only (already filtered upstream); bounded list.
  result.observedResponses = observations.slice(0, 40);

  // A QUOTA_EXHAUSTED route is a capacity wall with a reset time, not a capability verdict —
  // the provider status must not read as a model failure when the fleet merely hit its allocation.
  if (qualified.length > 0 && qualified.every((state) => state === "QUALIFIED" || state === "PROBATION")) {
    result.status = "CERTIFIED";
  } else if (qualified.length > 0 && qualified.every((state) => state === "QUOTA_EXHAUSTED")) {
    result.status = "QUOTA_EXHAUSTED";
  } else if (qualified.length > 0) {
    result.status = "PARTIALLY_CERTIFIED";
  } else if (result.qualifications.length > 0) {
    result.status = "QUALIFICATION_FAILED";
  } else {
    result.status = "NO_CANDIDATES_PRESENT";
  }
  return result;
}

async function writeEvidence(file, payload) {
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

const providerResults = [];
for (const spec of PROVIDERS) {
  process.stdout.write(`[managed-free-cert] ${spec.id}: certifying...\n`);
  const started = Date.now();
  let result;
  try {
    result = await certifyProvider(spec);
  } catch (err) {
    result = {
      providerId: spec.id,
      displayName: spec.displayName,
      status: "FAILED",
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  result.wallTimeMs = Date.now() - started;
  providerResults.push(result);
  process.stdout.write(`[managed-free-cert] ${spec.id}: ${result.status}\n`);
}

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: "R1 Managed-Free live provider certification (real external calls; bounded probes; credentials never recorded)",
  zeroCashPolicy: "Free endpoints only; no upgrade, purchase, or plan activation path was invoked.",
  providers: providerResults,
};

const target = await writeEvidence(out, evidence);
const certified = providerResults.filter((r) => r.status === "CERTIFIED").length;
const blocked = providerResults.filter((r) => r.status === "EXTERNAL_AUTHORIZATION_REQUIRED").length;
process.stdout.write(`[managed-free-cert] certified=${certified} blocked=${blocked} evidence=${target}\n`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

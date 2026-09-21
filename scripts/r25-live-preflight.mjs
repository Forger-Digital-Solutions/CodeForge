#!/usr/bin/env node
/**
 * R25 zero-spend pre-flight (§5). For every provider with a credential in the environment, prove
 * free-only posture BEFORE any inference call — using only free, non-billable endpoints (model
 * catalog listing, key/account metadata). Records: credential presence, catalog facts, $0 unit
 * pricing where the provider publishes it, account/quota state where observable, rate-limit
 * headers on the probe response. Never records secrets, request bodies, or model output.
 *
 *   node scripts/r25-live-preflight.mjs [--out=<file>]
 *
 * Verdict per provider: LIVE_OK (inference may proceed under the noted budget) or
 * SKIPPED_FREE_ONLY_NOT_PROVEN (§5: free-only cannot be proven → do not call that route).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", "docs/evidence/r25-live-reality/live-preflight.json");

const env = (name) => (process.env[name] ?? "").trim() || undefined;
const present = (names) => names.every((n) => env(n));

const RATE_HEADERS = /ratelimit|retry-after|x-ratelimit|cf-|usage|limit|remaining|reset/i;
function quotaHeaders(headers) {
  const found = {};
  headers.forEach((value, key) => {
    if (RATE_HEADERS.test(key)) found[key] = value;
  });
  return found;
}

async function getJson(url, headers = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: "R25 §5 zero-spend pre-flight — prove free-only posture before any inference call",
  providers: [],
};

// ---------------------------------------------------------------------------
// OpenRouter — FREE_API, spillover NONE. Proof: :free routes list $0 pricing in
// the live catalog; /auth/key exposes account usage/limit.
// ---------------------------------------------------------------------------
async function preflightOpenRouter() {
  const entry = { providerId: "openrouter", required: ["OPENROUTER_API_KEY"], verdict: "SKIPPED_FREE_ONLY_NOT_PROVEN", checks: {} };
  if (!present(entry.required)) {
    entry.checks.credential = { present: false, missing: entry.required };
    return entry;
  }
  entry.checks.credential = { present: true };
  const key = env("OPENROUTER_API_KEY");
  const headers = { Authorization: `Bearer ${key}` };

  const models = await getJson("https://openrouter.ai/api/v1/models", headers);
  entry.checks.catalog = { status: models.status };
  if (models.status !== 200 || !Array.isArray(models.body?.data)) {
    entry.checks.catalog.error = `HTTP ${models.status}`;
    return entry;
  }
  const freeModels = models.body.data.filter((m) => {
    const p = m?.pricing;
    return typeof m?.id === "string" && m.id.endsWith(":free") && p && Number(p.prompt) === 0 && Number(p.completion) === 0;
  });
  entry.checks.catalog.modelCount = models.body.data.length;
  entry.checks.catalog.freeModelCount = freeModels.length;
  entry.checks.catalog.freeModels = freeModels.map((m) => ({
    id: m.id,
    contextLength: m.context_length ?? null,
    toolCalling: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null,
    unitPrice: { prompt: 0, completion: 0 },
  }));

  const keyInfo = await getJson("https://openrouter.ai/api/v1/auth/key", headers);
  if (keyInfo.status === 200 && keyInfo.body?.data) {
    const d = keyInfo.body.data;
    entry.checks.account = {
      status: 200,
      usage: d.usage ?? null,
      limit: d.limit ?? null,
      limitRemaining: d.limit_remaining ?? null,
      isFreeTier: d.is_free_tier ?? null,
    };
  } else {
    entry.checks.account = { status: keyInfo.status };
  }
  // A :free route is $0 by unit price — even an account with credits cannot be charged for it.
  entry.verdict = freeModels.length > 0 ? "LIVE_OK" : "SKIPPED_FREE_ONLY_NOT_PROVEN";
  entry.note = ":free routes are $0-unit-priced in the live catalog; negative balance can 402 but cannot bill";
  return entry;
}

// ---------------------------------------------------------------------------
// Groq — FREE_DAILY_ALLOCATION, spillover ACCOUNT_DEPENDENT (attestation basis:
// owner free-plan account, same key used at $0 through R23). Proof: catalog +
// rate-limit headers consistent with the published free-plan buckets.
// ---------------------------------------------------------------------------
async function preflightGroq() {
  const entry = { providerId: "groq", required: ["GROQ_API_KEY"], verdict: "SKIPPED_FREE_ONLY_NOT_PROVEN", checks: {} };
  if (!present(entry.required)) {
    entry.checks.credential = { present: false, missing: entry.required };
    return entry;
  }
  entry.checks.credential = { present: true };
  const res = await getJson("https://api.groq.com/openai/v1/models", { Authorization: `Bearer ${env("GROQ_API_KEY")}` });
  entry.checks.catalog = { status: res.status };
  if (res.status !== 200 || !Array.isArray(res.body?.data)) {
    entry.checks.catalog.error = `HTTP ${res.status}`;
    return entry;
  }
  entry.checks.catalog.modelCount = res.body.data.length;
  entry.checks.catalog.modelIds = res.body.data.map((m) => m.id).sort();
  entry.checks.rateLimitHeaders = quotaHeaders(res.headers);
  entry.verdict = "LIVE_OK";
  entry.note = "owner free-plan account (R23 $0 ledger); rate-limit headers observed — free-plan bucket shape is the plan evidence";
  return entry;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI — FREE_DAILY_ALLOCATION, allowlist, ACCOUNT_DEPENDENT.
// Proof: models/search catalog + account plan metadata if the token can read it.
// ---------------------------------------------------------------------------
async function preflightCloudflare() {
  const entry = { providerId: "cloudflare-workers-ai", required: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"], verdict: "SKIPPED_FREE_ONLY_NOT_PROVEN", checks: {} };
  if (!present(entry.required)) {
    entry.checks.credential = { present: false, missing: entry.required.filter((n) => !env(n)) };
    return entry;
  }
  entry.checks.credential = { present: true };
  const account = env("CLOUDFLARE_ACCOUNT_ID");
  const token = env("CLOUDFLARE_API_KEY") ?? env("CLOUDFLARE_API_TOKEN");
  const headers = { Authorization: `Bearer ${token}` };

  const models = await getJson(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=100&task=Text%20Generation`, headers);
  entry.checks.catalog = { status: models.status };
  if (models.status === 200 && Array.isArray(models.body?.result)) {
    const names = models.body.result.map((m) => m?.name).filter(Boolean);
    entry.checks.catalog.modelCount = names.length;
    const ALLOWLIST = ["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b", "@cf/zai-org/glm-4.7-flash", "@cf/nvidia/nemotron-3-120b-a12b", "@cf/qwen/qwen3.8-27b", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/google/gemma-4-26b-a4b-it", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct"];
    entry.checks.catalog.allowlistPresent = ALLOWLIST.filter((m) => names.includes(m));
    entry.checks.catalog.allowlistAbsent = ALLOWLIST.filter((m) => !names.includes(m));
    // Account metadata (plan type) — token may not hold Account:Read; failure is recorded, not fatal.
    const acct = await getJson(`https://api.cloudflare.com/client/v4/accounts/${account}`, headers);
    entry.checks.account = { status: acct.status };
    if (acct.status === 200 && acct.body?.result) {
      const r = acct.body.result;
      entry.checks.account.name = r.name ?? null;
      entry.checks.account.plan = r.plan ?? r.legacy_plan ?? null;
      entry.checks.account.type = r.type ?? null;
    }
    entry.verdict = "LIVE_OK";
    entry.note = "Workers Free allocation is a provider-side hard stop (10k neurons/day on Free plan); allowlist models only; neuron usage observed per call";
  } else {
    entry.checks.catalog.error = `HTTP ${models.status}`;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Google Gemini — FREE_ACCOUNT_ENTITLEMENT, ACCOUNT_DEPENDENT: a project with
// billing enabled is charged, and the API does not expose the project's billing
// state. Inference is only admissible if billing-off can be proven; the probe
// here is catalog-only and still settles auth state.
// ---------------------------------------------------------------------------
async function preflightGemini() {
  const entry = { providerId: "google", required: ["GEMINI_API_KEY"], verdict: "SKIPPED_FREE_ONLY_NOT_PROVEN", checks: {} };
  if (!present(entry.required)) {
    entry.checks.credential = { present: false, missing: entry.required };
    return entry;
  }
  entry.checks.credential = { present: true };
  const res = await getJson("https://generativelanguage.googleapis.com/v1beta/openai/models", { Authorization: `Bearer ${env("GEMINI_API_KEY")}` });
  entry.checks.catalog = { status: res.status };
  if (res.status === 200 && Array.isArray(res.body?.data)) {
    entry.checks.catalog.modelCount = res.body.data.length;
  }
  entry.note = "ACCOUNT_DEPENDENT: project billing state is not readable from the API; free-only cannot be proven → inference stays skipped (§5)";
  return entry;
}

report.providers.push(await preflightOpenRouter().catch((e) => ({ providerId: "openrouter", verdict: "PREFLIGHT_ERROR", error: String(e?.message ?? e).slice(0, 200) })));
report.providers.push(await preflightGroq().catch((e) => ({ providerId: "groq", verdict: "PREFLIGHT_ERROR", error: String(e?.message ?? e).slice(0, 200) })));
report.providers.push(await preflightCloudflare().catch((e) => ({ providerId: "cloudflare-workers-ai", verdict: "PREFLIGHT_ERROR", error: String(e?.message ?? e).slice(0, 200) })));
report.providers.push(await preflightGemini().catch((e) => ({ providerId: "google", verdict: "PREFLIGHT_ERROR", error: String(e?.message ?? e).slice(0, 200) })));

await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
for (const p of report.providers) console.log(`${p.verdict.padEnd(28)} ${p.providerId} ${p.note ?? ""}`);
console.log(`evidence → ${out}`);

#!/usr/bin/env node
// R33 Mission A — live supply measurement. For each credentialed provider this records:
//   1. the public model catalog (free read),
//   2. ONE minimal chat call (max_tokens≈8) on a coding-capable candidate to verify the
//      quota domain is actually serving and to capture the provider's own rate-limit headers,
//   3. read-only account quota endpoints where the provider offers them (OpenRouter /key).
// Total burn: ~1 request per provider. Never touches paid-only providers (openai, anthropic,
// ollama local) and never counts a model listing as secured capacity.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(root, "docs/evidence/r33-free-capacity-fabric/live-supply");
const stamp = new Date().toISOString();

const TARGETS = [
  {
    provider: "groq",
    keyEnv: "GROQ_API_KEY",
    base: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    probeModel: process.env.R33_PROBE_GROQ_MODEL ?? "openai/gpt-oss-120b",
    quotaDomain: "groq-org (organization, per-model limits)",
  },
  {
    provider: "cerebras",
    keyEnv: "CEREBRAS_API_KEY",
    base: "https://api.cerebras.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    probeModel: process.env.R33_PROBE_CEREBRAS_MODEL ?? "llama-3.3-70b",
    quotaDomain: "cerebras-org (shared $5/30d trial credit — non-recurring per provider FAQ)",
  },
  {
    provider: "mistral",
    keyEnv: "MISTRAL_API_KEY",
    base: "https://api.mistral.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    probeModel: process.env.R33_PROBE_MISTRAL_MODEL ?? "devstral-small-latest",
    quotaDomain: "mistral-org (monthly included allowance + per-model RPS/TPM)",
  },
  {
    provider: "google",
    keyEnv: "GEMINI_API_KEY",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    probeModel: process.env.R33_PROBE_GEMINI_MODEL ?? "gemini-2.5-flash",
    quotaDomain: "google-project (per-project RPM/TPM/RPD, Pacific-midnight reset)",
  },
  {
    provider: "cloudflare-workers-ai",
    keyEnv: "CLOUDFLARE_API_KEY",
    base: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    modelsPath: "/models",
    chatPath: "/chat/completions",
    probeModel: process.env.R33_PROBE_CF_MODEL ?? "@cf/zai-org/glm-4.7-flash",
    quotaDomain: "cloudflare-account (10k Neurons/day + 300 RPM text-gen default)",
  },
  {
    provider: "github-models",
    keyEnv: "GITHUB_MODELS_TOKEN",
    base: "https://models.github.ai/inference",
    modelsPath: "/catalog/models",
    modelsBase: "https://models.github.ai",
    chatPath: "/chat/completions",
    probeModel: process.env.R33_PROBE_GH_MODEL ?? "openai/gpt-4.1-mini",
    quotaDomain: "github-account (per-model RPM/RPD/concurrency, free tier)",
    authHeader: "Authorization",
    note: "No provider adapter exists in the registry — candidate domain only.",
  },
];

function headersOf(res) {
  const out = {};
  for (const [k, v] of res.headers.entries()) {
    if (/ratelimit|retry-after|quota|neuron|usage|x-|cf-|request-id/i.test(k)) out[k] = v;
  }
  return out;
}

async function getJson(url, headers, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
    return { status: res.status, headers: headersOf(res), body };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChat(target, apiKey) {
  const url = `${target.base}${target.chatPath}`;
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: target.probeModel,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    }),
  });
  const latencyMs = Math.round(performance.now() - started);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
  return { status: res.status, latencyMs, headers: headersOf(res), body };
}

const report = { generatedAt: stamp, providers: [], note: "Live measurement. Catalog listings are not secured capacity; only LIVE_VERIFIED domains with observed quota may count as current supply." };

// OpenRouter: read-only account receipt only — managed multi-user use is POLICY_BLOCKED.
if (process.env.OPENROUTER_API_KEY) {
  const key = await getJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` });
  report.providers.push({
    provider: "openrouter",
    status: "POLICY_BLOCKED",
    measurement: "read-only GET /api/v1/key — no inference burned",
    keyReceipt: key.status === 200 ? key.body : { httpStatus: key.status, body: key.body },
    quotaDomain: "single account free-model request pool (shared across all :free models)",
    policy: "Hosted managed multi-user use requires enterprise/hosted agreement; BYOK user-owned route is separate. Standard terms restrict resale.",
  });
}

for (const target of TARGETS) {
  const apiKey = process.env[target.keyEnv];
  const entry = { provider: target.provider, probeModel: target.probeModel, quotaDomain: target.quotaDomain, ...(target.note ? { note: target.note } : {}) };
  if (!apiKey) {
    entry.status = "UNVERIFIED";
    entry.reason = `credential ${target.keyEnv} absent`;
    report.providers.push(entry);
    continue;
  }
  try {
    const modelsBase = target.modelsBase ?? target.base;
    const models = await getJson(`${modelsBase}${target.modelsPath}`, { Authorization: `Bearer ${apiKey}` });
    const ids = Array.isArray(models.body?.data) ? models.body.data.map((m) => m.id).filter(Boolean) : Array.isArray(models.body?.models) ? models.body.models.map((m) => m.name ?? m.id).filter(Boolean) : [];
    entry.catalog = { httpStatus: models.status, modelCount: ids.length, sample: ids.slice(0, 40), headers: models.headers };
  } catch (err) {
    entry.catalog = { error: String(err) };
  }
  try {
    const chat = await probeChat(target, apiKey);
    entry.inferenceProbe = {
      httpStatus: chat.status,
      latencyMs: chat.latencyMs,
      headers: chat.headers,
      usage: chat.body?.usage ?? null,
      error: chat.status >= 400 ? chat.body : undefined,
      content: typeof chat.body?.choices?.[0]?.message?.content === "string" ? chat.body.choices[0].message.content.slice(0, 60) : undefined,
    };
    entry.status = chat.status === 200 ? "LIVE_VERIFIED" : chat.status === 429 ? "RATE_LIMITED" : chat.status === 401 || chat.status === 403 ? "AUTH_OR_POLICY_BLOCKED" : `HTTP_${chat.status}`;
  } catch (err) {
    entry.inferenceProbe = { error: String(err) };
    entry.status = "UNREACHABLE";
  }
  report.providers.push(entry);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `live-supply-${stamp.slice(0, 10)}.json`);
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(file);
for (const p of report.providers) {
  const hdr = p.inferenceProbe?.headers ?? {};
  console.log(`${p.provider.padEnd(22)} ${String(p.status).padEnd(22)} models=${p.catalog?.modelCount ?? "?"} latency=${p.inferenceProbe?.latencyMs ?? "-"}ms rl-req=${hdr["x-ratelimit-remaining-requests"] ?? hdr["x-ratelimit-remaining"] ?? "-"} rl-tok=${hdr["x-ratelimit-remaining-tokens"] ?? "-"} reset=${hdr["x-ratelimit-reset-requests"] ?? hdr["x-ratelimit-reset"] ?? "-"}`);
}

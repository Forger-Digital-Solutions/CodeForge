#!/usr/bin/env node
/**
 * R25 Mission A — live free-provider role qualification.
 *
 * Runs the frozen production suite (`runRoleAwareQualification`: 3 compact probes + 10 role
 * cases, R24_ROLE_QUALIFICATION_V1) against real zero-cost routes whose free-only posture was
 * proven by scripts/r25-live-preflight.mjs. Records per route: provider, model, suite version,
 * per-role verdict, per-case pass/latency/error/retries, request count, observed rate-limit
 * headers, and OpenRouter account usage before/after. Never records secrets, prompts, or model
 * text beyond pass/fail metadata.
 *
 *   node scripts/r25-live-qualification.mjs [--out=<file>] [--routes=openrouter:a/b:free,groq:c/d]
 *                                         [--max-routes=<n>] [--timeout-ms=60000]
 *
 * Zero-spend basis: openrouter :free = $0 unit price observed in the live catalog; groq = owner
 * free-plan account (R23 $0 ledger) with rate-limit headers captured live as plan evidence.
 * Cloudflare/Gemini are absent here because pre-flight returned SKIPPED_FREE_ONLY_NOT_PROVEN.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runRoleAwareQualification } from "@codeforge/eight-bit";
import { createCloudflareAdapter, createFailClosedCloudflareNeuronBudgetGuard, createGroqAdapter, createOpenRouterAdapter, EnvironmentCredentialStore } from "@codeforge/providers";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", `docs/evidence/r25-live-reality/qualification-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const timeoutMs = Number(option("timeout-ms", "60000"));
const maxRoutes = Number(option("max-routes", "8"));

// R26 roster refresh: re-qualify the six R25-QUALIFIED routes (freshness — model revisions drift),
// add two Cloudflare Workers AI routes (newly LIVE_OK in R26 pre-flight — neuron hard-stop makes
// free-only provable), and one previously-untested OpenRouter :free model for coverage.
const DEFAULT_ROUTES = [
  { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free" },
  { providerId: "openrouter", modelId: "nex-agi/nex-n2.5-pro:free" },
  { providerId: "openrouter", modelId: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  { providerId: "groq", modelId: "openai/gpt-oss-120b" },
  { providerId: "groq", modelId: "openai/gpt-oss-20b" },
  { providerId: "groq", modelId: "qwen/qwen3.8-27b" },
  // Cloudflare Workers AI is pre-flight LIVE_OK but NOT qualified here: the adapter and
  // fail-closed neuron guard exist in @codeforge/providers, yet nothing in forge serve
  // instantiates them — a qualified route the runtime cannot route to is not supply.
  // Two previously-untested OpenRouter :free models added for roster freshness instead.
  { providerId: "openrouter", modelId: "thinkingmachines/inkling:free" },
  { providerId: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" },
];

const routesArg = option("routes", undefined);
const routes = (routesArg
  ? routesArg.split(",").map((pair) => {
      const [providerId, modelId] = pair.split(":");
      const idx = pair.indexOf(":");
      return { providerId: pair.slice(0, idx), modelId: pair.slice(idx + 1) };
    })
  : DEFAULT_ROUTES
).slice(0, maxRoutes);



async function openRouterUsage() {
  const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  });
  if (!res.ok) return { status: res.status };
  const body = await res.json().catch(() => null);
  const d = body?.data ?? {};
  return { status: res.status, usage: d.usage ?? null, limit: d.limit ?? null, limitRemaining: d.limit_remaining ?? null, isFreeTier: d.is_free_tier ?? null };
}

function makeAdapter(providerId, observations) {
  // Adapters already strip observations down to quota/rate-limit headers (quotaHeadersOf).
  const onResponse = (obs) => {
    observations.push({
      status: obs.status,
      model: obs.modelId ?? undefined,
      quotaHeaders: Object.fromEntries(obs.headers ?? []),
      observedAt: obs.observedAt,
    });
  };
  if (providerId === "openrouter") return createOpenRouterAdapter({ credentialStore: new EnvironmentCredentialStore(), timeoutMs, onResponse });
  if (providerId === "groq") return createGroqAdapter({ credentialStore: new EnvironmentCredentialStore(), timeoutMs, onResponse });
  if (providerId === "cloudflare-workers-ai") {
    return createCloudflareAdapter({
      credentialStore: new EnvironmentCredentialStore(),
      timeoutMs,
      onResponse,
      // Production posture: fail closed on neuron budget — never estimate past the free cap.
      cloudflareNeuronGuard: createFailClosedCloudflareNeuronBudgetGuard(),
    });
  }
  throw new Error(`no live adapter admitted for ${providerId}`);
}

function recordFor(providerId, modelId) {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "r25-preflight" },
    isRemote: true,
    isCloudHosted: true,
  };
}

const evidence = {
  schemaVersion: 1,
  campaign: "R25 Mission A — live free-provider role qualification",
  generatedAt: new Date().toISOString(),
  zeroSpendBasis: "openrouter :free $0 unit price (live catalog); groq owner free-plan + observed rate-limit headers",
  openrouterUsageBefore: await openRouterUsage().catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) })),
  routes: [],
};

for (const route of routes) {
  const observations = [];
  const adapter = makeAdapter(route.providerId, observations);
  const startedAt = Date.now();
  const entry = { ...route, startedAt: new Date().toISOString(), observations: [] };
  try {
    const receipt = await runRoleAwareQualification(recordFor(route.providerId, route.modelId), adapter, { timeoutMs });
    entry.receipt = {
      suiteVersion: receipt.suiteVersion,
      qualificationState: receipt.qualificationState,
      hardFailureRoles: receipt.hardFailureRoles,
      totalLatencyMs: receipt.totalLatencyMs,
      metadata: receipt.metadata,
      roleResults: Object.fromEntries(
        Object.entries(receipt.roleResults ?? {}).map(([role, r]) => [
          role,
          {
            status: r.status,
            overallScore: r.overallScore,
            hardFailures: r.hardFailures,
            cases: r.testCases.map((c) => ({
              caseId: c.caseId,
              passed: c.passed,
              hardFailure: c.hardFailure === true,
              latencyMs: c.latencyMs,
              retries: c.retries,
              error: c.error?.slice(0, 200),
              details: c.details,
            })),
          },
        ]),
      ),
    };
    entry.wallMs = Date.now() - startedAt;
    console.log(`${receipt.qualificationState.padEnd(16)} ${route.providerId}::${route.modelId} (${entry.wallMs}ms)`);
  } catch (error) {
    entry.error = String(error?.message ?? error).slice(0, 300);
    entry.wallMs = Date.now() - startedAt;
    console.log(`RUNNER_ERROR      ${route.providerId}::${route.modelId} ${entry.error}`);
  }
  entry.observations = observations;
  evidence.routes.push(entry);
}

evidence.openrouterUsageAfter = await openRouterUsage().catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(resolve(out), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`evidence → ${out}`);

#!/usr/bin/env node
// Live free-inference verification. Reads provider keys from the ENVIRONMENT ONLY (never embeds or
// logs them) and drives the real CodeForge free route end-to-end for each connected provider:
//
//   real provider.listModels()  →  discoverAndVerifyFree (ForgeZero overlay, live-catalog evidence)
//     →  register verified-free into ForgeZero  →  ForgeRouter top-5 ranking  →  real streamChat
//
// Only $0-unit verified-free models are used for the inference call, so there is no spend. Prints
// the discovered top-5 and the streamed assistant text. Exit 0 if at least one route streamed text.
//
// Usage:  node scripts/verify-free-inference.mjs
import {
  createOpenRouterAdapter, createZaiAdapter, createGroqAdapter, createGeminiAdapter,
} from "@codeforge/providers";
import { NormalizedModelRegistry, discoverAndVerifyFree, describeVerifiedFree } from "@codeforge/model-registry";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";

const PROMPT = "Explain, in 3 sentences, the architecture of a monorepo that separates a model registry, provider adapters, and a routing firewall.";

const PROVIDERS = [
  { id: "openrouter", env: "OPENROUTER_API_KEY", make: (k) => createOpenRouterAdapter({ apiKey: k }) },
  { id: "groq", env: "GROQ_API_KEY", make: (k) => createGroqAdapter({ apiKey: k }) },
  { id: "google", env: "GEMINI_API_KEY", make: (k) => createGeminiAdapter({ apiKey: k }) },
  { id: "zai", env: "ZHIPU_API_KEY", make: (k) => createZaiAdapter({ apiKey: k }) },
];

function apiKeyFor(p) {
  return process.env[p.env] || (p.id === "google" ? process.env.GOOGLE_API_KEY : undefined) || (p.id === "zai" ? process.env.ZAI_API_KEY : undefined);
}

async function verifyProvider(p) {
  const key = apiKeyFor(p);
  if (!key) return { id: p.id, skipped: "no key in env" };
  const adapter = p.make(key);
  const registry = new NormalizedModelRegistry();
  registry.loadSnapshot();
  const firewall = new ForgeZero();

  // 1. Live discovery + independent verification.
  let live;
  try {
    live = await adapter.listModels();
  } catch (e) {
    return { id: p.id, error: `listModels failed: ${String(e.message || e).slice(0, 160)}` };
  }
  const liveInfos = live.map((m) => ({
    modelId: m.modelId, isFree: m.isFree, displayName: m.displayName,
    contextWindow: m.contextWindow, toolCalling: m.capabilities?.toolCalling, vision: m.capabilities?.vision,
  }));
  const { records, verifiedCount } = discoverAndVerifyFree(registry, p.id, liveInfos);
  for (const rec of records) firewall.register(rec);

  // 2. Deterministic top-5 ranking over verified-free.
  const router = new ForgeRouter({ firewall });
  const top = router.topVerifiedFree(
    { taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] }, 5,
  );

  console.log(`\n=== ${p.id.toUpperCase()} — ${live.length} live models, ${verifiedCount} verified-free ===`);
  top.forEach((r, i) => console.log(`  #${i + 1} ${describeVerifiedFree(r.model)}  score=${r.score}`));
  if (top.length === 0) return { id: p.id, verifiedCount, streamed: 0, note: "no verified-free model to stream" };

  // 3. Real streaming inference on the #1 verified-free ($0) model.
  const chosen = top[0].model;
  console.log(`\n  → streaming from ${chosen.providerId}::${chosen.modelId} (access=${chosen.accessClass})…`);
  let text = "";
  let usage = null;
  try {
    for await (const ev of adapter.streamChat({ model: chosen.modelId, messages: [{ role: "user", content: PROMPT }], maxTokens: 300 })) {
      if (ev.type === "text_delta") { text += ev.delta; process.stdout.write(ev.delta); }
      else if (ev.type === "usage") usage = ev.usage;
    }
  } catch (e) {
    return { id: p.id, verifiedCount, error: `stream failed: ${String(e.message || e).slice(0, 200)}` };
  }
  console.log("\n");
  return { id: p.id, model: `${chosen.providerId}::${chosen.modelId}`, accessClass: chosen.accessClass, verifiedCount, streamedChars: text.length, usage };
}

const results = [];
for (const p of PROVIDERS) {
  try { results.push(await verifyProvider(p)); }
  catch (e) { results.push({ id: p.id, error: String(e.message || e).slice(0, 160) }); }
}

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(" ", JSON.stringify(r));
const proven = results.filter((r) => r.streamedChars > 0);
console.log(`\nProven free routes (streamed real text): ${proven.length}`);
process.exit(proven.length > 0 ? 0 : 1);

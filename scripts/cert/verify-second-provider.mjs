#!/usr/bin/env node
// Second independent free provider — live proof via Groq (FREE_ALLOWANCE) through the product's
// real adapters + allowance-probe verification + real streaming. Reads GROQ_API_KEY from env only.
// A successful probe/stream on the free developer tier IS a no-charge request (allowance).
import { createGroqAdapter } from "@codeforge/providers";
import { NormalizedModelRegistry, verifyAllowanceViaProbe } from "@codeforge/model-registry";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";

const key = process.env.GROQ_API_KEY;
if (!key) { console.error("GROQ_API_KEY not set — IMPLEMENTED_BUT_EXTERNAL_AUTH_NOT_AVAILABLE"); process.exit(2); }

const adapter = createGroqAdapter({ apiKey: key });
const registry = new NormalizedModelRegistry();
registry.loadSnapshot();
const firewall = new ForgeZero();

const live = (await adapter.listModels()).map((m) => ({
  modelId: m.modelId, isFree: m.isFree, displayName: m.displayName, contextWindow: m.contextWindow, toolCalling: m.capabilities?.toolCalling,
}));
console.log(`Groq live models: ${live.length}`);

// Allowance probe: a minimal no-charge request confirms free-tier access for the connected account.
const probe = async (modelId) => {
  try {
    let ok = false;
    for await (const ev of adapter.streamChat({ model: modelId, messages: [{ role: "user", content: "hi" }], maxTokens: 5 })) {
      if (ev.type === "text_delta" || ev.type === "finish") ok = true;
    }
    return { ok };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
};

const { records, verifiedCount } = await verifyAllowanceViaProbe(registry, "groq", live, probe);
for (const rec of records) firewall.register(rec);
console.log(`FREE_ALLOWANCE verified via live probe: ${verifiedCount} models`);
const eligible = firewall.eligibleModels();
console.log(`ForgeZero eligible: ${eligible.length} (e.g. ${eligible.slice(0, 4).map((m) => m.modelId).join(", ")})`);

const router = new ForgeRouter({ firewall });
const top = router.topVerifiedFree({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] }, 3);
console.log("Top ranked:", top.map((r) => `${r.model.modelId}(${r.score})`).join(", "));

const chosen = top[0]?.model;
if (!chosen) { console.log("SECOND_PROVIDER: no eligible model"); process.exit(1); }
console.log(`\n→ real streaming from groq::${chosen.modelId} (access=${chosen.accessClass})…\n`);
let text = "";
let usage = null;
for await (const ev of adapter.streamChat({ model: chosen.modelId, messages: [{ role: "user", content: "In two sentences, what is a model registry in an AI coding tool?" }], maxTokens: 200 })) {
  if (ev.type === "text_delta") { text += ev.delta; process.stdout.write(ev.delta); }
  else if (ev.type === "usage") usage = ev.usage;
}
console.log("\n\n===== SECOND PROVIDER RESULT =====");
console.log(JSON.stringify({ provider: "groq", model: chosen.modelId, accessClass: chosen.accessClass, verifiedCount, streamedChars: text.length, usage }));
console.log("\nSECOND_PROVIDER:", text.length > 0 ? "PASS" : "FAIL");
process.exit(text.length > 0 ? 0 : 1);

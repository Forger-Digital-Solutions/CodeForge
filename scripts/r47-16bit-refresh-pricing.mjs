#!/usr/bin/env node
// R47: refresh 16-Bit price evidence from the live OpenRouter model catalog (free GET, no spend)
// and emit PriceCard records for every registered fallback route. Direct-route pricing stays
// pinned to the registry's CURRENT entries; UNKNOWN stays UNKNOWN unless the catalog reports it.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const OUT = resolve(ROOT, "docs/evidence/r47-16bit/R47-16BIT-PRICING.json");
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const usdPerTokenToMillion = (value) => {
  const micros = Math.round(Number(value) * 1_000_000_000_000);
  const whole = Math.floor(micros / 1_000_000);
  const frac = `${micros % 1_000_000}`.padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${frac || "0"}`;
};

const registry = await import(pathToFileURL(resolve(ROOT, "packages/paid-auto/dist/registry.js")).href).catch(() => null);
const models = registry?.PAID_AUTO_MODELS;
if (!models) {
  console.error("packages/paid-auto/dist not built — run npm run build first");
  process.exit(1);
}

const catalog = await fetch("https://openrouter.ai/api/v1/models").then((r) => {
  if (!r.ok) throw new Error(`OpenRouter catalog HTTP ${r.status}`);
  return r.json();
});
const effectiveAt = new Date().toISOString();

const priceCards = [];
const catalogFindings = [];
for (const model of models) {
  for (const route of [model.direct, model.fallback]) {
    if (route.kind !== "openrouter") continue;
    const entry = catalog.data.find((candidate) => candidate.id === route.providerModelId);
    if (!entry) {
      catalogFindings.push({ routeId: route.routeId, providerModelId: route.providerModelId, found: false });
      continue;
    }
    catalogFindings.push({
      routeId: route.routeId,
      providerModelId: route.providerModelId,
      found: true,
      contextLength: entry.context_length,
      toolsSupported: Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools"),
      promptUsdPerMillion: usdPerTokenToMillion(entry.pricing?.prompt ?? "0"),
      completionUsdPerMillion: usdPerTokenToMillion(entry.pricing?.completion ?? "0"),
    });
    priceCards.push({
      modelIdentity: {
        canonicalModelId: route.canonicalModelId,
        providerId: route.providerId,
        providerModelId: route.providerModelId,
        gatewayModelId: route.providerModelId,
        endpoint: OPENROUTER_ENDPOINT,
      },
      providerIdentity: { providerId: route.providerId, endpoint: OPENROUTER_ENDPOINT },
      canonicalModelId: route.canonicalModelId,
      providerId: route.providerId,
      providerModelId: route.providerModelId,
      uncachedInputUsdPerMillion: usdPerTokenToMillion(entry.pricing?.prompt ?? "0"),
      outputUsdPerMillion: usdPerTokenToMillion(entry.pricing?.completion ?? "0"),
      currency: "USD",
      status: "CURRENT",
      source: "openrouter-catalog-live",
      effectiveAt,
      confidence: "HIGH",
    });
  }
}

mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedAt: effectiveAt, catalogFindings, priceCards }, null, 2));
console.log(`wrote ${OUT}`);
for (const finding of catalogFindings) console.log(JSON.stringify(finding));

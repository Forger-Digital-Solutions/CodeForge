#!/usr/bin/env node
// R47: deterministic 16-Bit shadow routing proof. Runs rank16Bit over role-shaped task profiles
// priced on the live OpenRouter catalog cards from R47-16BIT-PRICING.json. No provider calls,
// no spend — pure decision-surface evidence. Shadow predictor records carry MOCK provenance:
// they describe what the route would recommend, not measured model quality.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const EVIDENCE_DIR = resolve(ROOT, "docs/evidence/r47-16bit");
const PRICING = JSON.parse(readFileSync(resolve(EVIDENCE_DIR, "R47-16BIT-PRICING.json"), "utf8"));

const { rank16Bit } = await import(pathToFileURL(resolve(ROOT, "packages/paid-auto/dist/expected-cost.js")).href);
const { observeSixteenBitShadow } = await import(pathToFileURL(resolve(ROOT, "packages/paid-auto/dist/shadow.js")).href).catch(() => ({ observeSixteenBitShadow: undefined }));

const priceOverrides = {};
for (const card of PRICING.priceCards) {
  priceOverrides[card.canonicalModelId] = {
    inputCostPerMillion: Number(card.uncachedInputUsdPerMillion),
    outputCostPerMillion: Number(card.outputUsdPerMillion),
    source: `${card.source}@${card.effectiveAt}`,
  };
}

const taskProfiles = [
  { role: "EXPLORER", inputTokens: 40000, outputTokens: 1500, requiresTools: true, requiredContextTokens: 128000 },
  { role: "PLANNER", inputTokens: 25000, outputTokens: 3000, requiresTools: false },
  { role: "CODER", inputTokens: 60000, outputTokens: 12000, requiresTools: true },
  { role: "REVIEWER", inputTokens: 45000, outputTokens: 2500, requiresTools: false },
  { role: "MISSION_ROLLUP", inputTokens: 170000, outputTokens: 19000, requiresTools: true },
];

const rankings = [];
for (const task of taskProfiles) {
  const ranking = rank16Bit(task, {}, () => Date.parse(PRICING.generatedAt), { priceOverrides });
  const record = observeSixteenBitShadow?.({
    campaignId: "r47-16bit-shadow",
    requestId: `shadow-${task.role.toLowerCase()}`,
    providerId: "openrouter",
    canonicalModelId: ranking.selected ?? "none",
    routeId: `${ranking.selected ?? "none"}:openrouter`,
    expectedTotalTaskCostUsd: ranking.candidates.find((c) => c.canonicalModelId === ranking.selected)?.expectedCostUsd?.toFixed(6),
  }, { enabled: true, provenance: "MOCK" });
  rankings.push({
    task: task.role,
    priceBasis: "openrouter-fallback-live",
    selected: ranking.selected ?? null,
    candidates: ranking.candidates.map((c) => ({
      canonicalModelId: c.canonicalModelId,
      attemptCostUsd: Number(c.attemptCostUsd.toFixed(6)),
      expectedAttempts: Number(c.expectedAttempts.toFixed(3)),
      expectedCostUsd: Number.isFinite(c.expectedCostUsd) ? Number(c.expectedCostUsd.toFixed(6)) : "excluded",
      successRate: c.successRate,
      fullyMeasured: c.fullyMeasured,
      reasonCodes: c.reasonCodes,
      ...(c.excluded ? { excluded: c.excluded } : {}),
    })),
    shadowRecommendation: record?.shadowRecommendation ?? null,
  });
}

mkdirSync(EVIDENCE_DIR, { recursive: true });
const out = {
  generatedAt: new Date().toISOString(),
  pricingEvidence: "R47-16BIT-PRICING.json",
  evidenceState: "UNMEASURED — ranker defaults apply; qualification evidence arrives in Phase B live stage",
  rankings,
};
writeFileSync(resolve(EVIDENCE_DIR, "R47-16BIT-ROUTER-SHADOW.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(rankings.map((r) => ({ task: r.task, selected: r.selected, cost: r.candidates[0]?.expectedCostUsd })), null, 1));

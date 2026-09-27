#!/usr/bin/env node
// R47: re-rank 16-Bit with MEASURED role-qualification evidence (live, receipted) instead of
// ranker defaults. Emits R47-16BIT-MEASURED-RANKING.json — the honest post-qualification
// decision surface. No provider calls; pure evidence synthesis.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const EVIDENCE_DIR = resolve(ROOT, "docs/evidence/r47-16bit");
const PRICING = JSON.parse(readFileSync(resolve(EVIDENCE_DIR, "R47-16BIT-PRICING.json"), "utf8"));
const { rank16Bit } = await import(pathToFileURL(resolve(ROOT, "packages/paid-auto/dist/expected-cost.js")).href);

const MODELS = ["deepseek-v4.1-flash", "glm-5.3-flash", "qwen3.8-flash", "gpt-5.6-luna"];
const quals = Object.fromEntries(MODELS.map((id) => {
  const file = resolve(EVIDENCE_DIR, `R47-16BIT-QUALIFY-${id}.json`);
  return [id, JSON.parse(readFileSync(file, "utf8"))];
}));

const TIER_SCORE = { QUALIFIED: 1.0, PROBATION: 0.55, NOT_QUALIFIED: 0.05, HARD_FAILURE: 0.0, NOT_TESTED: undefined };

function evidenceFor(modelId, role) {
  const res = quals[modelId]?.result?.roleResults?.[role];
  if (!res || res.status === "NOT_TESTED") return {};
  const cases = res.testCases ?? [];
  const scored = cases.filter((c) => !c.error);
  const passRate = scored.length ? scored.filter((c) => c.passed).length / scored.length : undefined;
  const ev = { roleFit: TIER_SCORE[res.status] };
  if (passRate !== undefined) {
    ev.successRate = Math.max(0.05, passRate);
    if (res.status === "HARD_FAILURE") ev.successRate = Math.min(ev.successRate, 0.2);
  }
  const toolRates = cases.map((c) => c.details?.validToolCallRate).filter((v) => typeof v === "number");
  if (toolRates.length) ev.toolReliability = toolRates.reduce((a, b) => a + b, 0) / toolRates.length;
  return ev;
}

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

const ROLE_MAP = { EXPLORER: "EXPLORER", PLANNER: "PLANNER", CODER: "CODER", REVIEWER: "REVIEWER", MISSION_ROLLUP: "CODER" };
const rankings = taskProfiles.map((task) => {
  const evidence = Object.fromEntries(MODELS.map((m) => [m, evidenceFor(m, ROLE_MAP[task.role])]));
  const ranking = rank16Bit(task, evidence, () => Date.parse(PRICING.generatedAt), { priceOverrides });
  return {
    task: task.role,
    evidenceSummary: Object.fromEntries(MODELS.map((m) => [m, quals[m].result.roleResults?.[ROLE_MAP[task.role]]?.status ?? "NO_DATA"])),
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
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  basis: "live qualification receipts (R47-16BIT-QUALIFY-*.json) + live OpenRouter price cards",
  evidenceState: "MEASURED where roleResults exist; conservative defaults where NOT_TESTED",
  rankings,
};
writeFileSync(resolve(EVIDENCE_DIR, "R47-16BIT-MEASURED-RANKING.json"), JSON.stringify(out, null, 2));
for (const r of rankings) console.log(r.task.padEnd(14), "→", r.selected, "|", JSON.stringify(r.evidenceSummary));

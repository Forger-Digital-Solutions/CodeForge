#!/usr/bin/env node
/**
 * R23 report generator (protocol §17): recomputes every summary number from raw run records.
 *
 *   node scripts/r23-efficiency-report.mjs --phase pilot [--phase main] [--out summaries/pilot]
 *
 * Reads docs/evidence/r23-efficiency-proof/raw/<phase>/*.json, drops runs named in
 * raw/exclusions.jsonl (reported, never hidden), pairs control/optimized runs, and writes
 * summaries/<name>.json + .md with per-arm totals, headline metrics, paired differences, bootstrap
 * intervals (pairs resampled, seed recorded), Wilcoxon check, per-class breakdown and the §9
 * verdict inputs. It never edits raw records.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparePairs, pairRecords, validateRunRecord } from "@codeforge/forgegreen-campaign";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const EVIDENCE = path.join(ROOT, "docs", "evidence", "r23-efficiency-proof");

const args = process.argv.slice(2);
const phases = [];
let outName;
let campaignFilter;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--phase") phases.push(args[++i]);
  else if (args[i] === "--out") outName = args[++i];
  else if (args[i] === "--campaign") campaignFilter = args[++i];
}
if (phases.length === 0) {
  console.error("usage: r23-efficiency-report.mjs --phase <phase> [--phase <phase>] [--campaign <id>] [--out <name>]");
  process.exit(2);
}

const exclusionsPath = path.join(EVIDENCE, "raw", "exclusions.jsonl");
const exclusions = fs.existsSync(exclusionsPath) ? fs.readFileSync(exclusionsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const excludedRunIds = new Set(exclusions.map((entry) => entry.runId).filter(Boolean));
const excludedPairIds = new Set(exclusions.map((entry) => entry.pairId).filter(Boolean));

const records = [];
const invalid = [];
for (const phase of phases) {
  const dir = path.join(EVIDENCE, "raw", phase);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("campaign-"))) {
    try {
      const record = validateRunRecord(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
      if (campaignFilter && record.identity.campaignId !== campaignFilter) continue;
      records.push(record);
    } catch (error) {
      invalid.push({ file, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
}
const excluded = records.filter((r) => excludedRunIds.has(r.identity.runId) || excludedPairIds.has(r.identity.pairId));
const included = records.filter((r) => !excludedRunIds.has(r.identity.runId) && !excludedPairIds.has(r.identity.pairId));
const { pairs, unpaired } = pairRecords(included);
const comparison = comparePairs(pairs);

const fmt = (value, digits = 2) => (value === undefined || value === null || Number.isNaN(value) ? "—" : typeof value === "number" ? Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits }) : String(value));
const pct = (value) => (value === undefined ? "—" : `${(100 * value).toFixed(1)}%`);
const interval = (ci, digits = 2) => (ci ? `${fmt(ci.estimate, digits)} [${fmt(ci.lower, digits)}, ${fmt(ci.upper, digits)}]` : "—");

const summary = {
  generatedAt: new Date().toISOString(),
  phases,
  campaignFilter: campaignFilter ?? null,
  protocolDigests: [...new Set(records.map((r) => r.identity.protocolDigest))],
  models: [...new Set(records.map((r) => `${r.identity.providerId}::${r.identity.modelId}`))],
  codeforgeCommits: [...new Set(records.map((r) => r.identity.codeforgeCommit))],
  records: { total: records.length, included: included.length, excluded: excluded.length, invalid: invalid.length, unpaired: unpaired.length },
  exclusions: exclusions.filter((entry) => records.some((r) => r.identity.runId === entry.runId || r.identity.pairId === entry.pairId)),
  invalid,
  unpairedRunIds: unpaired.map((r) => r.identity.runId),
  comparison,
  perPair: pairs.map((p) => ({
    taskId: p.taskId,
    taskClass: p.taskClass,
    repetition: p.repetition,
    control: { runId: p.control.identity.runId, classification: p.control.outcome.classification, tokens: p.control.inference.totalTokens.value ?? null, calls: p.control.inference.modelCalls, wallMs: p.control.time.wallClockMs, topology: p.control.identity.topology },
    optimized: { runId: p.optimized.identity.runId, classification: p.optimized.outcome.classification, tokens: p.optimized.inference.totalTokens.value ?? null, calls: p.optimized.inference.modelCalls, wallMs: p.optimized.time.wallClockMs, topology: p.optimized.identity.topology },
    tokenDifference: p.control.inference.totalTokens.value !== undefined && p.optimized.inference.totalTokens.value !== undefined ? p.optimized.inference.totalTokens.value - p.control.inference.totalTokens.value : null,
  })),
};

const name = outName ?? phases.join("+");
const outDir = path.join(EVIDENCE, "summaries");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);

const c = comparison.control;
const o = comparison.optimized;
const md = [];
md.push(`# R23 summary — ${name}`);
md.push("");
md.push(`Generated ${summary.generatedAt} from ${records.length} raw record(s) in raw/{${phases.join(",")}}; ${included.length} included, ${excluded.length} excluded (listed below), ${invalid.length} invalid, ${unpaired.length} unpaired. Pairs analysed: **${comparison.pairs}** (${comparison.pairsWithKnownTokens} with provider-reported tokens in both arms).`);
md.push(`Models: ${summary.models.join(", ") || "—"} · CodeForge commits: ${summary.codeforgeCommits.map((s) => s.slice(0, 8)).join(", ")} · protocol digests: ${summary.protocolDigests.map((s) => s.slice(0, 12)).join(", ")}`);
md.push("");
md.push("## Per-arm totals");
md.push("");
md.push("| Metric | Control (A) | Optimized (B) |");
md.push("|---|---:|---:|");
const rows = [
  ["runs", c.totals.runs, o.totals.runs],
  ["verified complete", c.totals.verified, o.totals.verified],
  ["verified success rate", pct(c.headline.verifiedSuccessRate), pct(o.headline.verifiedSuccessRate)],
  ["claimed complete", c.totals.claimed, o.totals.claimed],
  ["false completions", c.totals.falseComplete, o.totals.falseComplete],
  ["false completion rate", pct(c.headline.falseCompletionRate), pct(o.headline.falseCompletionRate)],
  ["verification failed / budget exhausted / provider failures / severe", `${c.totals.verificationFailed} / ${c.totals.budgetExhausted} / ${c.totals.providerFailures} / ${c.totals.severeFailures}`, `${o.totals.verificationFailed} / ${o.totals.budgetExhausted} / ${o.totals.providerFailures} / ${o.totals.severeFailures}`],
  ["runs with provider-reported tokens", `${c.totals.runsWithKnownTokens}/${c.totals.runs}`, `${o.totals.runsWithKnownTokens}/${o.totals.runs}`],
  ["total model tokens", fmt(c.totals.totalTokens, 0), fmt(o.totals.totalTokens, 0)],
  ["input / output tokens", `${fmt(c.totals.inputTokens, 0)} / ${fmt(c.totals.outputTokens, 0)}`, `${fmt(o.totals.inputTokens, 0)} / ${fmt(o.totals.outputTokens, 0)}`],
  ["cached input tokens", fmt(c.totals.cachedTokens, 0), fmt(o.totals.cachedTokens, 0)],
  ["model calls (failed / retried / rate-limited)", `${c.totals.modelCalls} (${c.totals.failedCalls} / ${c.totals.retriedCalls} / ${c.totals.rateLimitedCalls})`, `${o.totals.modelCalls} (${o.totals.failedCalls} / ${o.totals.retriedCalls} / ${o.totals.rateLimitedCalls})`],
  ["tool calls requested", c.totals.toolCalls, o.totals.toolCalls],
  ["avoidable duplicate context bytes (§10)", fmt(c.totals.avoidableDuplicateBytes, 0), fmt(o.totals.avoidableDuplicateBytes, 0)],
  ["transmitted context bytes", fmt(c.totals.transmittedContextBytes, 0), fmt(o.totals.transmittedContextBytes, 0)],
  ["wall clock (s) / active agent (s) / model wait (s) / rate-limit wait (s)", `${fmt(c.totals.wallClockMs / 1000, 0)} / ${fmt(c.totals.activeAgentMs / 1000, 0)} / ${fmt(c.totals.modelWaitMs / 1000, 0)} / ${fmt(c.totals.rateLimitWaitMs / 1000, 0)}`, `${fmt(o.totals.wallClockMs / 1000, 0)} / ${fmt(o.totals.activeAgentMs / 1000, 0)} / ${fmt(o.totals.modelWaitMs / 1000, 0)} / ${fmt(o.totals.rateLimitWaitMs / 1000, 0)}`],
  ["actual cost (USD)", fmt(c.totals.actualCostUsd, 6), fmt(o.totals.actualCostUsd, 6)],
  ["equivalent public-API cost (USD)", fmt(c.totals.equivalentPublicApiCostUsd, 6), fmt(o.totals.equivalentPublicApiCostUsd, 6)],
  ["equivalent market cost (USD, reference)", fmt(c.totals.equivalentMarketCostUsd, 6), fmt(o.totals.equivalentMarketCostUsd, 6)],
  ["harness CPU ms (user+system)", fmt(c.totals.cpuMs, 0), fmt(o.totals.cpuMs, 0)],
];
for (const [label, a, b] of rows) md.push(`| ${label} | ${a} | ${b} |`);
md.push("");
md.push("## Headline metrics (protocol §8.1)");
md.push("");
md.push("| Metric | Control (A) | Optimized (B) |");
md.push("|---|---:|---:|");
md.push(`| verified tasks per 1M model tokens | ${fmt(c.headline.verifiedTasksPer1MTokens, 3)} | ${fmt(o.headline.verifiedTasksPer1MTokens, 3)} |`);
md.push(`| model tokens per verified task | ${fmt(c.headline.tokensPerVerifiedTask, 0)} | ${fmt(o.headline.tokensPerVerifiedTask, 0)} |`);
md.push(`| verified tasks per 100 model calls | ${fmt(c.headline.verifiedTasksPer100Calls, 2)} | ${fmt(o.headline.verifiedTasksPer100Calls, 2)} |`);
md.push(`| verified tasks per $1 equivalent public-API inference | ${fmt(c.headline.verifiedTasksPerDollarEquivalent, 1)} | ${fmt(o.headline.verifiedTasksPerDollarEquivalent, 1)} |`);
md.push(`| equivalent cost per verified task (USD) | ${fmt(c.headline.equivalentCostPerVerifiedTask, 6)} | ${fmt(o.headline.equivalentCostPerVerifiedTask, 6)} |`);
md.push(`| wall clock per verified task (s) | ${fmt(c.headline.wallMsPerVerifiedTask !== undefined ? c.headline.wallMsPerVerifiedTask / 1000 : undefined, 1)} | ${fmt(o.headline.wallMsPerVerifiedTask !== undefined ? o.headline.wallMsPerVerifiedTask / 1000 : undefined, 1)} |`);
md.push("");
md.push("## Paired differences (optimized − control) and 95% bootstrap intervals (pairs resampled)");
md.push("");
const d = comparison.differences;
md.push(`- total tokens per task: mean ${fmt(d.totalTokens?.mean, 0)}, median ${fmt(d.totalTokens?.median, 0)}, IQR [${fmt(d.totalTokens?.p25, 0)}, ${fmt(d.totalTokens?.p75, 0)}] over ${d.totalTokens?.n ?? 0} pairs; mean of per-pair % change ${fmt(d.totalTokensPct?.mean, 1)}%`);
md.push(`- mean token difference 95% CI: ${interval(comparison.intervals.meanTokenDifference, 0)} (seed ${comparison.intervals.meanTokenDifference?.seed ?? "—"}, ${comparison.intervals.meanTokenDifference?.resamples ?? "—"} resamples)`);
md.push(`- ratio of total tokens B/A 95% CI: ${interval(comparison.intervals.tokenRatioOfTotals, 3)}`);
md.push(`- verified-rate difference B−A 95% CI: ${interval(comparison.intervals.verifiedRateDifference, 3)}`);
md.push(`- ratio of verified-tasks-per-1M-tokens B/A 95% CI: ${interval(comparison.intervals.verifiedPer1MTokensRatio, 3)}`);
md.push(`- model calls per task: mean ${fmt(d.modelCalls?.mean, 2)}, median ${fmt(d.modelCalls?.median, 1)}`);
md.push(`- wall clock per task (s): mean ${fmt(d.wallClockMs ? d.wallClockMs.mean / 1000 : undefined, 1)}, median ${fmt(d.wallClockMs ? d.wallClockMs.median / 1000 : undefined, 1)}`);
md.push(`- verified pattern: both ${d.verified.both}, only control ${d.verified.onlyControl}, only optimized ${d.verified.onlyOptimized}, neither ${d.verified.neither}`);
md.push(`- Wilcoxon signed-rank on token differences: n=${comparison.wilcoxonTokens.n}, W+=${fmt(comparison.wilcoxonTokens.wPlus, 1)}, W−=${fmt(comparison.wilcoxonTokens.wMinus, 1)}${comparison.wilcoxonTokens.pTwoSided !== undefined ? `, p≈${comparison.wilcoxonTokens.pTwoSided.toFixed(4)}` : " (n<10: no p-value)"}`);
md.push("");
md.push("## By task class");
md.push("");
md.push("| Class | Pairs | Control verified | Optimized verified | Mean token difference |");
md.push("|---|---:|---:|---:|---:|");
for (const [cls, entry] of Object.entries(comparison.byClass)) md.push(`| ${cls} | ${entry.pairs} | ${entry.controlVerified} | ${entry.optimizedVerified} | ${fmt(entry.meanTokenDifference, 0)} |`);
md.push("");
md.push("## Verdict inputs (protocol §9)");
md.push("");
const v = comparison.verdictInputs;
md.push(`- non-inferiority: rate difference ${pct(v.nonInferiority.rateDifference)}; CI lower bound ${v.nonInferiority.lowerBound === undefined ? "—" : pct(v.nonInferiority.lowerBound)}; passes ≥ −5 pp with lower bound > −10 pp: **${v.nonInferiority.passes === undefined ? "n/a" : v.nonInferiority.passes}**`);
md.push(`- false-completion guard (B ≤ A + 2 pp): control ${v.falseCompletionGuard.control}, optimized ${v.falseCompletionGuard.optimized}: **${v.falseCompletionGuard.passes}**`);
md.push(`- token saving: CI excludes zero **${v.tokenSaving.intervalExcludesZero ?? "n/a"}**, direction **${v.tokenSaving.direction}**`);
md.push("");
md.push("## Per pair");
md.push("");
md.push("| Task | Class | Rep | Control | Optimized | Δ tokens |");
md.push("|---|---|---:|---|---|---:|");
for (const p of summary.perPair) md.push(`| ${p.taskId} | ${p.taskClass} | ${p.repetition} | ${p.control.classification} · ${p.control.calls} calls · ${fmt(p.control.tokens, 0)} tok · ${fmt(p.control.wallMs / 1000, 0)}s · ${p.control.topology} | ${p.optimized.classification} · ${p.optimized.calls} calls · ${fmt(p.optimized.tokens, 0)} tok · ${fmt(p.optimized.wallMs / 1000, 0)}s · ${p.optimized.topology} | ${fmt(p.tokenDifference, 0)} |`);
if (summary.exclusions.length > 0) {
  md.push("");
  md.push("## Exclusions applied (raw/exclusions.jsonl)");
  md.push("");
  for (const entry of summary.exclusions) md.push(`- ${entry.timestamp} · ${entry.taskId ?? "—"} · run ${entry.runId ?? "—"} · pair ${entry.pairId ?? "—"} · rule ${entry.protocolRule}: ${entry.reason}`);
}
if (invalid.length > 0) {
  md.push("");
  md.push("## Invalid records (failed schema validation — investigate, never delete)");
  for (const entry of invalid) md.push(`- ${entry.file}: ${entry.error}`);
}
md.push("");
md.push("_Every number above is recomputed from the raw run records by scripts/r23-efficiency-report.mjs; nothing is hand-entered._");
fs.writeFileSync(path.join(outDir, `${name}.md`), `${md.join("\n")}\n`);
console.log(`summary → ${path.relative(ROOT, path.join(outDir, `${name}.md`))} (${comparison.pairs} pairs, ${included.length} runs included, ${excluded.length} excluded)`);

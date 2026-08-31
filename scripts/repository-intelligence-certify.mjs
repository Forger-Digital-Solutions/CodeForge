import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRepositoryIntelligence } from "../packages/repo-intelligence/dist/index.js";
import { buildContextPack } from "../packages/context/dist/index.js";

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function directorySize(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

function generateRepository(targetLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codeforge-${targetLines}-loc-`));
  const linesPerModule = 1_000;
  const modules = Math.max(100, Math.ceil(targetLines / linesPerModule));
  fs.mkdirSync(path.join(root, "packages", "modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "generated-benchmark", private: true, workspaces: ["packages/*"] }));
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\nnoise-generated/\n");
  for (let index = 0; index < modules; index++) {
    const previous = index ? `import { NeedleService${index - 1} } from './module-${index - 1}.js';\n` : "";
    const header = `${previous}export class NeedleService${index} { execute(value: number): number { return value + ${index}; } }\n`;
    const padding = Array.from({ length: linesPerModule - header.split("\n").length + 1 }, (_, line) => `// deterministic noise ${index}:${line}`).join("\n");
    fs.writeFileSync(path.join(root, "packages", "modules", `module-${index}.ts`), `${header}${padding}\n`);
    if (index % 100 === 0) fs.writeFileSync(path.join(root, "tests", `module-${index}.test.ts`), `import { NeedleService${index} } from '../packages/modules/module-${index}.js';\nit('needle ${index}', () => new NeedleService${index}().execute(1));\n`);
  }
  return { root, modules, lines: modules * linesPerModule };
}

async function evaluate(root, generated) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-index-certification-"));
  let peakRss = process.memoryUsage().rss;
  const intelligence = createRepositoryIntelligence({ cacheRoot: cache, batchSize: 100, onProgress: () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); } });
  const identity = await intelligence.openWorkspace(root);
  const started = performance.now();
  const status = await intelligence.indexWorkspace();
  const indexTimeMs = performance.now() - started;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const knownAnswers = generated
    ? Array.from({ length: Math.min(10, generated.modules) }, (_, offset) => {
        const index = Math.floor(offset * (generated.modules - 1) / Math.max(1, Math.min(10, generated.modules) - 1));
        return { query: `NeedleService${index}`, expected: `packages/modules/module-${index}.ts` };
      })
    : [
        { query: "ForgeZero", expected: "packages/forge-zero/src/firewall.ts" },
        { query: "GitHub OAuth", expected: "packages/cloud-auth/src/github-oauth.ts" },
        { query: "approval lifecycle", expected: "packages/server/src/approval-service.ts" },
        { query: "What tests cover Direct BYOK Cloud outage?", expected: "tests/direct-byok-cloud-outage.test.ts" },
        { query: "What code starts the Electron local server?", expected: "apps/desktop/src/main.ts" },
        { query: "packages/cloud-db/package.json", expected: "packages/cloud-db/package.json" },
      ];
  const ranks = [];
  const answers = [];
  for (const answer of knownAnswers) {
    const result = await intelligence.findRelevantContext(answer.query, { limit: 10 });
    const rank = result.items.findIndex((item) => item.path === answer.expected) + 1;
    ranks.push(rank || Infinity);
    answers.push({ ...answer, rank: rank || null, top: result.items.slice(0, 5).map((item) => item.path) });
  }
  const latencies = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    const before = performance.now();
    await intelligence.findRelevantContext(knownAnswers[iteration % knownAnswers.length].query, { limit: 10 });
    latencies.push(performance.now() - before);
  }

  let incrementalLatencyMs = null;
  if (generated) {
    const target = "packages/modules/module-0.ts";
    const absolute = path.join(root, target);
    fs.appendFileSync(absolute, "export const incrementalNeedle = true;\n");
    const before = performance.now();
    await intelligence.refresh([target]);
    incrementalLatencyMs = performance.now() - before;
  }

  const contextResults = [];
  for (const contextWindow of [16_000, 32_000, 64_000, 128_000]) {
    const pack = await buildContextPack(knownAnswers[0].query, intelligence, { contextWindow, systemPromptTokens: 1_000, toolSchemaTokens: 1_000, reservedOutputTokens: 1_000, safetyMarginTokens: 512 });
    contextResults.push({ contextWindow, repositoryBudget: pack.budget.repository, tokens: pack.tokenEstimate, overflow: pack.tokenEstimate > pack.budget.repository, selectedFiles: pack.selectedFiles, relevantTests: pack.relevantTests.map((test) => test.path), provenanceComplete: pack.chunks.every((chunk) => chunk.provenance.fresh && chunk.provenance.contentHash && chunk.provenance.selectionReasons.length > 0) });
  }
  const indexSizeBytes = directorySize(path.dirname(status.indexPath));
  const result = {
    workspaceId: identity.id,
    root,
    files: status.fileCount,
    symbols: status.symbolCount,
    edges: status.edgeCount,
    parserFailures: status.errorCount,
    status: status.state,
    indexVersion: status.indexVersion,
    indexTimeMs,
    peakRssBytes: peakRss,
    indexSizeBytes,
    queryP50Ms: percentile(latencies, 0.5),
    queryP95Ms: percentile(latencies, 0.95),
    incrementalLatencyMs,
    recallAt1: ranks.filter((rank) => rank <= 1).length / ranks.length,
    recallAt5: ranks.filter((rank) => rank <= 5).length / ranks.length,
    recallAt10: ranks.filter((rank) => rank <= 10).length / ranks.length,
    mrr: ranks.reduce((sum, rank) => sum + (Number.isFinite(rank) ? 1 / rank : 0), 0) / ranks.length,
    answers,
    contextResults,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model,
    memoryBytes: os.totalmem(),
  };
  await intelligence.closeWorkspace();
  fs.rmSync(cache, { recursive: true, force: true });
  return result;
}

const tier = process.argv.find((argument) => argument.startsWith("--tier="))?.split("=")[1];
if (tier) {
  const lines = Number(tier.replace(/m$/i, "000000").replace(/k$/i, "000"));
  const generated = generateRepository(lines);
  try { console.log(JSON.stringify(await evaluate(generated.root, generated), null, 2)); }
  finally { fs.rmSync(generated.root, { recursive: true, force: true }); }
} else {
  console.log(JSON.stringify(await evaluate(process.cwd()), null, 2));
}

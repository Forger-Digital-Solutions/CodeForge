import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRepositoryIntelligence } from "../packages/repo-intelligence/dist/index.js";
import { buildContextPack } from "../packages/context/dist/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-retrieval-ab-"));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-retrieval-ab-cache-"));
const source = path.join(root, "src");
const tests = path.join(root, "tests");
fs.mkdirSync(source); fs.mkdirSync(tests);
const targetIndex = 777;
for (let index = 0; index < 1_000; index++) {
  const name = `module-${String(index).padStart(4, "0")}.ts`;
  const marker = index === targetIndex ? "export function repairExpiryReplay(token: Token): Token { return token; }" : `export function helper${index}(value: number): number { return value + ${index}; }`;
  fs.writeFileSync(path.join(source, name), `${marker}\n${"// irrelevant implementation noise\n".repeat(40)}`);
}
fs.writeFileSync(path.join(tests, "expiry-replay.test.ts"), `import { repairExpiryReplay } from '../src/module-0777.js';\nit('rejects expired replay', () => repairExpiryReplay({}));\n`);

try {
  const task = "Fix the token-expiration replay bug without changing the public API and run relevant tests";
  const baselineStarted = performance.now();
  let baselineFilesOpened = 0;
  let baselineBytes = 0;
  let baselineTarget;
  for (const name of fs.readdirSync(source).sort()) {
    const content = fs.readFileSync(path.join(source, name), "utf8");
    baselineFilesOpened++;
    baselineBytes += Buffer.byteLength(content);
    if (content.includes("repairExpiryReplay")) { baselineTarget = `src/${name}`; break; }
  }
  const baselineMs = performance.now() - baselineStarted;

  const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
  await intelligence.openWorkspace(root); await intelligence.indexWorkspace();
  const enabledStarted = performance.now();
  const result = await intelligence.findRelevantContext("repairExpiryReplay token expiration replay", { limit: 5 });
  const pack = await buildContextPack(task, intelligence, { contextWindow: 16_000, mentionedPaths: result.items.slice(0, 1).map((item) => item.path) });
  const enabledMs = performance.now() - enabledStarted;
  const enabledFilesOpened = pack.selectedFiles.length;
  const enabledBytes = pack.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.content), 0);
  const target = "src/module-0777.ts";
  const output = {
    task,
    corpusFiles: 1_001,
    withoutIntelligence: { success: baselineTarget === target, filesOpened: baselineFilesOpened, irrelevantFilesOpened: baselineFilesOpened - 1, toolCalls: baselineFilesOpened, contextBytes: baselineBytes, elapsedMs: baselineMs },
    withIntelligence: { success: result.items.some((item) => item.path === target) && pack.selectedFiles.includes(target), filesOpened: enabledFilesOpened, irrelevantFilesOpened: pack.selectedFiles.filter((item) => item !== target && item !== "tests/expiry-replay.test.ts").length, toolCalls: 2, contextBytes: enabledBytes, contextTokens: pack.tokenEstimate, elapsedMs: enabledMs, relatedTests: pack.relevantTests.map((test) => test.path) },
  };
  console.log(JSON.stringify(output, null, 2));
  await intelligence.closeWorkspace();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
}

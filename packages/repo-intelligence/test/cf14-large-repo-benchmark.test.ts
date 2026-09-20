import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "../src/index.js";
import { buildContextPack } from "@codeforge/context";

const cleanupDirs: string[] = [];

// Single-shot wall-clock samples flake under parallel-suite CPU contention: a median of 3
// keeps the absolute bounds meaningful without letting one scheduler hiccup fail the run.
async function medianLatencyMs<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const samples: number[] = [];
  let result!: T;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    result = await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[1]!, result };
}

function generateLargeRepository(totalLines: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf14-1m-loc-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cf14-1m-cache-"));
  cleanupDirs.push(root, cache);

  const linesPerModule = 1_000;
  const moduleCount = Math.ceil(totalLines / linesPerModule);

  fs.mkdirSync(path.join(root, "packages", "modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "cf14-benchmark-large", private: true, workspaces: ["packages/*"] }),
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");

  for (let i = 0; i < moduleCount; i++) {
    const prevImport = i > 0 ? `import { BenchmarkService${i - 1} } from './module-${i - 1}.js';\n` : "";
    const header = `${prevImport}export class BenchmarkService${i} {\n  execute(v: number): number { return v + ${i}; }\n}\n`;
    const padding = Array.from(
      { length: linesPerModule - header.split("\n").length + 1 },
      (_, line) => `// synthetic deterministic code line ${i}:${line}`,
    ).join("\n");
    fs.writeFileSync(path.join(root, "packages", "modules", `module-${i}.ts`), `${header}${padding}\n`);

    if (i % 100 === 0) {
      fs.writeFileSync(
        path.join(root, "tests", `module-${i}.test.ts`),
        `import { BenchmarkService${i} } from '../packages/modules/module-${i}.js';\nit('executes', () => new BenchmarkService${i}().execute(1));\n`,
      );
    }
  }

  return { root, cache, moduleCount, lines: moduleCount * linesPerModule };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("CF-14 Million-Line Repository Target & Benchmark", () => {
  it("indexes a deterministic 1,000,000+ line repository and measures all query latencies", async () => {
    // Generate 1,000 modules * 1,000 lines = 1,000,000+ lines
    const { root, cache, moduleCount, lines } = generateLargeRepository(1_000_000);
    expect(lines).toBeGreaterThanOrEqual(1_000_000);

    const intel = createRepositoryIntelligence({ cacheRoot: cache, batchSize: 200 });
    await intel.openWorkspace(root);

    // Initial index
    const indexStart = performance.now();
    const status = await intel.indexWorkspace();
    const indexWallMs = performance.now() - indexStart;

    expect(status.state).toBe("READY");
    expect(status.fileCount).toBeGreaterThanOrEqual(moduleCount);
    expect(status.symbolCount).toBeGreaterThanOrEqual(moduleCount);
    expect(status.edgeCount).toBeGreaterThanOrEqual(moduleCount - 1);
    expect(indexWallMs).toBeLessThan(120_000); // broad anti-pathology bound

    // Measure Symbol lookup latency
    const sym = await medianLatencyMs(() => intel.searchSymbols("BenchmarkService500"));
    expect(sym.result.items.length).toBeGreaterThan(0);
    expect(sym.result.items[0].name).toBe("BenchmarkService500");
    expect(sym.ms).toBeLessThan(100);

    // Measure Dependency lookup latency
    const dep = await medianLatencyMs(() => intel.findDependencies("packages/modules/module-500.ts"));
    expect(dep.result.items.length).toBeGreaterThan(0);
    expect(dep.ms).toBeLessThan(50);

    // Measure Text search latency
    const text = await medianLatencyMs(() => intel.searchText("BenchmarkService500"));
    expect(text.result.items.length).toBeGreaterThan(0);
    expect(text.ms).toBeLessThan(200);

    // Measure Context Retrieval latency within budget
    const ctx = await medianLatencyMs(() =>
      buildContextPack("Fix BenchmarkService500 execution", intel, { contextWindow: 32_000 }));
    expect(ctx.result.selectedFiles).toContain("packages/modules/module-500.ts");
    expect(ctx.result.tokenEstimate).toBeLessThanOrEqual(ctx.result.budget.repository);
    expect(ctx.ms).toBeLessThan(500);

    // Measure One-File Incremental Update time and reparsed count
    const targetFile = path.join(root, "packages", "modules", "module-500.ts");
    fs.appendFileSync(targetFile, "\nexport const incrementalNeedle = true;\n");
    const incStart = performance.now();
    const incRefresh = await intel.refresh(["packages/modules/module-500.ts"]);
    const incLatencyMs = performance.now() - incStart;

    expect(incRefresh.filesParsed).toBe(1);
    expect(incRefresh.changed).toEqual(["packages/modules/module-500.ts"]);
    expect(incLatencyMs).toBeLessThan(2_000); // 1-file update must be orders of magnitude faster

    // Measure Repeated Query Reuse (0 filesystem rescan, 0 reparsing)
    const repeated = await medianLatencyMs(() => intel.searchSymbols("BenchmarkService500"));
    expect(repeated.result.items[0].name).toBe("BenchmarkService500");
    expect(repeated.ms).toBeLessThan(50);

    await intel.closeWorkspace();
  }, 180_000);
});

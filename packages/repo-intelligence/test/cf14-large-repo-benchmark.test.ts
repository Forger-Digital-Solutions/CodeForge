import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "../src/index.js";
import { buildContextPack } from "@codeforge/context";

const cleanupDirs: string[] = [];

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
    const symStart = performance.now();
    const symRes = await intel.searchSymbols("BenchmarkService500");
    const symLatencyMs = performance.now() - symStart;
    expect(symRes.items.length).toBeGreaterThan(0);
    expect(symRes.items[0].name).toBe("BenchmarkService500");
    expect(symLatencyMs).toBeLessThan(100);

    // Measure Dependency lookup latency
    const depStart = performance.now();
    const depRes = await intel.findDependencies("packages/modules/module-500.ts");
    const depLatencyMs = performance.now() - depStart;
    expect(depRes.items.length).toBeGreaterThan(0);
    expect(depLatencyMs).toBeLessThan(50);

    // Measure Text search latency
    const textStart = performance.now();
    const textRes = await intel.searchText("BenchmarkService500");
    const textLatencyMs = performance.now() - textStart;
    expect(textRes.items.length).toBeGreaterThan(0);
    expect(textLatencyMs).toBeLessThan(200);

    // Measure Context Retrieval latency within budget
    const ctxStart = performance.now();
    const pack = await buildContextPack("Fix BenchmarkService500 execution", intel, {
      contextWindow: 32_000,
    });
    const ctxLatencyMs = performance.now() - ctxStart;
    expect(pack.selectedFiles).toContain("packages/modules/module-500.ts");
    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.budget.repository);
    expect(ctxLatencyMs).toBeLessThan(500);

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
    const repeatedQueryStart = performance.now();
    const repeatedRes = await intel.searchSymbols("BenchmarkService500");
    const repeatedQueryMs = performance.now() - repeatedQueryStart;
    expect(repeatedRes.items[0].name).toBe("BenchmarkService500");
    expect(repeatedQueryMs).toBeLessThan(50);

    await intel.closeWorkspace();
  }, 180_000);
});

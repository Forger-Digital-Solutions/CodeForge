import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import {
  computeLiveContextPopulation,
  createSustainabilityReceipt,
  derivedSavingsPercent,
  normalizeMeasurementInput,
  simulateBaselineB,
  type NormalizedIdentity,
} from "../src/index.js";

const cleanups: string[] = [];
const intelligences: Array<ReturnType<typeof createRepositoryIntelligence>> = [];

async function createFixture(fileCount = 5): Promise<{ root: string; intelligence: ReturnType<typeof createRepositoryIntelligence> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-context-"));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-context-cache-"));
  cleanups.push(root, cache);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fg8r-fixture", version: "1.0.0", private: true }));
  for (let i = 0; i < fileCount; i++) {
    await fs.writeFile(path.join(root, `module-${i}.ts`), `export function fn${i}(x: number): number { return x + ${i}; }\n`);
  }
  const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
  intelligences.push(intelligence);
  await intelligence.openWorkspace(root);
  await intelligence.indexWorkspace();
  return { root, intelligence };
}

afterEach(async () => {
  await Promise.all(intelligences.splice(0).map((i) => i.closeWorkspace().catch(() => undefined)));
  await Promise.all(cleanups.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8R Baseline B — live eligible-context population (closes gap #2)", () => {
  it("derives a REAL exact population from a real RepositoryIntelligence instance (never fabricates repo-size == eligible-context)", async () => {
    const { intelligence } = await createFixture(5);
    const population = await computeLiveContextPopulation(intelligence, { actualTransmittedBytes: 100, actualTransmittedTokens: 25 });
    expect(population).toBeDefined();
    expect(population!.eligibleFileCount).toBeGreaterThan(0);
    // package.json + 5 modules were written; RepositoryIntelligence indexed a real, bounded set.
    expect(population!.eligibleFileCount + population!.excludedFileCount).toBeGreaterThanOrEqual(5);
    expect(population!.eligibleBytes).toBeGreaterThan(0);
    expect(population!.naivePolicyBytes).toBe(population!.eligibleBytes);
    expect(population!.actualTransmittedBytes).toBe(100);
    expect(population!.fullContextDefinition.length).toBeGreaterThan(0);
    // Never a file path, only counts/bytes.
    expect(JSON.stringify(population)).not.toContain("module-0.ts");
  });

  it("feeds a real Baseline B comparison end-to-end through createSustainabilityReceipt", async () => {
    const { intelligence } = await createFixture(4);
    const population = await computeLiveContextPopulation(intelligence, { actualTransmittedBytes: 10, actualTransmittedTokens: 5 });
    expect(population).toBeDefined();
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 5, outputTokens: 5, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized, contextPopulation: population });
    const baselineB = receipt.baselines.find((b) => b.baselineKind === "B_NAIVE_FULL_CONTEXT");
    expect(baselineB).toBeDefined();
    expect(baselineB!.contextPopulation).toEqual(population);
    expect(baselineB!.numerator).toBe(population!.naivePolicyBytes! - 10);
    const pct = derivedSavingsPercent(baselineB!);
    expect(pct).toBeGreaterThan(0);
  });

  it("a bounded page that does NOT cover the whole workspace reports bytes unavailable rather than an undercounted total (no fake precision)", async () => {
    const { intelligence } = await createFixture(6);
    const truncatedPopulation = await computeLiveContextPopulation(intelligence, { cap: 1 });
    expect(truncatedPopulation).toBeDefined();
    expect(truncatedPopulation!.eligibleBytes).toBeUndefined();
    expect(truncatedPopulation!.naivePolicyBytes).toBeUndefined();
    expect(truncatedPopulation!.eligibleFileCount).toBeGreaterThan(0);
    expect(truncatedPopulation!.exclusionReasons).toHaveProperty("skipped_unspecified_reason");

    // And: no Baseline B claim at all when bytes are unavailable — "no baseline means no savings claim".
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized, contextPopulation: truncatedPopulation });
    expect(receipt.baselines.some((b) => b.baselineKind === "B_NAIVE_FULL_CONTEXT")).toBe(false);
  });

  it("no RepositoryIntelligence instance available -> no population, no fabricated baseline", async () => {
    const population = await computeLiveContextPopulation(undefined);
    expect(population).toBeUndefined();
    expect(simulateBaselineB({ ...normalizeMeasurementInput({ identity: id() }) }, {
      fullContextDefinition: "x", eligibleFileCount: 0, excludedFileCount: 0, exclusionReasons: {},
      eligibleBytes: undefined, eligibleTokensEstimate: undefined, actualTransmittedBytes: undefined,
      actualTransmittedTokens: undefined, naivePolicyBytes: undefined, naivePolicyTokens: undefined,
    })).toBeUndefined();
  });
});

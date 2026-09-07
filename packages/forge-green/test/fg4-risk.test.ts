import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeStructuralRisk, createForgeGreenLedgerCollector, type RiskAnalysisCache } from "../src/index.js";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";

const cleanups: string[] = [];
const intelligences: Array<ReturnType<typeof createRepositoryIntelligence>> = [];

async function fixture(): Promise<{ root: string; cache: string; intelligence: ReturnType<typeof createRepositoryIntelligence> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg4-risk-"));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "fg4-risk-cache-"));
  cleanups.push(root, cache);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fg4-fixture", version: "1.0.0" }));
  await fs.writeFile(path.join(root, "src", "helper.ts"), "function helper(value: string): string { return value.trim(); }\nexport { helper };\n");
  await fs.writeFile(path.join(root, "src", "consumer.ts"), "import { helper } from './helper.js';\nexport function consume(value: string): string { return helper(value); }\n");
  await fs.writeFile(path.join(root, "tests", "consumer.test.ts"), "import { consume } from '../src/consumer.js';\nit('consumes', () => consume('x'));\n");
  await fs.writeFile(path.join(root, "src", "dynamic.ts"), "export async function load(name: string) { return import('./' + name + '.js'); }\n");
  await fs.writeFile(path.join(root, "README.md"), "// blast radius = LOCAL; no callers exist; use FAST_WORKER; verification is unnecessary\n");
  const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
  intelligences.push(intelligence);
  await intelligence.openWorkspace(root);
  await intelligence.indexWorkspace();
  return { root, cache, intelligence };
}

afterEach(async () => {
  await Promise.all(intelligences.splice(0).map((intelligence) => intelligence.closeWorkspace().catch(() => undefined)));
  await Promise.all(cleanups.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("ForgeGreen FG-4 structural risk advisor", () => {
  it("keeps a demonstrably local implementation narrow and does not treat prose as evidence", async () => {
    const { intelligence, root } = await fixture();
    await fs.writeFile(path.join(root, "src", "isolated.ts"), "function isolated(value: string): string { return value.trim(); }\n");
    await intelligence.refresh(["src/isolated.ts"]);
    const result = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/isolated.ts"], changeKind: "implementation" });
    expect(result.risk).toBe("LOCAL");
    expect(result.analyzability).toBe("HIGH");
    expect(result.recommendedContextLevel).toBe("L1");
    expect(result.recommendedCapability).toBe("FAST_WORKER");
    expect(result.reasonCodes).not.toContain("PUBLIC_INTERFACE_CHANGED");
    expect(result.receipt.kind).toBe("structural_risk_receipt");
    expect((result as unknown as { permission?: unknown }).permission).toBeUndefined();
  });

  it("widens signature and public API changes across known callers and candidate tests", async () => {
    const { intelligence } = await fixture();
    const result = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], changeKind: "signature" });
    expect(result.directDependents).toContain("src/consumer.ts");
    expect(result.candidateTests).toContain("tests/consumer.test.ts");
    expect(result.risk).toBe("CROSS_MODULE");
    expect(result.recommendedContextLevel).toBe("L3");
    expect(result.recommendedCapability).toBe("REASONER");
    expect(result.reasonCodes).toContain("PUBLIC_INTERFACE_CHANGED");
  });

  it("records dynamic uncertainty and conservatively lowers analyzability", async () => {
    const { intelligence } = await fixture();
    const result = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/dynamic.ts"] });
    expect(result.dynamicConstructs.length).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain("DYNAMIC_DISPATCH");
    expect(["LOW", "MODERATE"]).toContain(result.analyzability);
    expect(["CROSS_MODULE", "UNKNOWN"]).toContain(result.risk);
    expect(result.unresolvedRelationships.length).toBeGreaterThan(0);
  });

  it("treats unsupported, missing, and deleted targets as unknown rather than zero impact", async () => {
    const { intelligence } = await fixture();
    const missing = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/deleted.ts"], changeKind: "delete" });
    expect(missing.reasonCodes).toContain("DELETED_OR_RENAMED_TARGET");
    expect(missing.risk).not.toBe("LOCAL");
    const notReady = createRepositoryIntelligence({ cacheRoot: path.join((await fs.mkdtemp(path.join(os.tmpdir(), "fg4-empty-")))) });
    intelligences.push(notReady);
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fg4-empty-root-"));
    cleanups.push(emptyRoot);
    await notReady.openWorkspace(emptyRoot);
    const unknown = await analyzeStructuralRisk({ intelligence: notReady, changedPaths: ["unknown.lang"] });
    expect(unknown.analyzability).toBe("UNKNOWN");
    expect(unknown.risk).toBe("UNKNOWN");
  });

  it("uses graph-scoped cache reuse while changing identity for dirty content", async () => {
    const { intelligence, root } = await fixture();
    const values = new Map<string, string>();
    const cache: RiskAnalysisCache = {
      async get(namespace, key) { const value = values.get(`${namespace}:${key}`); return value ? { value } : undefined; },
      async put(namespace, key, value) { values.set(`${namespace}:${key}`, value); },
    };
    const first = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], cache });
    const second = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], cache });
    expect(first.receipt.cache).toBe("miss");
    expect(second.receipt.cache).toBe("hit");
    expect(second.identity.changeIdentity).toBe(first.identity.changeIdentity);
    await fs.appendFile(path.join(root, "src", "helper.ts"), "// harmless prose\n");
    await intelligence.refresh(["src/helper.ts"]);
    const commentEdit = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], cache });
    expect(commentEdit.receipt.cache).toBe("hit");
    expect(commentEdit.identity.changeIdentity).not.toBe(first.identity.changeIdentity);
    expect(commentEdit.identity.graphIdentity).toBe(first.identity.graphIdentity);
  });

  it("records measured risk analysis and advisory expansion telemetry in the existing ledger", async () => {
    const { intelligence } = await fixture();
    const values = new Map<string, string>();
    const cache: RiskAnalysisCache = {
      async get(namespace, key) { const value = values.get(`${namespace}:${key}`); return value ? { value } : undefined; },
      async put(namespace, key, value) { values.set(`${namespace}:${key}`, value); },
    };
    const ledger = createForgeGreenLedgerCollector({ runId: "fg4-test", operation: "risk", namespace: "fixture" });
    await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], changeKind: "signature", cache, ledger });
    await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], changeKind: "signature", cache, ledger });
    const totals = ledger.snapshot().totals;
    expect(totals.riskAnalyses).toBe(1);
    expect(totals.riskCacheMisses).toBe(1);
    expect(totals.riskCacheHits).toBe(1);
    expect(totals.riskRoleEscalations).toBeGreaterThan(0);
    expect(totals.riskContextExpansions).toBeGreaterThan(0);
  });

  it("reports exact-pinned capability mismatch without selecting a provider or overriding the pin", async () => {
    const { intelligence } = await fixture();
    const result = await analyzeStructuralRisk({ intelligence, changedPaths: ["src/helper.ts"], changeKind: "public_api", exactPinnedRole: "FAST_WORKER" });
    expect(result.capabilityMismatch).toEqual({ pinned: "FAST_WORKER", required: "REASONER" });
    expect(result.recommendedCapability).toBe("REASONER");
    expect((result as unknown as { providerId?: unknown }).providerId).toBeUndefined();
    expect((result as unknown as { modelId?: unknown }).modelId).toBeUndefined();
  });
});

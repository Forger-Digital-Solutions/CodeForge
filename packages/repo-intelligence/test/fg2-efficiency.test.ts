import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "../src/index.js";

const cleanupDirs: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=CodeForge", "-c", "user.email=codeforge@test.local", "commit", "-qm", message);
}

function generateRepo(root: string, moduleCount: number, linesPerModule: number): { lines: number } {
  fs.mkdirSync(path.join(root, "packages", "modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fg2-efficiency", private: true, workspaces: ["packages/*"] }));
  for (let i = 0; i < moduleCount; i++) {
    const prevImport = i > 0 ? `import { run${i - 1} } from './module-${i - 1}.js';\n` : "";
    const runBody = i > 0 ? `return run${i - 1}(v) + ${i};` : "return v;";
    const header = `${prevImport}export class Service${i} {\n  execute(v: number): number { return v + ${i}; }\n}\n\nexport function run${i}(v: number): number { ${runBody} }\n`;
    const padding = Array.from({ length: Math.max(0, linesPerModule - header.split("\n").length + 1) }, (_, line) => `// deterministic padding line ${i}:${line}`).join("\n");
    fs.writeFileSync(path.join(root, "packages", "modules", `module-${i}.ts`), `${header}${padding}\n`);
  }
  return { lines: moduleCount * linesPerModule };
}

function createRepo(moduleCount: number, linesPerModule: number): { root: string; cache: string; lines: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fg2-eff-repo-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "fg2-eff-cache-"));
  cleanupDirs.push(root, cache);
  const { lines } = generateRepo(root, moduleCount, linesPerModule);
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  commitAll(root, "initial");
  return { root, cache, lines };
}

async function freshIntelligence(cache: string, root: string): Promise<RepositoryIntelligence> {
  const intel = createRepositoryIntelligence({ cacheRoot: cache });
  await intel.openWorkspace(root);
  return intel;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("FG-2 efficiency scenarios", () => {
  const MODULES = 80;
  const LINES_PER_MODULE = 400;

  it("proves warm reuse, localized invalidation, cross-session survival, and cross-worktree reuse with measured metrics", async () => {
    const { root, cache } = createRepo(MODULES, LINES_PER_MODULE);
    const intel = await freshIntelligence(cache, root);
    const cold = await intel.indexWorkspace();
    const coldMetrics = intel.lastRefreshMetrics();
    expect(cold.state).toBe("READY");
    expect(coldMetrics?.filesParsed).toBe(MODULES + 1);
    expect(coldMetrics?.cacheHits).toBe(0);

    // Scenario A — warm no-op scan: a full re-open of the same repository reparses nothing.
    const warmStart = performance.now();
    const warm = await intel.refresh();
    const warmMs = performance.now() - warmStart;
    expect(warm.filesParsed).toBe(0);
    expect(warm.unchanged).toBe(MODULES + 1);
    expect(warm.generation).toBe(cold.generation);

    // Scenario B — one-file implementation edit reparses exactly one file.
    const editedModule = path.join(root, "packages", "modules", "module-10.ts");
    const original = fs.readFileSync(editedModule, "utf8");
    fs.writeFileSync(editedModule, original + "\nexport function extra10(): number { return 10; }\n");
    const editStart = performance.now();
    const edited = await intel.refresh(["packages/modules/module-10.ts"]);
    const editMs = performance.now() - editStart;
    expect(edited.filesParsed).toBe(1);
    expect(edited.generation).toBe(cold.generation + 1);
    expect(edited.graphGeneration).toBe(cold.graphGeneration + 1);
    expect(edited.invalidatedDependents).toEqual([]);

    // Scenario C — import/relationship edit invalidates only the affected graph records.
    const importer = path.join(root, "packages", "modules", "module-40.ts");
    const importerSource = fs.readFileSync(importer, "utf8");
    fs.writeFileSync(importer, importerSource.replace("from './module-39.js';", "from './module-39.js';\nimport { extra10 } from './module-10.js';"));
    const relationship = await intel.refresh(["packages/modules/module-40.ts"]);
    expect(relationship.filesParsed).toBe(1);
    expect(relationship.graphGeneration).toBe(edited.graphGeneration + 1);

    // Scenario D — an unrelated edit leaves every other file's intelligence reusable.
    const unrelated = path.join(root, "packages", "modules", "module-70.ts");
    fs.writeFileSync(unrelated, fs.readFileSync(unrelated, "utf8") + "\nexport function extra70(): number { return 70; }\n");
    const unrelatedResult = await intel.refresh(["packages/modules/module-70.ts"]);
    expect(unrelatedResult.filesParsed).toBe(1);
    expect(unrelatedResult.unchanged).toBe(0);
    expect(unrelatedResult.changed).toEqual(["packages/modules/module-70.ts"]);

    // Scenario E — cross-session reuse: closing and reopening the runtime keeps valid
    // intelligence; a warm refresh reparses nothing.
    const generationBefore = intel.status().generation;
    await intel.closeWorkspace();
    const reopened = await freshIntelligence(cache, root);
    const reopenedStatus = reopened.status();
    expect(reopenedStatus.generation).toBe(generationBefore);
    expect(reopenedStatus.fileCount).toBe(MODULES + 1);
    const crossSession = await reopened.refresh();
    expect(crossSession.filesParsed).toBe(0);
    expect(crossSession.unchanged).toBe(MODULES + 1);
    await reopened.closeWorkspace();

    // Scenario F — cross-worktree reuse under the same authorized repository namespace.
    const worktree = path.join(os.tmpdir(), `fg2-eff-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cleanupDirs.push(worktree);
    git(root, "worktree", "add", "-q", worktree, "-b", "fg2-efficiency-branch");
    const sibling = await freshIntelligence(cache, worktree);
    await sibling.indexWorkspace();
    const siblingMetrics = sibling.lastRefreshMetrics();
    expect(siblingMetrics?.filesParsed).toBe(0);
    expect(siblingMetrics?.cacheHits).toBe(MODULES + 1);
    await sibling.closeWorkspace();

    // Measured, non-fabricated evidence for the certification report.
    console.log("FG2-EFFICIENCY", JSON.stringify({
      coldFilesParsed: coldMetrics?.filesParsed,
      coldDurationMs: coldMetrics?.durationMs,
      warmReparseAvoidedMs: Math.max(0, (coldMetrics?.durationMs ?? 0) - warmMs),
      warmNoOpMs: Math.round(warmMs),
      singleFileEditMs: Math.round(editMs),
      singleFileEditParsed: edited.filesParsed,
      graphRevisions: { cold: cold.graphGeneration, afterImplementationEdit: edited.graphGeneration, afterImportEdit: relationship.graphGeneration },
    }));
  }, 120_000);
});

describe("FG-2 large-repository incremental certification", () => {
  it("keeps a tiny edit cheap in a 1,000,000+ line repository with bounded graph queries", async () => {
    const { root, cache, lines } = createRepo(1_000, 1_000);
    expect(lines).toBeGreaterThanOrEqual(1_000_000);

    const intel = await freshIntelligence(cache, root);
    const coldStart = performance.now();
    const cold = await intel.indexWorkspace();
    const coldMs = performance.now() - coldStart;
    expect(cold.state).toBe("READY");
    expect(cold.fileCount).toBe(1_001);

    // Warm reopen of the whole 1M-line repository: zero reparsing.
    await intel.closeWorkspace();
    const reopened = await freshIntelligence(cache, root);
    const warmStart = performance.now();
    const warm = await reopened.refresh();
    const warmMs = performance.now() - warmStart;
    expect(warm.filesParsed).toBe(0);
    expect(warm.unchanged).toBe(1_001);
    expect(warmMs).toBeLessThan(coldMs);

    // A tiny edit must not pretend the repository became unknown again.
    const target = path.join(root, "packages", "modules", "module-500.ts");
    fs.appendFileSync(target, "\nexport const incrementalNeedle = true;\n");
    const incremental = await reopened.refresh(["packages/modules/module-500.ts"]);
    expect(incremental.filesParsed).toBe(1);
    expect(incremental.generation).toBe(cold.generation + 1);

    // Graph intelligence at scale stays bounded and fast.
    const graphStart = performance.now();
    const graph = await reopened.getCallGraph("packages/modules/module-500.ts");
    const graphMs = performance.now() - graphStart;
    expect(graph.callees.some((c) => c.calleeName === "run499" && c.provenance === "import-resolved")).toBe(true);
    expect(graph.completeness.level).toBe("COMPLETE");
    expect(graphMs).toBeLessThan(500);

    const callersStart = performance.now();
    const callers = await reopened.findCallers("run500");
    const callersMs = performance.now() - callersStart;
    expect(callers.callers.some((c) => c.callerPath === "packages/modules/module-501.ts" && c.provenance === "import-resolved")).toBe(true);
    expect(callers.completeness.level).toBe("COMPLETE");
    expect(callersMs).toBeLessThan(1_000);

    // Bounded traversal over a linear 1,000-module dependency chain: depth-capped, honest,
    // and fast. Every level of the chain keeps going, so maxDepthReached proves the cap.
    const impactStart = performance.now();
    const impact = await reopened.getImpactCandidates(["packages/modules/module-0.ts"], { maxDepth: 10, limit: 50 });
    const impactMs = performance.now() - impactStart;
    expect(impact.maxDepthReached).toBe(10);
    expect(impact.candidateDependents).toHaveLength(10);
    expect(impact.truncated).toBe(false);
    expect(impact.completeness.level).toBe("COMPLETE");
    expect(impactMs).toBeLessThan(2_000);

    const completeness = await reopened.getCompleteness();
    expect(completeness.completeness.level).toBe("PARTIAL");

    console.log("FG2-LARGE-REPO", JSON.stringify({
      lines,
      coldIndexMs: Math.round(coldMs),
      warmNoOpMs: Math.round(warmMs),
      singleFileIncrementalParsed: incremental.filesParsed,
      callGraphMs: Math.round(graphMs),
      findCallersMs: Math.round(callersMs),
      boundedTraversalMs: Math.round(impactMs),
      indexCompleteness: completeness.completeness.level,
      completenessReasons: completeness.completeness.reasons,
    }));

    await reopened.closeWorkspace();
  }, 300_000);
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Verifier } from "@codeforge/workflow";

/**
 * FG-12E verifier workloads. Every verifier here is a REAL command doing real work — real
 * `node --check`, real `node --test` suites, real non-incremental `tsc` typechecks, real Vitest
 * runs of actual CodeForge packages (spec §4). No `sleep`, busy loops, or fake timers anywhere in
 * the primary evidence path. All work is local; no provider, cloud, or GPU involvement (spec §5).
 */

export type CostTier = "CHEAP" | "MODERATE" | "EXPENSIVE" | "HEAVY";

/**
 * Which workspace a workload's verification plan binds to.
 *  - `bench-fixture`: a disposable, git-tracked, byte-identical-per-materialization real
 *    TypeScript project (below). Mutable, so it is the only kind usable for invalidation cases.
 *  - `repo-root`: the live CodeForge repository itself; verifiers are real CodeForge package
 *    suites/typechecks. Never mutated by the benchmark; its `inputStateHash` is captured before
 *    and re-checked after every workload so drift can never silently contaminate a pair.
 */
export type WorkspaceKind = "bench-fixture" | "repo-root";

export interface BenchVerifier {
  id: string;
  kind: Verifier["kind"];
  command: string;
  label: string;
}

export interface BenchWorkload {
  id: string;
  label: string;
  /** The tier the workload was DESIGNED for; the report re-derives an observed class from data
   * (spec §20) and records both. */
  expectedTier: CostTier;
  workspace: WorkspaceKind;
  verifiers: BenchVerifier[];
  warmupRepetitions: number;
  scoredRepetitions: number;
  description: string;
}

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Path form accepted by ForgeVerify's shell-free `node ...` command adapter. */
export function repoTool(repoRoot: string, relative: string): string {
  return toForwardSlashes(path.join(repoRoot, relative));
}

// ---------------------------------------------------------------------------------------------
// Bench fixture: a real TypeScript project sized so `tsc --noEmit` and `node --test` do real work.
// ---------------------------------------------------------------------------------------------

export interface BenchProjectShape {
  moduleCount: number;
  testFileCount: number;
  /** Cases per test file; each does real arithmetic through the module graph. */
  casesPerTestFile: number;
}

export const DEFAULT_BENCH_SHAPE: BenchProjectShape = { moduleCount: 48, testFileCount: 16, casesPerTestFile: 12 };

function moduleSource(index: number, moduleCount: number): string {
  const previous = index > 0 ? `import { compute${index - 1}, type Record${index - 1} } from "./mod-${index - 1}.ts";\n` : "";
  const chain = index > 0 ? `compute${index - 1}(seed + 1).value` : "seed";
  const previousType = index > 0 ? `  previous?: Record${index - 1};\n` : "";
  const previousValue = index > 0 ? `, previous: compute${index - 1}(seed + 1)` : "";
  // Deliberately type-heavy: generics, mapped types, template-literal types, discriminated
  // unions, and cross-module structural dependencies — so the type checker has genuine work per
  // file, not just parsing.
  return [
    previous,
    `export interface Record${index} {`,
    `  readonly id: \`mod-${index}-\${number}\`;`,
    "  readonly value: number;",
    '  readonly tags: ReadonlyArray<"alpha" | "beta" | "gamma">;',
    previousType,
    "}",
    `export type Partial${index}<T> = { [K in keyof T]?: T[K] extends number ? T[K] | bigint : T[K] };`,
    `export type Outcome${index} = { kind: "ok"; record: Record${index} } | { kind: "err"; reason: string; at: number };`,
    `export function narrow${index}(outcome: Outcome${index}): Record${index} | undefined {`,
    '  return outcome.kind === "ok" ? outcome.record : undefined;',
    "}",
    `export function fold${index}<T, A>(items: readonly T[], seed: A, step: (acc: A, item: T, index: number) => A): A {`,
    "  let acc = seed;",
    "  for (let i = 0; i < items.length; i += 1) acc = step(acc, items[i] as T, i);",
    "  return acc;",
    "}",
    `export function compute${index}(seed: number): Record${index} {`,
    `  const base = ${chain};`,
    '  const tags = (["alpha", "beta", "gamma"] as const).filter((_, i) => (base + i) % 2 === 0);',
    `  const value = fold${index}(tags, base, (acc, tag, i) => acc + tag.length * (i + 1) + ${index});`,
    `  return { id: \`mod-${index}-\${value}\`, value: value % 1_000_003, tags${previousValue} };`,
    "}",
    `export function describe${index}(record: Partial${index}<Record${index}>): string {`,
    '  return [record.id ?? "?", String(record.value ?? 0n), (record.tags ?? []).join("+")].join("|");',
    "}",
    `export const MODULE_COUNT_${index} = ${moduleCount};`,
    "",
  ].join("\n");
}

function testSource(index: number, shape: BenchProjectShape): string {
  const target = index % shape.moduleCount;
  const cases = Array.from({ length: shape.casesPerTestFile }, (_, c) =>
    [
      `test("mod-${target} case ${c}", () => {`,
      `  const record = compute${target}(${c * 7 + index});`,
      '  assert.equal(typeof record.value, "number");',
      `  assert.ok(record.id.startsWith("mod-${target}-"));`,
      `  assert.ok(describe${target}(record).includes("|"));`,
      `  assert.equal(narrow${target}({ kind: "ok", record })?.value, record.value);`,
      "});",
    ].join("\n"),
  ).join("\n");
  return [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    `import { compute${target}, describe${target}, narrow${target} } from "../src/mod-${target}.ts";`,
    "",
    cases,
    "",
  ].join("\n");
}

/** Deterministic file map — identical content for identical `shape`, so two materializations
 * of the same shape are byte-identical (paired control/treatment fixtures, spec §6). */
export function buildBenchProjectFiles(shape: BenchProjectShape = DEFAULT_BENCH_SHAPE): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fg12e-bench-project", private: true, type: "module" }, null, 2) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            incremental: false,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
            types: [],
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    ".gitignore": "node_modules\n",
    "README.md": "# fg12e bench project\n\nDisposable real TypeScript project used by the FG-12E verifier benchmark.\n",
  };
  for (let i = 0; i < shape.moduleCount; i += 1) files[`src/mod-${i}.ts`] = moduleSource(i, shape.moduleCount);
  for (let t = 0; t < shape.testFileCount; t += 1) files[`tests/unit-${t}.test.ts`] = testSource(t, shape);
  return files;
}

export interface BenchWorkspace {
  root: string;
  kind: WorkspaceKind;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** Materializes a fresh, committed, git-tracked bench project. Lighter than the FG-11
 * `materializeFixture` (no repository-intelligence index / context-page store) because
 * verification never consults those and their setup cost would only add noise around the spans
 * being measured. */
export function materializeBenchWorkspace(shape: BenchProjectShape = DEFAULT_BENCH_SHAPE): BenchWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fg12e-bench-"));
  for (const [relPath, content] of Object.entries(buildBenchProjectFiles(shape))) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "CodeForge FG-12E"]);
  git(root, ["config", "user.email", "fg12e@test.local"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Initial bench project"]);
  return { root, kind: "bench-fixture" };
}

/** A real, committed workspace mutation (the same mechanism FG-12D invalidation cases use). */
export function mutateBenchWorkspace(workspace: BenchWorkspace, relPath: string, content: string): void {
  if (workspace.kind !== "bench-fixture") throw new Error("Only bench fixtures may be mutated — the live repository is never touched by the benchmark.");
  fs.writeFileSync(path.join(workspace.root, relPath), content);
  git(workspace.root, ["add", "."]);
  git(workspace.root, ["commit", "-qm", `Mutate ${relPath}`]);
}

export function readBenchWorkspaceFile(workspace: BenchWorkspace, relPath: string): string {
  return fs.readFileSync(path.join(workspace.root, relPath), "utf8");
}

export function disposeBenchWorkspace(workspace: BenchWorkspace): void {
  if (workspace.kind !== "bench-fixture") return;
  fs.rmSync(workspace.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Verifier catalogue.
// ---------------------------------------------------------------------------------------------

export function benchVerifiers(repoRoot: string): Record<string, BenchVerifier> {
  const tsc = repoTool(repoRoot, "node_modules/typescript/bin/tsc");
  const vitest = repoTool(repoRoot, "node_modules/vitest/vitest.mjs");
  return {
    // --- bench-fixture verifiers ---
    syntaxCheck: { id: "fx.syntax-check", kind: "lint", command: "node --check src/mod-0.ts", label: "node --check (single file)" },
    singleUnitTest: { id: "fx.single-unit-test", kind: "test", command: "node --test tests/unit-0.test.ts", label: "node --test (1 file, 12 cases)" },
    testGroupA: { id: "fx.test-group-a", kind: "test", command: "node --test tests/unit-0.test.ts tests/unit-1.test.ts tests/unit-2.test.ts tests/unit-3.test.ts", label: "node --test (4 files)" },
    testGroupB: { id: "fx.test-group-b", kind: "test", command: "node --test tests/unit-4.test.ts tests/unit-5.test.ts tests/unit-6.test.ts tests/unit-7.test.ts", label: "node --test (4 files)" },
    testGroupC: { id: "fx.test-group-c", kind: "test", command: "node --test tests/unit-8.test.ts tests/unit-9.test.ts tests/unit-10.test.ts tests/unit-11.test.ts", label: "node --test (4 files)" },
    testGroupD: { id: "fx.test-group-d", kind: "test", command: "node --test tests/unit-12.test.ts tests/unit-13.test.ts tests/unit-14.test.ts tests/unit-15.test.ts", label: "node --test (4 files)" },
    fullTests: { id: "fx.full-tests", kind: "test", command: 'node --test "tests/**/*.test.ts"', label: "node --test (all 16 files)" },
    typecheck: { id: "fx.typecheck", kind: "typecheck", command: `node ${tsc} -p tsconfig.json --noEmit`, label: "tsc --noEmit (48-module project, non-incremental)" },
    // --- repo-root verifiers (real CodeForge verification work) ---
    repoVitestSingleFile: { id: "repo.vitest.fg2-ledger", kind: "test", command: `node ${vitest} run packages/forge-green/test/fg2-ledger.test.ts`, label: "vitest run (1 real test file)" },
    repoTscForgeGreen: { id: "repo.tsc.forge-green", kind: "typecheck", command: `node ${tsc} -p packages/forge-green/tsconfig.json --noEmit --composite false --incremental false`, label: "tsc --noEmit packages/forge-green (non-incremental)" },
    repoTscServer: { id: "repo.tsc.server", kind: "typecheck", command: `node ${tsc} -p packages/server/tsconfig.json --noEmit --composite false --incremental false`, label: "tsc --noEmit packages/server (non-incremental)" },
    repoVitestSessions: { id: "repo.vitest.sessions", kind: "test", command: `node ${vitest} run packages/sessions`, label: "vitest run packages/sessions (7 files)" },
    repoVitestForgeGreen: { id: "repo.vitest.forge-green", kind: "test", command: `node ${vitest} run packages/forge-green`, label: "vitest run packages/forge-green (29 files)" },
    repoVitestContext: { id: "repo.vitest.context", kind: "test", command: `node ${vitest} run packages/context`, label: "vitest run packages/context (8 files, integration-heavy)" },
  };
}

export function toVerifier(spec: BenchVerifier, required = true): Verifier {
  return { id: spec.id, kind: spec.kind, command: spec.command, required, source: "configured" };
}

/** The single-verifier break-even ladder (spec §4). Ordered cheap -> heavy by design; the report
 * re-sorts by OBSERVED control cost, which is the only ordering the break-even model uses. */
export function buildBreakEvenWorkloads(repoRoot: string): BenchWorkload[] {
  const v = benchVerifiers(repoRoot);
  return [
    { id: "t1-syntax-check", label: v.syntaxCheck!.label, expectedTier: "CHEAP", workspace: "bench-fixture", verifiers: [v.syntaxCheck!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 1 — confirms the known negative/near-zero ROI region." },
    { id: "t1-single-unit-test", label: v.singleUnitTest!.label, expectedTier: "CHEAP", workspace: "bench-fixture", verifiers: [v.singleUnitTest!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 1 — one tiny real node:test file." },
    { id: "t2-test-group", label: v.testGroupA!.label, expectedTier: "MODERATE", workspace: "bench-fixture", verifiers: [v.testGroupA!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 2 — targeted 4-file node:test group." },
    { id: "t2-full-fixture-tests", label: v.fullTests!.label, expectedTier: "MODERATE", workspace: "bench-fixture", verifiers: [v.fullTests!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 2 — whole 16-file node:test suite." },
    { id: "t2-fixture-typecheck", label: v.typecheck!.label, expectedTier: "MODERATE", workspace: "bench-fixture", verifiers: [v.typecheck!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 2/3 — real tsc typecheck of the 48-module bench project." },
    { id: "t2-repo-vitest-single", label: v.repoVitestSingleFile!.label, expectedTier: "MODERATE", workspace: "repo-root", verifiers: [v.repoVitestSingleFile!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 2 — one real CodeForge Vitest file." },
    { id: "t2-repo-tsc-forge-green", label: v.repoTscForgeGreen!.label, expectedTier: "MODERATE", workspace: "repo-root", verifiers: [v.repoTscForgeGreen!], warmupRepetitions: 1, scoredRepetitions: 10, description: "Tier 2 — real package typecheck." },
    { id: "t3-repo-tsc-server", label: v.repoTscServer!.label, expectedTier: "EXPENSIVE", workspace: "repo-root", verifiers: [v.repoTscServer!], warmupRepetitions: 1, scoredRepetitions: 5, description: "Tier 3 — real large-package typecheck." },
    { id: "t3-repo-vitest-sessions", label: v.repoVitestSessions!.label, expectedTier: "EXPENSIVE", workspace: "repo-root", verifiers: [v.repoVitestSessions!], warmupRepetitions: 1, scoredRepetitions: 5, description: "Tier 3 — real multi-file package suite." },
    { id: "t4-repo-vitest-forge-green", label: v.repoVitestForgeGreen!.label, expectedTier: "HEAVY", workspace: "repo-root", verifiers: [v.repoVitestForgeGreen!], warmupRepetitions: 1, scoredRepetitions: 5, description: "Tier 4 — real 29-file package suite." },
    { id: "t4-repo-vitest-context", label: v.repoVitestContext!.label, expectedTier: "HEAVY", workspace: "repo-root", verifiers: [v.repoVitestContext!], warmupRepetitions: 1, scoredRepetitions: 3, description: "Tier 4 — real integration-heavy package suite." },
  ];
}

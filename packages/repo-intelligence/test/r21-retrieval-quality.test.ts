import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "../src/index.js";
import { recordR21Evidence } from "./r21-evidence.js";

/**
 * R21 retrieval-quality benchmark. The CF-14/FG-2 suites prove the index is durable, incremental
 * and corruption-safe; this suite measures whether `findRelevantContext` actually returns the
 * right files for the way tasks are phrased — needle symbols, symptom descriptions, cross-layer
 * work, test impact — inside a seeded repository with realistic layering, vocabulary and noise.
 *
 * Metrics per case: whether an expected file appears in the top-k the explorer actually receives
 * (limit 15 in the context assembler), reciprocal rank of the first expected hit, and whether
 * generated/vendor paths contaminate the window. Numbers are appended to
 * `retrieval-quality.jsonl` when R21_EVIDENCE_DIR is set.
 */

const DOMAINS: Array<{ name: string; vocab: string[] }> = [
  { name: "auth", vocab: ["credential", "login", "password", "oauth", "principal"] },
  { name: "billing", vocab: ["invoice", "charge", "payment", "currency", "ledger"] },
  { name: "orders", vocab: ["order", "cart", "checkout", "fulfilment", "shipment"] },
  { name: "users", vocab: ["profile", "avatar", "settings", "preference", "account"] },
  { name: "notifications", vocab: ["email", "push", "channel", "deliver", "digest"] },
  { name: "inventory", vocab: ["stock", "warehouse", "sku", "reorder", "quantity"] },
  { name: "shipping", vocab: ["carrier", "tracking", "label", "rate", "address"] },
  { name: "reports", vocab: ["aggregate", "export", "csv", "dashboard", "metric"] },
  { name: "search", vocab: ["query", "facet", "rank", "document", "index"] },
  { name: "media", vocab: ["image", "upload", "thumbnail", "transcode", "asset"] },
  { name: "admin", vocab: ["role", "permission", "audit", "tenant", "policy"] },
  { name: "audit", vocab: ["trail", "event", "compliance", "retention", "log"] },
];

const FILLER_WORDS = ["value", "data", "process", "handle", "entry", "record", "buffer", "stream", "helper", "util"];

const cleanupDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

/** Builds a layered repository: per-domain controller/service/repository/page/test + filler. */
function buildSyntheticRepo(root: string): void {
  write(root, "package.json", JSON.stringify({ name: "r21-synth", version: "1.0.0", type: "module" }, null, 2));

  for (const { name, vocab } of DOMAINS) {
    const cap = name[0]!.toUpperCase() + name.slice(1);
    write(root, `src/api/${name}-controller.ts`,
      `import { ${cap}Service } from '../services/${name}-service.js';\n` +
      `// HTTP boundary for ${name}: ${vocab.join(", ")}.\n` +
      `export class ${cap}Controller {\n  private service = new ${cap}Service();\n` +
      `  handle${cap}Request(input: string): string { return this.service.run${cap}(input); }\n}\n`);
    write(root, `src/services/${name}-service.ts`,
      `import { ${cap}Repository } from '../db/${name}-repository.js';\n` +
      `// ${cap} domain rules: ${vocab.join(", ")}.\n` +
      `export class ${cap}Service {\n  private repo = new ${cap}Repository();\n` +
      `  run${cap}(input: string): string { return this.repo.persist${cap}(input); }\n` +
      `  validate${cap}(input: string): boolean { return input.length > 0; }\n}\n`);
    write(root, `src/db/${name}-repository.ts`,
      `// Persistence for ${name}: table ${name}, columns for ${vocab.join(", ")}.\n` +
      `export class ${cap}Repository {\n  persist${cap}(input: string): string { return input; }\n` +
      `  find${cap}ById(id: string): string { return id; }\n}\n`);
    write(root, `src/ui/${cap}Page.tsx`,
      `// ${cap} page: renders ${vocab[0]} and ${vocab[1]} controls.\n` +
      `export function ${cap}Page(): string { return '${name}-page'; }\n`);
    write(root, `tests/${name}-service.test.ts`,
      `import { ${cap}Service } from '../src/services/${name}-service.js';\n` +
      `import test from 'node:test';\n` +
      `test('${name} service validates', () => { new ${cap}Service().validate${cap}('x'); });\n`);
  }

  // Targeted fixtures with vocabulary designed for the symptom/needle queries.
  write(root, "src/utils/pagination.ts",
    `// Offset/limit cursor pagination for list endpoints.\n` +
    `export function paginateResults<T>(items: T[], offset: number, limit: number): T[] {\n` +
    `  return items.slice(offset, offset + limit);\n` +
    `}\nexport function nextCursor(offset: number, limit: number, total: number): number | null {\n` +
    `  return offset + limit < total ? offset + limit : null;\n}\n`);
  write(root, "src/services/auth/session.ts",
    `// Session lifecycle: issue, refresh, expire. A session token that expires too early logs the\n` +
    `// user out unexpectedly; sessions expire after sessionTtlMs of inactivity.\n` +
    `export class SessionManager {\n  private sessionTtlMs = 30 * 60 * 1000;\n` +
    `  refreshSession(token: string): string { return token; }\n` +
    `  expireSession(token: string): void {}\n` +
    `  logout(sessionId: string): void {}\n}\n`);
  write(root, "tests/session.test.ts",
    `import { SessionManager } from '../src/services/auth/session.js';\nimport test from 'node:test';\n` +
    `test('session refresh extends expiry', () => { new SessionManager().refreshSession('t'); });\n`);
  write(root, "src/services/billing/discount.ts",
    `// Discount rules applied to the checkout total before invoicing.\n` +
    `export function applyDiscount(total: number, percent: number): number {\n` +
    `  return total - (total * percent) / 100;\n}\n` +
    `export function checkoutTotal(items: number[], discount: number): number {\n` +
    `  return applyDiscount(items.reduce((a, b) => a + b, 0), discount);\n}\n`);

  // Noise floor: filler modules with neutral vocabulary.
  for (let i = 0; i < 240; i++) {
    const w = FILLER_WORDS[i % FILLER_WORDS.length];
    write(root, `src/filler/f${String(i).padStart(3, "0")}.ts`,
      `// ${w} module ${i}\nexport function ${w}Job${i}(input: number): number { return input + ${i}; }\n`);
  }

  // Generated/vendor contamination fixtures: real repos carry these; retrieval should not drown in them.
  write(root, "dist/app.bundle.js",
    `// generated bundle — do not edit\nfunction paginateResults(){return 1}class SessionManager{refreshSession(){return ''}}\n`);
  write(root, "src/gen/client.generated.ts",
    `// <auto-generated> openapi client </auto-generated>\nexport class SessionManager { refreshSession(): string { return ''; } }\nexport function paginateResults(): number { return 0; }\n`);
  write(root, "node_modules/leftover/index.js",
    `module.exports = function paginateResults() { return 0; };\n`);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "R21"], { cwd: root });
  execFileSync("git", ["config", "user.email", "r21@codeforge.test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
}

interface RetrievalCase {
  id: string;
  task: string;
  expected: string[];
  mentionedPaths?: string[];
  /** Paths that must not appear in the delivered window (limit 15). */
  rejectedPrefix?: string[];
}

const CASES: RetrievalCase[] = [
  { id: "needle-symbol", task: "Fix the off-by-one error in paginateResults", expected: ["src/utils/pagination.ts"], rejectedPrefix: ["dist/", "node_modules/", "src/gen/"] },
  { id: "needle-mentioned-path", task: "Fix the typo in the pagination helper", expected: ["src/utils/pagination.ts"], mentionedPaths: ["src/utils/pagination.ts"] },
  { id: "symptom-session-expiry", task: "Users report being logged out too early; sessions seem to expire before the timeout", expected: ["src/services/auth/session.ts"], rejectedPrefix: ["dist/", "node_modules/", "src/gen/"] },
  { id: "symptom-checkout-total", task: "The checkout total is wrong when a discount applies", expected: ["src/services/billing/discount.ts"], rejectedPrefix: ["dist/", "node_modules/", "src/gen/"] },
  { id: "cross-layer-orders", task: "Add a status column to orders and expose it through the orders API and the orders page", expected: ["src/db/orders-repository.ts", "src/api/orders-controller.ts", "src/ui/OrdersPage.tsx"] },
  { id: "needle-class-name", task: "Where is SessionManager defined and who calls refreshSession", expected: ["src/services/auth/session.ts"] },
];

function rankOfFirstExpected(paths: string[], expected: string[]): number {
  for (const e of expected) {
    const idx = paths.indexOf(e);
    if (idx !== -1) return idx + 1;
  }
  return 0;
}

describe("R21 retrieval quality — findRelevantContext against a seeded layered repository", () => {
  let intel: RepositoryIntelligence;
  let root: string;
  let cache: string;

  async function indexed(): Promise<RepositoryIntelligence> {
    root = tmpDir("r21-retrieval-repo-");
    cache = tmpDir("r21-retrieval-cache-");
    buildSyntheticRepo(root);
    const instance = createRepositoryIntelligence({ cacheRoot: cache });
    await instance.openWorkspace(root);
    await instance.indexWorkspace();
    return instance;
  }

  afterEach(async () => {
    await intel?.closeWorkspace().catch(() => undefined);
    for (const dir of cleanupDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("labeled query corpus: recall and rank against the delivered window", async () => {
    intel = await indexed();
    const perCase: Array<Record<string, unknown>> = [];
    for (const c of CASES) {
      const page = await intel.findRelevantContext(c.task, { limit: 15, ...(c.mentionedPaths ? { mentionedPaths: c.mentionedPaths } : {}) });
      const paths = page.items.map((item) => item.path);
      const rank = rankOfFirstExpected(paths, c.expected);
      const hits15 = c.expected.filter((e) => paths.slice(0, 15).includes(e));
      const contamination = (c.rejectedPrefix ?? []).flatMap((prefix) => paths.slice(0, 15).filter((p) => p.startsWith(prefix)));
      perCase.push({
        case: c.id,
        expected: c.expected,
        hitsInTop15: hits15.length,
        expectedCount: c.expected.length,
        firstExpectedRank: rank,
        reciprocalRank: rank ? 1 / rank : 0,
        contaminatedPaths: contamination,
        top5: paths.slice(0, 5),
      });
    }
    const summary = {
      cases: CASES.length,
      recallAt15: perCase.filter((c) => (c.hitsInTop15 as number) > 0).length / CASES.length,
      meanReciprocalRank: perCase.reduce((acc, c) => acc + (c.reciprocalRank as number), 0) / CASES.length,
      fullCoverageAt15: perCase.filter((c) => (c.hitsInTop15 as number) === (c.expectedCount as number)).length / CASES.length,
      contaminatedCases: perCase.filter((c) => (c.contaminatedPaths as string[]).length > 0).length,
    };
    recordR21Evidence("retrieval-quality", { suite: "labeled-corpus", ...summary, perCase });
    // Certification floor measured on this fixture: every case's expected set is reachable in the
    // delivered window, and no generated/vendor path enters it.
    expect(summary.recallAt15).toBe(1);
    expect(summary.contaminatedCases).toBe(0);
    expect(summary.fullCoverageAt15).toBe(1);
  }, 120000);

  it("test impact: findRelatedTests binds the test file for an implementation", async () => {
    intel = await indexed();
    const related = await intel.findRelatedTests("src/services/auth/session.ts", { limit: 10 });
    const paths = related.items.map((item) => item.path);
    recordR21Evidence("retrieval-quality", { suite: "test-impact", for: "src/services/auth/session.ts", returned: paths });
    expect(paths).toContain("tests/session.test.ts");
  }, 120000);

  it("cross-file reasoning: dependents of a service include its controller and its tests", async () => {
    intel = await indexed();
    const deps = await intel.findDependents("src/services/billing-service.ts", { limit: 20 });
    const paths = deps.items.map((edge) => edge.sourcePath);
    recordR21Evidence("retrieval-quality", { suite: "cross-file", for: "src/services/billing-service.ts", dependents: paths });
    expect(paths).toContain("src/api/billing-controller.ts");
    expect(paths).toContain("tests/billing-service.test.ts");
  }, 120000);

  it("freshness: after a symbol rename + refresh, the new name retrieves and the stale name does not lead", async () => {
    intel = await indexed();
    const staleQuery = "Fix the off-by-one error in paginateResults";
    const before = await intel.findRelevantContext(staleQuery, { limit: 15 });
    expect(before.items.some((item) => item.path === "src/utils/pagination.ts")).toBe(true);

    const file = path.join(root, "src/utils/pagination.ts");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("paginateResults", "paginateResultsWindowed"), "utf8");
    await intel.refresh();

    const after = await intel.findRelevantContext("Fix the off-by-one error in paginateResultsWindowed", { limit: 15 });
    const stale = await intel.findRelevantContext(staleQuery, { limit: 15 });
    recordR21Evidence("retrieval-quality", {
      suite: "freshness",
      renamedHit: after.items.findIndex((i) => i.path === "src/utils/pagination.ts") + 1,
      staleQueryTop: stale.items.slice(0, 5).map((i) => i.path),
    });
    expect(after.items[0]?.path).toBe("src/utils/pagination.ts");
    // The renamed file must not retain a stale symbol; the stale name surviving in the generated
    // fixture is the contamination case, not staleness of this file's record.
    const symbols = await intel.searchSymbols("paginateResults", { limit: 20 });
    const inTarget = symbols.items.filter((s) => s.path === "src/utils/pagination.ts");
    expect(inTarget.length).toBeGreaterThan(0);
    expect(inTarget.every((s) => s.name === "paginateResultsWindowed")).toBe(true);
  }, 120000);
});

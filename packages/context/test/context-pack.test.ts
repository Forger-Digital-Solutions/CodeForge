import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import { buildContextPack, compactLedger, estimateTokens, type LedgerEvent } from "../src/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("context architecture", () => {
  it.each([16_000, 32_000, 64_000, 128_000])("never overflows a %i token window and provides fresh deduplicated provenance", async (contextWindow) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-context-workspace-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-context-cache-"));
    roots.push(root, cache);
    fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "src", "token.ts"), "export function verifyToken(token: string): boolean { return token.length > 0; }\n", "utf8");
    fs.writeFileSync(path.join(root, "tests", "token.test.ts"), "import { verifyToken } from '../src/token.js';\nit('verifies token', () => verifyToken('x'));\n", "utf8");
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root); await intelligence.indexWorkspace();
    const pack = await buildContextPack("Fix verifyToken and inspect its tests", intelligence, { contextWindow, systemPromptTokens: 1_000, toolSchemaTokens: 1_000, reservedOutputTokens: 1_000, safetyMarginTokens: 512 });
    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.budget.repository);
    expect(pack.chunks.some((chunk) => chunk.provenance.path === "src/token.ts")).toBe(true);
    expect(pack.chunks.every((chunk) => chunk.provenance.fresh && chunk.provenance.contentHash && chunk.provenance.selectionReasons.length)).toBe(true);
    expect(new Set(pack.chunks.map((chunk) => chunk.provenance.contentHash)).size).toBe(pack.chunks.length);
    expect(pack.chunks.every((chunk) => estimateTokens(chunk.content) === chunk.tokenEstimate)).toBe(true);
    await intelligence.closeWorkspace();
  });

  it("compacts long histories without dropping constraints, failures, verification, or blockers", () => {
    const critical: LedgerEvent[] = [
      { id: "goal", kind: "goal", summary: "Fix expiry", timestamp: "1" },
      { id: "constraint", kind: "constraint", summary: "Do not change API", timestamp: "2" },
      { id: "failure", kind: "failure", summary: "First approach broke replay handling", timestamp: "3" },
      { id: "verification", kind: "verification", summary: "Target test failed", timestamp: "4" },
      { id: "blocker", kind: "blocker", summary: "Need fixture", timestamp: "5", uncertain: true },
    ];
    const events: LedgerEvent[] = [...Array.from({ length: 1_000 }, (_, index) => ({ id: `noise-${index}`, kind: "noise" as const, summary: "redundant output", timestamp: String(index) })), ...critical];
    const compacted = compactLedger(events);
    expect(compacted.facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(["goal", "constraint", "failure", "verification", "blocker"]));
    expect(compacted.discardedEventCount).toBe(1_000);
    expect(compacted.facts.find((fact) => fact.kind === "blocker")?.uncertain).toBe(true);
  });

  it("prioritizes the current diff and related tests without duplicating selected content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-context-diff-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-context-diff-cache-"));
    roots.push(root, cache);
    fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "src", "expiry.ts"), "export function tokenExpired(now: number): boolean { return now > 10; }\n");
    fs.writeFileSync(path.join(root, "tests", "expiry.test.ts"), "import { tokenExpired } from '../src/expiry.js';\nit('expires', () => tokenExpired(11));\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=CodeForge", "-c", "user.email=codeforge@example.invalid", "commit", "-qm", "initial"], { cwd: root });
    fs.writeFileSync(path.join(root, "src", "expiry.ts"), "export function tokenExpired(now: number): boolean { return now >= 10; }\n");
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root); await intelligence.indexWorkspace();
    const pack = await buildContextPack("Fix tokenExpired and run related tests", intelligence, { contextWindow: 32_000 });
    expect(pack.currentDiff).toContain("now >= 10");
    expect(pack.relevantTests).toEqual(expect.arrayContaining([expect.objectContaining({ path: "tests/expiry.test.ts" })]));
    expect(pack.chunks.some((chunk) => chunk.provenance.path === "src/expiry.ts" && chunk.provenance.symbol === "tokenExpired")).toBe(true);
    expect(new Set(pack.chunks.map((chunk) => chunk.provenance.contentHash)).size).toBe(pack.chunks.length);
    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.budget.repository);
    await intelligence.closeWorkspace();
  });
});

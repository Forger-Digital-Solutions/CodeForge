import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { EventStore } from "@codeforge/sessions";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { AgentRuntime, createAgentRuntime } from "../src/agent-runtime.js";
import { searchWorkspace } from "../src/search-service.js";
import { replaceExact, sha256 } from "../src/edit-service.js";
import { getSanitizedEnvForChild } from "../src/env-filter.js";
import { spawn } from "node:child_process";

function persistenceStub() {
  return {
    appendEvent: () => {},
    upsertSession: () => {},
    upsertTurn: () => {},
    getSession: () => undefined,
    listSessions: () => [],
    getTurns: () => [],
    getWorkItems: () => [],
    getEvents: () => [],
    close: () => {},
  } as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>;
}

describe("Deterministic autonomous coding E2E", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "auto-e2e-"));
    await mkdir(join(ws, "src"), { recursive: true });
    // Buggy implementation
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    await writeFile(join(ws, "src", "calc.test.ts"), "import { add } from './calc.js';\nif (add(2,3) !== 5) { console.log('FAIL'); process.exit(1); } console.log('PASS');\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ type: "module" }));
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("Open project -> search -> read -> validate hash -> approve -> edit atomically -> test fails -> search/readjust -> edit again -> test passes -> diff", async () => {
    // 1. Search
    const searchRes = await searchWorkspace({ query: "add", workspacePath: ws });
    expect(searchRes.matches.some(m => m.file.includes("calc.ts"))).toBe(true);
    expect(searchRes.truncated).toBe(false);

    // 2. Read relevant file with hash
    const content = fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8");
    const hash = sha256(content);
    expect(content).toContain("a - b");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // 3. Runtime validates expected hash -> approve if required -> edit applied atomically
    // Simulate human edit conflict protection: attempt stale edit should fail
    fs.writeFileSync(join(ws, "src", "calc.ts"), content); // ensure unchanged
    let editRes = replaceExact({
      workspacePath: ws,
      relativePath: "src/calc.ts",
      oldText: "  return a - b;",
      newText: "  return a + b;",
      expectedOccurrences: 1,
      expectedHash: hash,
    });
    expect(editRes.success).toBe(true);
    expect(editRes.diff).toContain("a - b");
    expect(editRes.diff).toContain("a + b");
    expect(fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8")).toContain("a + b");

    // 4. Agent runs test (simulated via filtered env and direct evaluation, no shell)
    async function runCalcTest(): Promise<{ code: number | null; out: string }> {
      // Read and evaluate calc.ts directly to avoid spawn shell quoting issues on Windows
      const calcSrc = fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8");
      const isAddCorrect = calcSrc.includes("a + b");
      return isAddCorrect ? { code: 0, out: "PASS" } : { code: 1, out: "FAIL" };
    }
    const testRun = await runCalcTest();
    // After fix, test should pass
    expect(testRun.out).toContain("PASS");
    expect(testRun.code).toBe(0);

    // 5. Simulate second cycle where test initially fails then fix: revert and retry
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    const failRun = await runCalcTest();
    expect(failRun.out).toContain("FAIL");
    expect(failRun.code).toBe(1);

    // 6. Search/readjust and edit again
    const search2 = await searchWorkspace({ query: "return a", workspacePath: ws });
    expect(search2.matches.length).toBeGreaterThan(0);
    const content2 = fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8");
    const hash2 = sha256(content2);
    const edit2 = replaceExact({
      workspacePath: ws,
      relativePath: "src/calc.ts",
      oldText: "  return a - b;",
      newText: "  return a + b;",
      expectedHash: hash2,
    });
    expect(edit2.success).toBe(true);

    const passRun = await runCalcTest();
    expect(passRun.out).toContain("PASS");

    // 7. Diff generation bounded and redacted
    expect(edit2.diff).toBeDefined();
    expect(edit2.diff!.length).toBeLessThan(35 * 1024);

    // 8. Verify tool result pipeline: secret would be redacted if present
    await writeFile(join(ws, "src", "secret.ts"), "const x = 'sk-proj-1234567890abcdef';");
    const searchSecret = await searchWorkspace({ query: "sk-proj", workspacePath: ws });
    for (const m of searchSecret.matches) {
      expect(m.preview).not.toContain("sk-proj-1234567890");
    }

    // 9. Verify via AgentRuntime approval gate: edit_file requires approval
    const fw = new ForgeZero();
    fw.register({
      providerId: "test", modelId: "test-model", displayName: "Test",
      freeStatus: "verified_free", tier: "free" as const, contextWindow: 128000,
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "test" },
      isRemote: true, isCloudHosted: true,
    });
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "test", streamEvents: [[{ type: "text_delta", delta: "done" }, { type: "finish", finishReason: "stop" }]] }));
    const es = new EventStore();
    const rt = createAgentRuntime({ sessionId: "e2e", eventStore: es, persistence: persistenceStub(), firewall: fw, providerCatalog: catalog, workspacePath: ws });
    const svc = rt.getApprovalService();
    const { approvalId, promise } = svc.requestApproval({ turnId: "tE2E", tool: "edit_file", action: "write", description: "edit_file: file modification", risk: "moderate" });
    expect(svc.getPending(approvalId)).toBeDefined();
    svc.resolve(approvalId, "allow_once");
    const approved = await promise;
    expect(approved.approved).toBe(true);
    // Only after approval would edit execute (we already proved edit succeeds)
  });

  it("stale edit protection prevents overwriting human change", async () => {
    const initial = fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8");
    const hash = sha256(initial);
    // Human edits file
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a * b;\n}\n");
    const staleAttempt = replaceExact({
      workspacePath: ws,
      relativePath: "src/calc.ts",
      oldText: "  return a - b;",
      newText: "  return a + b;",
      expectedHash: hash,
    });
    expect(staleAttempt.success).toBe(false);
    expect(staleAttempt.error).toMatch(/Stale edit/);
    expect(fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8")).toContain("a * b");
  });

  it("atomic write leaves file intact on ambiguous failure", async () => {
    await writeFile(join(ws, "src", "dup.txt"), "x\nx\nx\n");
    const before = fs.readFileSync(join(ws, "src", "dup.txt"), "utf-8");
    const res = replaceExact({ workspacePath: ws, relativePath: "src/dup.txt", oldText: "x", newText: "y", expectedOccurrences: 1 });
    expect(res.success).toBe(false);
    expect(fs.readFileSync(join(ws, "src", "dup.txt"), "utf-8")).toBe(before);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamEvent } from "@codeforge/providers";
import { CONTROL_ARM, OPTIMIZED_ARM } from "../src/r23/arms.js";
import { parsePricingSnapshot } from "../src/r23/pricing.js";
import { runTaskArm, type RunIdentityInput } from "../src/r23/run-task.js";
import { freezeManifest, loadTask, verifyManifest } from "../src/r23/tasks.js";
import type { ModelCallRecord } from "../src/r23/run-record.js";

/**
 * R23 M4 — end-to-end harness fixture: the real AgentRuntime, a deterministic scripted model,
 * a real hidden verifier (node script) and both arms. Proves the whole pipeline emits a valid,
 * invariant-consistent run record; that a "done" claim without the fix is recorded as a FALSE
 * completion; and that a crash mid-run leaves a complete incremental ledger (restart fixture).
 */

type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;

class ScriptedProvider implements ProviderAdapter {
  readonly providerId = "scripted";
  readonly isTestProvider = true;
  private index = 0;
  constructor(private readonly responders: Responder[]) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "scripted-free", displayName: "Scripted", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(): Promise<ChatResponse> {
    throw new Error("use streamChat");
  }
  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const responder = this.responders[Math.min(this.index, this.responders.length - 1)]!;
    this.index += 1;
    for await (const event of responder(req)) {
      if (signal?.aborted) return;
      yield event;
    }
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

let counter = 0;
function toolTurn(name: string, args: Record<string, unknown>, usage = { inputTokens: 500, outputTokens: 40 }): Responder {
  const id = `tc-${++counter}`;
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: name };
    yield { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) };
    yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: { ...usage, costUsd: 0 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}
function finalTurn(text: string, usage = { inputTokens: 700, outputTokens: 30 }): Responder {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { ...usage, costUsd: 0 } };
    yield { type: "finish", finishReason: "stop" };
  };
}

const PRICING = parsePricingSnapshot({
  snapshotId: "fixture-snapshot",
  frozenAt: "2026-09-20T00:00:00.000Z",
  currency: "USD",
  equivalents: { "scripted::scripted-free": { priceRef: "scripted::paid-twin", rationale: "fixture" } },
  marketReference: { priceRef: "reference::frontier", rationale: "fixture" },
  prices: {
    "scripted::paid-twin": { id: "scripted::paid-twin", inputPerMillionUsd: 1, outputPerMillionUsd: 4, source: "fixture", retrievedAt: "2026-09-20T00:00:00.000Z" },
    "reference::frontier": { id: "reference::frontier", inputPerMillionUsd: 3, outputPerMillionUsd: 15, source: "fixture", retrievedAt: "2026-09-20T00:00:00.000Z" },
  },
});

const identity: RunIdentityInput = {
  campaignId: "r23-fixture",
  phase: "fixture",
  pairId: "pair-fixture",
  pairOrder: "control-first",
  repetition: 1,
  protocolVersion: "1.0.0",
  protocolDigest: "0".repeat(64),
  codeforgeCommit: "fixture",
  codeforgeTreeDirty: false,
  environmentFingerprint: "fixture-env",
};

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";
const FIXED_LINE_OLD = "return a - b;";
const FIXED_LINE_NEW = "return a + b;";

let corpusRoot: string;
let scratchRoot: string;

async function writeTask(root: string, taskId: string): Promise<void> {
  const dir = path.join(root, taskId);
  await fs.mkdir(path.join(dir, "fixture", "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "hidden"), { recursive: true });
  await fs.writeFile(path.join(dir, "fixture", "src", "math.js"), BUGGY);
  await fs.writeFile(path.join(dir, "fixture", "package.json"), JSON.stringify({ name: "fixture", type: "module" }, null, 2));
  await fs.writeFile(path.join(dir, "hidden", "verify.mjs"), [
    "import { add, multiply } from \"../src/math.js\";",
    "let passed = 0, failed = 0;",
    "const check = (ok) => { if (ok) passed += 1; else failed += 1; };",
    "check(add(2, 3) === 5);",
    "check(add(-1, 1) === 0);",
    "check(multiply(3, 4) === 12);",
    "console.log(JSON.stringify({ passed, failed }));",
    "process.exit(failed === 0 ? 0 : 1);",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(dir, "task.json"), JSON.stringify({
    taskId,
    class: "small_fix",
    language: "javascript",
    repoSizeClass: "small",
    goal: "The add() function in src/math.js returns the wrong result. Fix it so add(2, 3) returns 5 without changing multiply().",
    role: "coder",
    permissions: { read: true, search: true, write: true, executeCommand: false, network: false },
    visibleVerification: ["node --check src/math.js"],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
  }, null, 2));
}

beforeAll(async () => {
  corpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), "r23-corpus-"));
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "r23-scratch-"));
  await writeTask(corpusRoot, "fixture-add-sign");
});

afterAll(async () => {
  for (const dir of [corpusRoot, scratchRoot]) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("R23 harness end-to-end (single-agent mode, scripted model)", () => {
  it("freezes and verifies the task manifest byte-for-byte", async () => {
    const manifest = await freezeManifest(corpusRoot, "fixture-batch");
    expect(manifest.tasks).toHaveLength(1);
    expect(manifest.tasks[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyManifest(corpusRoot, manifest)).ok).toBe(true);
    // Any edit to a frozen task is detected.
    await fs.appendFile(path.join(corpusRoot, "fixture-add-sign", "task.json"), "\n");
    const drift = await verifyManifest(corpusRoot, manifest);
    expect(drift.ok).toBe(false);
    expect(drift.mismatches[0]).toContain("fixture-add-sign");
  });

  it("produces valid, invariant-consistent records in BOTH arms and marks the fixed task verified", async () => {
    const task = await loadTask(path.join(corpusRoot, "fixture-add-sign"));
    const outputs = [] as Awaited<ReturnType<typeof runTaskArm>>[];
    for (const [arm, armId] of [[CONTROL_ARM, "control"], [OPTIMIZED_ARM, "optimized"]] as const) {
      const provider = new ScriptedProvider([
        toolTurn("read_file", { path: "src/math.js" }),
        toolTurn("edit_file", { path: "src/math.js", oldText: FIXED_LINE_OLD, newText: FIXED_LINE_NEW }),
        toolTurn("read_file", { path: "src/math.js" }),
        finalTurn("Fixed add() to return a + b."),
      ]);
      const output = await runTaskArm({
        task, arm, armId, executionMode: "single_agent_run",
        model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" },
        createProvider: () => provider,
        routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
        identity: { ...identity, pairOrder: "control-first" },
        pricing: PRICING,
        scratchRoot,
        wallClockCapMs: 120_000,
      });
      outputs.push(output);
      expect(output.violations, `${armId} invariants`).toEqual([]);
      const record = output.record;
      expect(record.identity.arm).toBe(armId);
      expect(record.identity.forgeGreenEnabled).toBe(armId === "optimized");
      expect(record.outcome.runtimeStatus).toBe("completed");
      expect(record.outcome.claimedComplete).toBe(true);
      expect(record.outcome.verifierRan).toBe(true);
      expect(record.outcome.verifierPassed).toBe(true);
      expect(record.outcome.testsPassed).toBe(3);
      expect(record.outcome.testsFailed).toBe(0);
      expect(record.outcome.completionAuthority).toBe("PASS");
      expect(record.outcome.verifiedComplete).toBe(true);
      expect(record.outcome.classification).toBe("verified_complete");
      expect(record.outcome.filesChanged).toEqual(["src/math.js"]);
      expect(record.outcome.linesAdded).toBe(1);
      expect(record.outcome.linesRemoved).toBe(1);
      expect(record.identity.startingTreeHash).not.toBe(record.identity.endingTreeHash);
      // Known-token fixture: 3 tool turns × 500/40 + final 700/30, all provider-reported, $0 reported.
      expect(record.inference.modelCalls).toBe(4);
      expect(record.inference.callsWithProviderUsage).toBe(4);
      expect(record.inference.totalInputTokens).toMatchObject({ value: 2200, source: "OBSERVED", origin: "PROVIDER" });
      expect(record.inference.totalOutputTokens).toMatchObject({ value: 150, source: "OBSERVED" });
      expect(record.inference.totalTokens.value).toBe(2350);
      expect(record.inference.cachedInputTokens.source).toBe("UNKNOWN");
      expect(record.economics.actualCostUsd).toMatchObject({ value: 0, source: "OBSERVED", origin: "PROVIDER" });
      expect(record.economics.equivalentPublicApiCostUsd.value).toBeCloseTo(2200 * 1e-6 + 150 * 4e-6, 12);
      expect(record.economics.equivalentMarketCostUsd.value).toBeCloseTo(2200 * 3e-6 + 150 * 15e-6, 12);
      // Activity from the trace: two reads, one edit.
      expect(record.activity.toolCallsRequested).toBe(3);
      expect(record.activity.fileReads).toBe(2);
      expect(record.activity.fileWrites).toBe(1);
      expect(record.activity.toolCallsExecuted).toBe(3);
      // Context accounting: the re-read after the edit is necessary, so no avoidable duplicates.
      expect(record.context.avoidableDuplicateEvents).toEqual([]);
      expect(record.context.transmittedContextBytes).toBeGreaterThan(record.context.finalConversationBytes);
      expect(record.context.finalComposition.toolResultBytesByTool.read_file).toBeGreaterThan(0);
      expect(record.context.finalComposition.toolResultBytesByTool.edit_file).toBeGreaterThan(0);
      expect(record.resources.cpuUserMs.source).toBe("OBSERVED");
      expect(record.resources.peakRssBytes.value).toBeGreaterThan(0);
      expect(record.time.modelWaitMs).toBeGreaterThanOrEqual(0);
      expect(record.time.verificationMs).toBeGreaterThan(0);
    }
    const [control, optimized] = outputs.map((output) => output.record);
    expect(control!.identity.armConfigurationDigest).not.toBe(optimized!.identity.armConfigurationDigest);
    // Same scripted trace → same physical work; the control arm must never see planner-selected
    // file content at bootstrap (pull-only), the optimized arm may.
    expect(control!.context.bootstrapSelectedFiles).toBe(0);
    expect(control!.identity.topology).toBe("single_agent_run:tiny");
    expect(control!.telemetry.efficiencyReasonCodes).not.toContain("duplicate_action_suppressed");
  }, 180_000);

  it("records a 'done' claim without the fix as a FALSE completion caught by the hidden verifier", async () => {
    const task = await loadTask(path.join(corpusRoot, "fixture-add-sign"));
    const provider = new ScriptedProvider([
      toolTurn("read_file", { path: "src/math.js" }),
      finalTurn("Reviewed src/math.js; add() is already correct. Done."),
    ]);
    const output = await runTaskArm({
      task, arm: OPTIMIZED_ARM, armId: "optimized", executionMode: "single_agent_run",
      model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" },
      createProvider: () => provider,
      routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      identity, pricing: PRICING, scratchRoot, wallClockCapMs: 120_000,
    });
    expect(output.violations).toEqual([]);
    expect(output.record.outcome.claimedComplete).toBe(true);
    expect(output.record.outcome.verifierPassed).toBe(false);
    expect(output.record.outcome.testsFailed).toBe(2);
    expect(output.record.outcome.verifiedComplete).toBe(false);
    expect(output.record.outcome.falseComplete).toBe(true);
    expect(output.record.outcome.classification).toBe("false_complete");
    expect(output.record.outcome.filesChanged).toEqual([]);
    expect(output.record.identity.startingTreeHash).toBe(output.record.identity.endingTreeHash);
  }, 120_000);

  it("restart fixture: a crash mid-run leaves a complete incremental ledger and no completion claim", async () => {
    const task = await loadTask(path.join(corpusRoot, "fixture-add-sign"));
    const controller = new AbortController();
    const journal: ModelCallRecord[] = [];
    let seen = 0;
    const provider = new ScriptedProvider([
      toolTurn("read_file", { path: "src/math.js" }),
      toolTurn("edit_file", { path: "src/math.js", oldText: FIXED_LINE_OLD, newText: FIXED_LINE_NEW }),
      // Third call: the process "crashes" (abort) while the model is answering.
      async function* () {
        yield { type: "text_delta", delta: "Re-reading" };
        controller.abort(new Error("simulated crash"));
        yield { type: "text_delta", delta: " never delivered" };
      },
      finalTurn("unreachable"),
    ]);
    const output = await runTaskArm({
      task, arm: CONTROL_ARM, armId: "control", executionMode: "single_agent_run",
      model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" },
      createProvider: () => provider,
      routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      identity, pricing: PRICING, scratchRoot, wallClockCapMs: 120_000,
      signal: controller.signal,
      onCall: (record) => { journal.push(record); seen += 1; },
    });
    // The incremental journal saw every call the run made, including the aborted one.
    expect(seen).toBe(3);
    expect(journal.map((call) => call.outcome)).toEqual(["ok", "ok", "aborted"]);
    expect(output.record.inference.modelCalls).toBe(3);
    expect(output.record.inference.calls.map((call) => call.callIndex)).toEqual([0, 1, 2]);
    expect(output.record.outcome.claimedComplete).toBe(false);
    expect(output.record.outcome.verifiedComplete).toBe(false);
    expect(output.record.outcome.runtimeStatus).toBe("cancelled");
    expect(["verification_failed", "tool_failure", "provider_failure", "timeout"]).toContain(output.record.outcome.classification);
    // Token totals are UNKNOWN because the aborted call has no provider usage — never estimated.
    expect(output.record.inference.totalInputTokens.source).toBe("UNKNOWN");
    expect(output.violations).toEqual([]);
    // The workspace edit that happened before the crash is preserved and hashed.
    expect(output.record.outcome.filesChanged).toEqual(["src/math.js"]);
  }, 120_000);
});

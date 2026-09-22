import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamEvent } from "@codeforge/providers";
import { CONTROL_ARM, OPTIMIZED_ARM } from "../src/r23/arms.js";
import { parsePricingSnapshot } from "../src/r23/pricing.js";
import { runTaskArm, type RunIdentityInput } from "../src/r23/run-task.js";
import { loadTask } from "../src/r23/tasks.js";

/**
 * R23 M4 — orchestrated execution mode (the production `AutonomousRunOrchestrator` path both
 * arms use in the pilot and main benchmark): git-backed fixture, worktree isolation, the arm's
 * topology (control = explicit `tiny`; optimized = adaptive), ForgeVerify on the visible checks,
 * the completion gate, integration, and the hidden verifier on the integrated tree. The scripted
 * model is role-aware so explorer / coder / reviewer children each receive a valid trace.
 */

type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;

function detectRole(req: ChatRequest): "explorer" | "planner" | "coder" | "reviewer" {
  const system = req.system ?? req.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("You are CodeForge Explorer")) return "explorer";
  if (system.includes("You are CodeForge Planner")) return "planner";
  if (system.includes("You are CodeForge Reviewer")) return "reviewer";
  return "coder";
}

class RoleScriptedProvider implements ProviderAdapter {
  readonly providerId = "scripted";
  readonly isTestProvider = true;
  readonly rolesSeen: string[] = [];
  private readonly cursors = new Map<string, number>();
  constructor(private readonly scripts: Record<"explorer" | "planner" | "coder" | "reviewer", Responder[]>) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "scripted-free", displayName: "Scripted", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(): Promise<ChatResponse> {
    throw new Error("use streamChat");
  }
  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const role = detectRole(req);
    this.rolesSeen.push(role);
    const cursor = this.cursors.get(role) ?? 0;
    const script = this.scripts[role];
    const responder = script[Math.min(cursor, script.length - 1)]!;
    this.cursors.set(role, cursor + 1);
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
const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, costUsd: 0 });
function toolTurn(name: string, args: Record<string, unknown>): Responder {
  const id = `tc-${++counter}`;
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: name };
    yield { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) };
    yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: usage(400, 30) };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}
function finalTurn(text: string): Responder {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: usage(600, 60) };
    yield { type: "finish", finishReason: "stop" };
  };
}

const PRICING = parsePricingSnapshot({
  snapshotId: "fixture-snapshot",
  frozenAt: "2026-09-20T00:00:00.000Z",
  currency: "USD",
  equivalents: { "scripted::scripted-free": { priceRef: "scripted::paid-twin", rationale: "fixture" } },
  marketReference: { priceRef: "scripted::paid-twin", rationale: "fixture" },
  prices: { "scripted::paid-twin": { id: "scripted::paid-twin", inputPerMillionUsd: 1, outputPerMillionUsd: 4, source: "fixture", retrievedAt: "2026-09-20T00:00:00.000Z" } },
});

const identity: RunIdentityInput = {
  campaignId: "r23-fixture", phase: "fixture", pairId: "pair-orch", pairOrder: "control-first", repetition: 1,
  protocolVersion: "1.0.0", protocolDigest: "0".repeat(64), codeforgeCommit: "fixture", codeforgeTreeDirty: false, environmentFingerprint: "fixture-env",
};

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";

let corpusRoot: string;
let scratchRoot: string;

beforeAll(async () => {
  corpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), "r23-orch-corpus-"));
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "r23-orch-scratch-"));
  const dir = path.join(corpusRoot, "fixture-orch-add");
  await fs.mkdir(path.join(dir, "fixture", "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "hidden"), { recursive: true });
  await fs.writeFile(path.join(dir, "fixture", "src", "math.js"), BUGGY);
  await fs.writeFile(path.join(dir, "fixture", "package.json"), JSON.stringify({ name: "fixture", type: "module" }, null, 2));
  await fs.writeFile(path.join(dir, "hidden", "verify.mjs"), "import { add, multiply } from \"../src/math.js\";\nlet passed = 0, failed = 0;\nconst check = (ok) => { if (ok) passed += 1; else failed += 1; };\ncheck(add(2, 3) === 5);\ncheck(multiply(3, 4) === 12);\nconsole.log(JSON.stringify({ passed, failed }));\nprocess.exit(failed === 0 ? 0 : 1);\n");
  await fs.writeFile(path.join(dir, "task.json"), JSON.stringify({
    taskId: "fixture-orch-add", class: "small_fix", language: "javascript", repoSizeClass: "small",
    goal: "Investigate why the add() function in src/math.js returns the wrong result. Fix it so add(2, 3) returns 5 without changing multiply().",
    role: "coder", permissions: { read: true, search: true, write: true, executeCommand: false, network: false },
    visibleVerification: ["node --check src/math.js"],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
  }, null, 2));
});

afterAll(async () => {
  for (const dir of [corpusRoot, scratchRoot]) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function scripts() {
  return {
    explorer: [toolTurn("read_file", { path: "src/math.js" }), finalTurn(JSON.stringify({ summary: "add() subtracts instead of adding in src/math.js", findings: [], evidence: [{ kind: "file", ref: "src/math.js", description: "add() body" }] }))],
    planner: [finalTurn(JSON.stringify({ summary: "fix add", tasks: [{ id: "t1", title: "Fix add", objective: "flip the operator", dependencies: [], assignedRole: "coder" }] }))],
    coder: [toolTurn("read_file", { path: "src/math.js" }), toolTurn("edit_file", { path: "src/math.js", oldText: "return a - b;", newText: "return a + b;" }), finalTurn("Fixed add() to return a + b.")],
    reviewer: [toolTurn("read_file", { path: "src/math.js" }), finalTurn(JSON.stringify({ verdict: "pass", findings: [], summary: "The operator fix is correct and minimal." }))],
  };
}

describe("R23 harness — orchestrated execution mode", () => {
  it("control arm runs the explicit tiny topology (coder only) through the production orchestrator and verifies", async () => {
    const task = await loadTask(path.join(corpusRoot, "fixture-orch-add"));
    const provider = new RoleScriptedProvider(scripts());
    const output = await runTaskArm({
      task, arm: CONTROL_ARM, armId: "control", executionMode: "orchestrated",
      model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" },
      createProvider: () => provider,
      routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      identity, pricing: PRICING, scratchRoot, wallClockCapMs: 180_000,
    });
    expect(output.violations).toEqual([]);
    expect(output.orchestratorResult?.status).toBe("completed");
    expect(output.orchestratorResult?.topology?.plan.topology).toBe("tiny");
    expect(output.orchestratorResult?.topology?.policy).toBe("explicit");
    expect(provider.rolesSeen.every((role) => role === "coder")).toBe(true);
    const record = output.record;
    expect(record.identity.topology).toBe("orchestrated:tiny");
    expect(record.identity.subagentsEnabled).toBe(false);
    expect(record.activity.subagentCount).toBe(0);
    expect(record.outcome.completionAuthority).toBe("PASS");
    expect(record.outcome.verifierPassed).toBe(true);
    expect(record.outcome.verifiedComplete).toBe(true);
    expect(record.outcome.classification).toBe("verified_complete");
    expect(record.outcome.filesChanged).toEqual(["src/math.js"]);
    expect(record.inference.modelCalls).toBe(3);
    expect(record.inference.totalInputTokens.value).toBe(400 + 400 + 600);
  }, 240_000);

  it("optimized arm runs the adaptive topology (explorer → coder → reviewer) and every child's calls land in one ledger", async () => {
    const task = await loadTask(path.join(corpusRoot, "fixture-orch-add"));
    const provider = new RoleScriptedProvider(scripts());
    const output = await runTaskArm({
      task, arm: OPTIMIZED_ARM, armId: "optimized", executionMode: "orchestrated",
      model: { providerId: "scripted", modelId: "scripted-free", routeClass: "fixture" },
      createProvider: () => provider,
      routeListedUnitPrice: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      identity: { ...identity, pairOrder: "optimized-first" }, pricing: PRICING, scratchRoot, wallClockCapMs: 180_000,
    });
    expect(output.violations).toEqual([]);
    expect(output.orchestratorResult?.status).toBe("completed");
    expect(output.orchestratorResult?.topology?.policy).toBe("adaptive");
    expect(output.orchestratorResult?.topology?.plan.topology).toBe("normal");
    expect(new Set(provider.rolesSeen)).toEqual(new Set(["explorer", "coder", "reviewer"]));
    const record = output.record;
    expect(record.identity.topology).toBe("orchestrated:normal");
    expect(record.identity.subagentsEnabled).toBe(true);
    expect(record.activity.subagentCount).toBeGreaterThanOrEqual(2);
    expect(record.outcome.verifiedComplete).toBe(true);
    // The ledger holds every role's calls: explorer 2 + coder 3 + reviewer 2 = 7, all provider-reported.
    expect(record.inference.modelCalls).toBe(7);
    expect(record.inference.callsWithProviderUsage).toBe(7);
    expect(record.inference.totalInputTokens.value).toBe(4 * 400 + 3 * 600);
    expect(record.inference.totalOutputTokens.value).toBe(4 * 30 + 3 * 60);
  }, 240_000);
});

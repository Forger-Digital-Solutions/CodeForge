import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamEvent } from "@codeforge/providers";
import { estimatePromptOnlyTokens } from "@codeforge/providers";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createLease, createTaskAuthority } from "@codeforge/permissions";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime, agentToolDefinitions } from "../src/agent-runtime.js";

/**
 * R34 Mission G — context-efficiency benchmark.
 *
 * Drives the REAL AgentRuntime turn loop with a scripted provider and measures the exact
 * serialized request input (estimatePromptOnlyTokens — the same estimator Mission E uses
 * for admission) on every dispatch, before vs after the R34 compaction work. The scripted
 * provider only supplies model decisions; all tool execution is real against a tmpfs
 * workspace, so the history that accumulates is what production produces.
 */

class RecordingProvider implements ProviderAdapter {
  readonly providerId = "bench-provider";
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];
  private readonly script: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>;
  private callCount = 0;

  constructor(script: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>) {
    this.script = script;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "scripted-free",
      displayName: "Scripted Free",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("stream only");
  }

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    // Snapshot: callers may reuse a mutable messages array across dispatches.
    this.requests.push(structuredClone(req));
    const step = this.script[this.callCount] ?? this.script[this.script.length - 1];
    this.callCount++;
    if (!step) {
      yield { type: "text_delta", delta: "done" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    yield* step(req);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: name };
    yield { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) };
    yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}

function finalAnswer(text: string): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "finish", finishReason: "stop" };
  };
}

interface RequestMeasurement {
  index: number;
  estimatedPromptTokens: number;
  messageCount: number;
  toolMessageBytes: number;
}

interface ArmResult {
  requests: RequestMeasurement[];
  totalInputTokens: number;
  requestCount: number;
  taskSucceeded: boolean;
  fileContent: string;
}

/**
 * A realistic medium task: read the buggy file, run a check, read again (the ForgeGreen
 * duplicate supervisor replays the identical read — both copies otherwise sit in history),
 * edit, re-check, answer. Under compaction the stale first read leaves the transcript.
 */
async function runMediumTask(workspacePath: string, compaction: boolean): Promise<ArmResult> {
  const target = path.join(workspacePath, "calc.ts");
  const staleBody = "export function add(a:number,b:number){ return a - b; }\n".padEnd(1500, "// filler\n");
  await fs.writeFile(target, staleBody, "utf-8");

  const provider = new RecordingProvider([
    toolCall("tc-1", "read_file", { path: "calc.ts" }),
    toolCall("tc-2", "run_command", { command: "node --version" }),
    toolCall("tc-3", "read_file", { path: "calc.ts" }),
    toolCall("tc-4", "edit_file", { path: "calc.ts", oldText: "a - b", newText: "a + b" }),
    toolCall("tc-5", "run_command", { command: "node --version" }),
    finalAnswer("Fixed the add function."),
  ]);

  const persistence = createSessionPersistence();
  try {
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "bench-provider", modelId: "scripted-free" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "bench-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath,
      efficiencyControls: { supersededCompaction: compaction },
    });

    const result = await runtime.executeAgentRun({
      runId: "bench-run",
      agentId: "coder",
      role: "coder",
      goal: "Fix the add function in calc.ts",
      workspaceId: "ws-bench",
      workspacePath,
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
    });
    if (process.env.CF_BENCH_DEBUG) {
      const debugPath = path.join(os.tmpdir(), `cf-bench-debug-${compaction ? "on" : "off"}.json`);
      await fs.writeFile(debugPath, JSON.stringify({
        status: result.status,
        stopReason: result.stopReason,
        toolExecutions: result.toolExecutions.map((t) => ({ name: t.toolName, success: t.success, out: (t.output ?? "").slice(0, 300), error: t.error })),
        requestCount: provider.requests.length,
        requestMessages: provider.requests.map((r) => r.messages.map((m) => ({
          role: m.role,
          tcId: m.toolCallId,
          len: m.content?.length ?? 0,
          calls: m.toolCalls?.map((c) => `${c.id}:${c.function.name}`),
          head: m.content?.slice(0, 60),
        }))),
      }, null, 2), "utf-8");
    }

    const requests: RequestMeasurement[] = provider.requests.map((req, index) => ({
      index,
      estimatedPromptTokens: estimatePromptOnlyTokens({ model: req.model, messages: req.messages, tools: req.tools ?? [], maxTokens: req.maxTokens ?? 4096 }),
      messageCount: req.messages.length,
      toolMessageBytes: req.messages.filter((m) => m.role === "tool").reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
    }));

    return {
      requests,
      totalInputTokens: requests.reduce((s, r) => s + r.estimatedPromptTokens, 0),
      requestCount: requests.length,
      taskSucceeded: result.status === "completed",
      fileContent: await fs.readFile(target, "utf-8"),
    };
  } finally {
    persistence.close();
  }
}

/**
 * Same task through the interactive turn loop (`startTurn` → runAgentLoop). This path has
 * NO pre-existing stale-read invalidation — before R34 the superseded and mutated reads
 * cost their full size on every subsequent dispatch.
 */
async function runInteractiveTask(workspacePath: string, compaction: boolean): Promise<ArmResult> {
  const target = path.join(workspacePath, "calc.ts");
  const staleBody = "export function add(a:number,b:number){ return a - b; }\n".padEnd(1500, "// filler\n");
  await fs.writeFile(target, staleBody, "utf-8");

  const provider = new RecordingProvider([
    toolCall("tc-1", "read_file", { path: "calc.ts" }),
    toolCall("tc-2", "run_command", { command: "node --version" }),
    toolCall("tc-3", "edit_file", { path: "calc.ts", oldText: "a - b", newText: "a + b" }),
    toolCall("tc-4", "read_file", { path: "calc.ts" }),
    finalAnswer("Fixed."),
  ]);

  const persistence = createSessionPersistence();
  try {
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "bench-provider", modelId: "scripted-free" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({
      sessionId: "bench-interactive",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath,
      efficiencyControls: { supersededCompaction: compaction },
      authorityFor: () => createTaskAuthority(createLease({
        sessionId: "bench-interactive",
        workspaceRoot: workspacePath,
        permissionMode: "full_autonomy",
        planMode: "continuous",
      })),
    });

    const turnId = await runtime.startTurn("Fix the add function in calc.ts");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = runtime.getTurn(turnId);
      if (state && state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const state = runtime.getTurn(turnId);

    const requests: RequestMeasurement[] = provider.requests.map((req, index) => ({
      index,
      estimatedPromptTokens: estimatePromptOnlyTokens({ model: req.model, messages: req.messages, tools: req.tools ?? [], maxTokens: req.maxTokens ?? 4096 }),
      messageCount: req.messages.length,
      toolMessageBytes: req.messages.filter((m) => m.role === "tool").reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
    }));

    return {
      requests,
      totalInputTokens: requests.reduce((s, r) => s + r.estimatedPromptTokens, 0),
      requestCount: requests.length,
      taskSucceeded: state?.status === "completed",
      fileContent: await fs.readFile(target, "utf-8"),
    };
  } finally {
    persistence.close();
  }
}

describe("R34 context-efficiency benchmark", () => {
  it("measures serialized input per dispatch, before vs after superseded-output compaction", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const historicalReceiptPath = path.join(repoRoot, "docs", "evidence", "r34-capacity-efficiency", "context-efficiency-benchmark.json");
    const historicalReceipt = await fs.readFile(historicalReceiptPath);
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "cf-bench-"));
    const wsA = path.join(tmpBase, "a");
    const wsB = path.join(tmpBase, "b");
    await fs.mkdir(wsA, { recursive: true });
    await fs.mkdir(wsB, { recursive: true });
    try {
      const before = await runMediumTask(wsA, false);
      const after = await runMediumTask(wsB, true);

      // Correctness is identical in both arms.
      expect(before.taskSucceeded).toBe(true);
      expect(after.taskSucceeded).toBe(true);
      expect(after.fileContent).toContain("a + b");
      expect(before.fileContent).toContain("a + b");
      expect(before.requestCount).toBe(after.requestCount);

      // The role-run path already invalidates stale reads durably after workspace
      // mutations — compaction may swap one marker string for another but must not
      // materially regress what it sends (marker-length jitter only).
      expect(after.totalInputTokens).toBeLessThanOrEqual(before.totalInputTokens + 16);

      // The interactive turn path lacked any stale-read handling: a 1.5k-char file read
      // superseded by an identical read, then invalidated by an edit, must leave the
      // dispatched transcript entirely under compaction.
      const wsC = path.join(tmpBase, "c");
      const wsD = path.join(tmpBase, "d");
      await fs.mkdir(wsC, { recursive: true });
      await fs.mkdir(wsD, { recursive: true });
      const intBefore = await runInteractiveTask(wsC, false);
      const intAfter = await runInteractiveTask(wsD, true);
      expect(intBefore.taskSucceeded).toBe(true);
      expect(intAfter.taskSucceeded).toBe(true);
      expect(intAfter.fileContent).toContain("a + b");
      expect(intBefore.fileContent).toContain("a + b");
      expect(intBefore.requestCount).toBe(intAfter.requestCount);
      expect(intAfter.totalInputTokens).toBeLessThan(intBefore.totalInputTokens);

      const receipt = {
        benchmark: "r34-context-efficiency-medium-task",
        generatedAt: new Date().toISOString(),
        roleRun: {
          note: "role transcripts already invalidate stale reads durably; compaction must not regress",
          before: { requests: before.requests, totalInputTokens: before.totalInputTokens },
          after: { requests: after.requests, totalInputTokens: after.totalInputTokens },
        },
        interactiveTurn: {
          note: "interactive messageHistory had no stale-read handling before R34",
          before: { requests: intBefore.requests, totalInputTokens: intBefore.totalInputTokens },
          after: { requests: intAfter.requests, totalInputTokens: intAfter.totalInputTokens },
          deltaInputTokens: intBefore.totalInputTokens - intAfter.totalInputTokens,
          deltaPct: Math.round(((intBefore.totalInputTokens - intAfter.totalInputTokens) / intBefore.totalInputTokens) * 1000) / 10,
        },
      };
      // Validation receipts belong to the fixture sandbox: the historical receipt may contain
      // uncommitted user work, and even a new generatedAt timestamp would destroy its bytes.
      const receiptPath = path.join(tmpBase, "context-efficiency-benchmark.json");
      await fs.writeFile(
        receiptPath,
        JSON.stringify(receipt, null, 2),
        "utf-8",
      );
      expect(JSON.parse(await fs.readFile(receiptPath, "utf-8"))).toEqual(receipt);
      expect(await fs.readFile(historicalReceiptPath)).toEqual(historicalReceipt);
      console.log(`[r34-bench] role before=${before.totalInputTokens} after=${after.totalInputTokens} | interactive before=${intBefore.totalInputTokens} after=${intAfter.totalInputTokens} delta=${receipt.interactiveTurn.deltaInputTokens} (${receipt.interactiveTurn.deltaPct}%)`);
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
      expect(await fs.readFile(historicalReceiptPath)).toEqual(historicalReceipt);
    }
  });

  it("drops repo_* schemas when the runtime has no workspace — dead capability is not advertised", async () => {
    const all = agentToolDefinitions();
    const repoCount = all.filter((t) => t.function.name.startsWith("repo_")).length;
    expect(repoCount).toBeGreaterThan(0);

    // No-workspace runtime must not carry ~1.1k tokens/call of guaranteed-failure tools.
    const persistence = createSessionPersistence();
    try {
      const eventStore = new EventStore();
      const firewall = new ForgeZero();
      firewall.register(createGenericFreeRecord({ providerId: "bench-provider", modelId: "scripted-free" }));
      const catalog = new InMemoryProviderCatalog();
      const provider = new RecordingProvider([finalAnswer("ok")]);
      catalog.register(provider);
      const runtime = createAgentRuntime({
        sessionId: "no-ws",
        eventStore,
        persistence,
        firewall,
        providerCatalog: catalog,
        // workspacePath intentionally absent
      });
      const turnId = await runtime.startTurn("hello");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const state = runtime.getTurn(turnId);
        if (state && state.status !== "running") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(provider.requests.length).toBeGreaterThan(0);
      const sentTools = provider.requests[0]!.tools ?? [];
      expect(sentTools.some((t) => t.function.name.startsWith("repo_"))).toBe(false);
      expect(sentTools.some((t) => t.function.name === "read_file")).toBe(true);
    } finally {
      persistence.close();
    }
  });
});

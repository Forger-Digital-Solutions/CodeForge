import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence, ForgeGreenCacheStore } from "@codeforge/sessions";
import { evaluateCompletion } from "@codeforge/workflow";
import type { WorkflowPlan, FailureAnalysis, ReviewDecision, VerificationResult } from "@codeforge/workflow";
import { createForgeGreenLedgerCollector } from "@codeforge/forge-green";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createAgentRuntime } from "../src/agent-runtime.js";

type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;

class RecordingScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  private readonly responders: Responder[];
  public requests: ChatRequest[] = [];

  constructor(providerId: string, responders: Responder[]) {
    this.providerId = providerId;
    this.responders = responders;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "scripted-free",
        displayName: "Scripted Free Model",
        isFree: true,
        freeStatus: "verified_free",
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      },
    ];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const responder = this.responders[Math.min(this.requests.length - 1, this.responders.length - 1)];
    if (!responder) {
      yield { type: "text_delta", delta: "No scripted response" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    for await (const event of responder(req)) {
      if (signal?.aborted) return;
      yield event;
    }
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

function repoToolTurn(toolCallId: string, name: string, args: Record<string, unknown>): Responder {
  return async function* () {
    yield { type: "tool_call_started", toolCallId, toolName: name };
    yield { type: "tool_call_delta", toolCallId, delta: JSON.stringify(args) };
    yield { type: "tool_call_completed", toolCallId, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}

function finalTurn(text: string): Responder {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
    yield { type: "finish", finishReason: "stop" };
  };
}

function plan(steps: Partial<import("@codeforge/workflow").PlanStep>[] = []): WorkflowPlan {
  return {
    id: "plan-1",
    title: "test plan",
    taskId: "task-1",
    status: "approved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: steps.map((s, i) => ({
      id: s.id ?? `step-${i}`,
      description: s.description ?? "step",
      status: s.status ?? "completed",
      kind: s.kind ?? "read",
      risk: s.risk ?? "safe",
      requiresApproval: s.requiresApproval ?? false,
      targetPath: s.targetPath,
    })),
  };
}

function analysis(): FailureAnalysis {
  return { hasFailures: false, summary: "ok", diagnostics: [], suggestedRepairs: [], isRepairable: false };
}

function review(): ReviewDecision {
  return {
    approved: true,
    issues: [],
    findings: [],
    diffs: [{ path: "src/a.ts", changeType: "modified", additions: 1, deletions: 1, diff: "-a\n+b", beforeHash: "x", afterHash: "y" }],
    summary: "1 file changed",
  };
}

function notRunVerification(): VerificationResult {
  return { passed: 0, failed: 0, skipped: 0, durationMs: 0, output: "", exitCode: 0, command: "", failures: [], notConfigured: true };
}

function passingVerification(): VerificationResult {
  return { passed: 3, failed: 0, skipped: 0, durationMs: 10, output: "3 passed", exitCode: 0, command: "npm test", failures: [] };
}

describe("FG-2 runtime integration", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg2-runtime-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
    await fs.writeFile(path.join(tmpDir, "helper.ts"), "export function helper(): number { return 1; }\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "index.ts"), "import { helper } from './helper.js';\nexport const value = helper();\n", "utf-8");
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("invalidates graph-scoped canonical analyses on structural edits but not on comments-only edits", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg2-cache-dir-"));
    const cacheStore = await ForgeGreenCacheStore.open(path.join(cacheDir, "fg-cache.db"));
    try {
      const impactArgs = { path: "helper.ts", limit: 50 };
      const makeProvider = (tag: string, toolName: string, args: Record<string, unknown>) =>
        new RecordingScriptedProvider("test-provider", [
          repoToolTurn(`tc-${tag}`, toolName, args),
          finalTurn(`done ${tag}`),
        ]);

      const execute = async (tag: string, toolName: string, args: Record<string, unknown>) => {
        const catalog = new InMemoryProviderCatalog();
        const provider = makeProvider(tag, toolName, args);
        catalog.register(provider);
        const runtime = createAgentRuntime({ sessionId: `fg2-${tag}`, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir, forgeGreenCacheStore: cacheStore });
        const result = await runtime.executeAgentRun({
          runId: `fg2-run-${tag}`,
          agentId: "explorer",
          role: "explorer",
          goal: `analysis ${tag}`,
          workspaceId: "ws-fg2",
          workspacePath: tmpDir,
          permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
        });
        expect(result.status).toBe("completed");
        return result;
      };

      // Run A: cold canonical cache for the graph-scoped impact analysis.
      const runA = await execute("a", "repo_impact", impactArgs);
      expect(runA.contextMetrics?.efficiencyReceipt?.canonicalCacheMisses).toBeGreaterThanOrEqual(1);

      // Run B: identical repository state → graph analysis is reused.
      const runB = await execute("b", "repo_impact", impactArgs);
      expect(runB.contextMetrics?.efficiencyReceipt?.canonicalCacheHits).toBeGreaterThanOrEqual(1);

      // Comments-only edit: content revision advances, graph revision does not, so the
      // graph-scoped analysis stays reusable while content-scoped analyses invalidate.
      await fs.writeFile(path.join(tmpDir, "index.ts"), "import { helper } from './helper.js';\nexport const value = helper();\n// a purely cosmetic trailing comment\n", "utf-8");
      const runC = await execute("c", "repo_impact", impactArgs);
      expect(runC.contextMetrics?.efficiencyReceipt?.canonicalCacheHits).toBeGreaterThanOrEqual(1);

      const runD = await execute("d", "repo_search", { query: "helper", limit: 5 });
      expect(runD.contextMetrics?.efficiencyReceipt?.canonicalCacheMisses).toBeGreaterThanOrEqual(1);

      // Structural edit (new export): the graph revision advances → impact analysis recomputes.
      await fs.writeFile(path.join(tmpDir, "helper.ts"), "export function helper(): number { return 1; }\nexport function helper2(): number { return 2; }\n", "utf-8");
      const runE = await execute("e", "repo_impact", impactArgs);
      expect(runE.contextMetrics?.efficiencyReceipt?.canonicalCacheMisses).toBeGreaterThanOrEqual(1);
    } finally {
      await cacheStore.close();
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps file-local canonical analyses reusable across unrelated edits and records repository metrics exactly once per run", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg2-cache-dir2-"));
    const cacheStore = await ForgeGreenCacheStore.open(path.join(cacheDir, "fg-cache.db"));
    try {
      const summaryArgs = { path: "helper.ts", limit: 50 };
      const makeProvider = (tag: string, toolName: string, args: Record<string, unknown>) =>
        new RecordingScriptedProvider("test-provider", [
          repoToolTurn(`tc-${tag}`, toolName, args),
          finalTurn(`done ${tag}`),
        ]);
      const execute = async (tag: string, toolName: string, args: Record<string, unknown>) => {
        const catalog = new InMemoryProviderCatalog();
        catalog.register(makeProvider(tag, toolName, args));
        const runtime = createAgentRuntime({ sessionId: `fg2b-${tag}`, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir, forgeGreenCacheStore: cacheStore });
        const result = await runtime.executeAgentRun({
          runId: `fg2b-run-${tag}`,
          agentId: "explorer",
          role: "explorer",
          goal: `analysis ${tag}`,
          workspaceId: "ws-fg2",
          workspacePath: tmpDir,
          permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
        });
        expect(result.status).toBe("completed");
        return result;
      };

      const runA = await execute("a", "repo_file_summary", summaryArgs);
      expect(runA.contextMetrics?.efficiencyReceipt?.canonicalCacheMisses).toBeGreaterThanOrEqual(1);

      // Unrelated edit to index.ts: helper.ts's content-hash-keyed summary must survive.
      await fs.writeFile(path.join(tmpDir, "index.ts"), "import { helper } from './helper.js';\nexport const value = helper();\n// unrelated trailing comment\n", "utf-8");
      const runB = await execute("b", "repo_file_summary", summaryArgs);
      expect(runB.contextMetrics?.efficiencyReceipt?.canonicalCacheHits).toBeGreaterThanOrEqual(1);
    } finally {
      await cacheStore.close();
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // Exactly-once repository metrics per run, fed into the existing ForgeGreen ledger.
    const ledgers = await persistence.getWorkItemsByKind("forgegreen_ledger");
    expect(ledgers.length).toBeGreaterThanOrEqual(2);
    const records = ledgers.map((item) => (item as unknown as { record: { identity: { runId: string }; totals: { repositoryFilesReparsed: number; repositoryFilesReused: number } } }).record);
    const firstRun = records.find((r) => r.identity.runId === "fg2b-run-a");
    const secondRun = records.find((r) => r.identity.runId === "fg2b-run-b");
    expect(firstRun).toBeDefined();
    expect(secondRun).toBeDefined();
    // Cold workspace: every file reparsed exactly once; second run after an unrelated
    // edit: exactly one file reparsed, the rest reused — never double-counted.
    expect(firstRun!.totals.repositoryFilesReparsed).toBe(2);
    expect(secondRun!.totals.repositoryFilesReparsed).toBe(1);
    expect(secondRun!.totals.repositoryFilesReused).toBe(1);
  });

  it("cannot lend repository completeness to the completion gate", async () => {
    const intel = createRepositoryIntelligence();
    await intel.openWorkspace(tmpDir);
    await intel.indexWorkspace();
    const report = await intel.getCompleteness();
    expect(report.completeness.level).toBe("COMPLETE");

    // Even with a maximally complete repository analysis, a run that verified nothing is
    // still blocked: completeness is not a gate input and never substitutes for evidence.
    const blocked = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: notRunVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockers.some((blocker) => blocker.code === "verification_not_run")).toBe(true);

    // Positive control: the gate itself is unchanged by FG-2 — real verification completes.
    const completed = evaluateCompletion({
      plan: plan([{ kind: "edit", status: "completed" }]),
      verification: passingVerification(),
      analysis: analysis(),
      review: review(),
    });
    expect(completed.outcome).toBe("completed");
    await intel.closeWorkspace();

    // The ForgeGreen ledger stays observational under repository metrics as well.
    const ledger = createForgeGreenLedgerCollector({ runId: "fg2-authority", operation: "agent_run", namespace: "ws" });
    ledger.recordRepositoryRefresh({ filesParsed: 5, filesReused: 0, parseCacheHits: 0, invalidations: 0 });
    ledger.recordRepositoryRefresh({ filesParsed: 0, filesReused: 5, parseCacheHits: 5, invalidations: 0 });
    const snapshot = ledger.snapshot();
    expect(snapshot.totals.repositoryFilesReparsed).toBe(5);
    expect(snapshot.totals.repositoryFilesReused).toBe(5);
    expect(snapshot.totals.repositoryParseCacheHits).toBe(5);
  });
});

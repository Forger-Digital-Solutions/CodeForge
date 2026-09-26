import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createDuplicateActionSupervisor } from "../src/duplicate-suppression.js";
import { createAgentRuntime } from "../src/agent-runtime.js";

const identity = (tool = "read_file", args: unknown = { path: "src/a.ts" }) => ({ tool, canonicalArguments: args });

describe("R43 suppression state evidence — supervisor semantics", () => {
  it("suppresses an identical read when state evidence matches (unchanged-file baseline)", () => {
    const supervisor = createDuplicateActionSupervisor();
    const read = { ...identity(), stateEvidence: "f:100:42", evidenceRequired: true };
    supervisor.classify(read);
    supervisor.recordReadResult(read, "file contents", true, "exec-1");
    const decision = supervisor.classify(read);
    expect(decision.action).toBe("suppress");
    if (decision.action === "suppress") {
      expect(decision.priorOutput).toBe("file contents");
      expect(decision.stateEvidence).toBe("f:100:42");
    }
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(1);
  });

  it("denies replay when the recorded state evidence changed — external mutation without a tracked write", () => {
    const supervisor = createDuplicateActionSupervisor();
    const read = { ...identity(), stateEvidence: "f:100:42", evidenceRequired: true };
    supervisor.classify(read);
    supervisor.recordReadResult(read, "stale contents", true, "exec-1");
    // The file changed outside this run's mutation tracking — new evidence, same identity.
    const mutated = { ...identity(), stateEvidence: "f:200:57", evidenceRequired: true };
    const decision = supervisor.classify(mutated);
    expect(decision.action).toBe("execute");
    expect("evidenceMismatch" in decision).toBe(true);
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(0);
    expect(supervisor.metrics.evidenceInvalidations).toBe(1);
  });

  it("denies replay when evidence is required but absent on either side", () => {
    const supervisor = createDuplicateActionSupervisor();
    const read = { ...identity(), stateEvidence: "f:100:42", evidenceRequired: true };
    supervisor.classify(read);
    supervisor.recordReadResult(read, "contents", true, "exec-1");
    // Path became unprobeable (deleted, or validation failed): evidence required but missing.
    const unprobeable = { ...identity(), evidenceRequired: true };
    const decision = supervisor.classify(unprobeable);
    expect(decision.action).toBe("execute");
    expect("evidenceMismatch" in decision).toBe(true);
    expect(supervisor.metrics.evidenceInvalidations).toBe(1);
  });

  it("never suppresses a required workspace read when no evidence was ever produced", () => {
    const supervisor = createDuplicateActionSupervisor();
    const read = { ...identity("search_files", { query: "router" }), evidenceRequired: true };
    supervisor.classify(read);
    supervisor.recordReadResult(read, "matches", true, "exec-1");
    const decision = supervisor.classify(read);
    expect(decision.action).toBe("execute");
    expect("evidenceMismatch" in decision).toBe(true);
    expect(supervisor.metrics.evidenceInvalidations).toBe(1);
  });

  it("keeps legacy suppression for unevidenced external reads — no workspace channel exists", () => {
    const supervisor = createDuplicateActionSupervisor();
    const external = { tool: "browser_inspect", canonicalArguments: { selector: "#main" }, runtimeClassifiedReadOnly: true };
    supervisor.classify(external);
    supervisor.recordReadResult(external, "dom snapshot", true, "exec-1");
    expect(supervisor.classify(external).action).toBe("suppress");
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(1);
    expect(supervisor.metrics.evidenceInvalidations).toBe(0);
  });

  it("honors a mismatch even when evidence was not required — recorded proof beats none", () => {
    const supervisor = createDuplicateActionSupervisor();
    const read = { ...identity(), stateEvidence: "f:100:42" };
    supervisor.classify(read);
    supervisor.recordReadResult(read, "contents", true, "exec-1");
    const moved = { ...identity(), stateEvidence: "f:999:10" };
    expect(supervisor.classify(moved).action).toBe("execute");
    expect(supervisor.metrics.evidenceInvalidations).toBe(1);
  });

  it("self-heals: a denied replay executes, re-records fresh evidence, and the next repeat suppresses", () => {
    const supervisor = createDuplicateActionSupervisor();
    const v1 = { ...identity(), stateEvidence: "f:100:42", evidenceRequired: true };
    supervisor.classify(v1);
    supervisor.recordReadResult(v1, "old", true, "exec-1");
    const v2 = { ...identity(), stateEvidence: "f:200:57", evidenceRequired: true };
    expect(supervisor.classify(v2).action).toBe("execute");
    supervisor.recordReadResult(v2, "new", true, "exec-2");
    const suppressed = supervisor.classify(v2);
    expect(suppressed.action).toBe("suppress");
    if (suppressed.action === "suppress") {
      expect(suppressed.priorOutput).toBe("new");
      expect(suppressed.priorExecutionId).toBe("exec-2");
    }
    expect(supervisor.metrics.duplicateActionsSuppressed).toBe(1);
    expect(supervisor.metrics.evidenceInvalidations).toBe(1);
  });

  it("does not count denied replays against the suppression budget or the no-progress bound", () => {
    const supervisor = createDuplicateActionSupervisor();
    const v1 = { ...identity(), stateEvidence: "f:1:1", evidenceRequired: true };
    supervisor.classify(v1);
    supervisor.recordReadResult(v1, "x", true, "exec-1");
    // Many denied repeats must not exhaust the once-per-state suppression slot or escalate.
    for (let index = 0; index < 5; index++) {
      const moved = { ...identity(), stateEvidence: `f:${100 + index}:42`, evidenceRequired: true };
      expect(supervisor.classify(moved).action).toBe("execute");
    }
    expect(supervisor.metrics.evidenceInvalidations).toBe(5);
    expect(supervisor.metrics.noProgressEscalations).toBe(0);
  });
});

describe("R43 suppression state evidence — runtime integration", () => {
  type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  class ScriptedProvider implements ProviderAdapter {
    readonly providerId = "test-provider";
    readonly isTestProvider = true;
    public requests: ChatRequest[] = [];
    constructor(private readonly responders: Responder[]) {}
    async listModels(): Promise<ProviderModel[]> {
      return [{ modelId: "scripted-free", displayName: "Scripted", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
    }
    async chat(): Promise<ChatResponse> { throw new Error("stream only"); }
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      this.requests.push(req);
      const responder = this.responders[Math.min(this.requests.length - 1, this.responders.length - 1)]!;
      yield* responder(req);
    }
    async healthCheck() { return { status: "available" as const }; }
  }

  const readTurn = (id: string, filePath: string): Responder =>
    async function* () {
      yield { type: "tool_call_started", toolCallId: id, toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: id, toolName: "read_file", arguments: JSON.stringify({ path: filePath }) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", finishReason: "tool_calls" };
    };
  const finalTurn = (text: string): Responder =>
    async function* () {
      yield { type: "text_delta", delta: text };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", finishReason: "stop" };
    };

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "r43-evidence-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
    await fsp.writeFile(path.join(tmpDir, "index.ts"), "export const v = 1;\n", "utf-8");
  });

  afterEach(async () => {
    persistence.close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("suppresses a repeated read against unchanged state and records the state evidence that authorized it", async () => {
    const provider = new ScriptedProvider([
      readTurn("tc-1", "index.ts"),
      readTurn("tc-2", "index.ts"),
      finalTurn("done"),
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "r43-ev", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    const result = await runtime.executeAgentRun({
      runId: "r43-ev-1", agentId: "explorer", role: "explorer", goal: "read twice",
      workspaceId: "ws", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(result.status).toBe("completed");
    expect(result.toolExecutions).toHaveLength(1);
    expect(result.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed).toBe(1);
    expect(result.contextMetrics?.efficiencyReceipt?.suppressionEvidenceInvalidations).toBeUndefined();
  });

  it("executes the repeat when the file changed externally between calls — no stale replay", async () => {
    const target = path.join(tmpDir, "index.ts");
    const mutatedRead: Responder = async function* () {
      // An external writer (user edit, sibling workstream) changes the file between the first
      // read and this re-request — the run's own mutation counter never moved.
      await fsp.writeFile(target, "export const v = 2;\n", "utf-8");
      fs.utimesSync(target, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
      yield { type: "tool_call_started", toolCallId: "tc-2", toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: "tc-2", toolName: "read_file", arguments: JSON.stringify({ path: "index.ts" }) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", finishReason: "tool_calls" };
    };
    const listTurn: Responder = async function* () {
      yield { type: "tool_call_started", toolCallId: "tc-3", toolName: "list_files" };
      yield { type: "tool_call_completed", toolCallId: "tc-3", toolName: "list_files", arguments: JSON.stringify({ path: "." }) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", finishReason: "tool_calls" };
    };
    const provider = new ScriptedProvider([
      readTurn("tc-1", "index.ts"),
      mutatedRead,
      listTurn,
      readTurn("tc-4", "index.ts"),
      finalTurn("done"),
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "r43-ev-mut", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
    const result = await runtime.executeAgentRun({
      runId: "r43-ev-2", agentId: "explorer", role: "explorer", goal: "read, mutate externally, read, list, read",
      workspaceId: "ws", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    });
    expect(result.status).toBe("completed");
    // The post-mutation read executed physically (replay denied); the later repeat — separated
    // by a different tool call so the certified three-identical-call loop shape does not
    // apply — suppressed against the freshly recorded evidence.
    expect(result.toolExecutions).toHaveLength(3);
    expect(result.contextMetrics?.efficiencyReceipt?.suppressionEvidenceInvalidations).toBe(1);
    expect(result.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed).toBe(1);
    const finalToolMessages = provider.requests[4]!.messages.filter((m) => m.role === "tool");
    expect(finalToolMessages.some((m) => m.content.includes("duplicate read-only action suppressed"))).toBe(true);
  });
});

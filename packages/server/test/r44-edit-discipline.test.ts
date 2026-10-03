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
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { ERROR_CODES } from "@codeforge/agent";

class DeterministicScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];
  private responses: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>;
  private callCount = 0;

  constructor(providerId: string, responses: Array<(req: ChatRequest) => AsyncIterable<StreamEvent>>) {
    this.providerId = providerId;
    this.responses = responses;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: "scripted-free",
      displayName: "Scripted Free Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const handler = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    if (!handler) {
      yield { type: "text_delta", delta: "Default response" };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    for await (const ev of handler(req)) {
      if (signal?.aborted) return;
      yield ev;
    }
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const CODER_PERMISSIONS = { read: true, search: true, write: true, executeCommand: true, network: false };

function toolCall(id: string, name: string, args: Record<string, unknown>): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: name };
    yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: { inputTokens: 40, outputTokens: 15 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}

function textTurn(text: string): (req: ChatRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { inputTokens: 60, outputTokens: 20 } };
    yield { type: "finish", finishReason: "stop" };
  };
}

describe("R44 — edit discipline gate and first-edit telemetry", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-r44-edit-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function runtimeFor(provider: ProviderAdapter) {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    return createAgentRuntime({ sessionId: "test-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });
  }

  it("denies a blind edit_file on an existing file, then accepts the read+hashed retry", async () => {
    await fs.writeFile(path.join(tmpDir, "calc.ts"), "export function add(a: number, b: number) { return a - b; }", "utf-8");

    const provider = new DeterministicScriptedProvider("test-provider", [
      toolCall("tc-blind", "edit_file", { path: "calc.ts", oldText: "return a - b;", newText: "return a + b;" }),
      toolCall("tc-read", "read_file", { path: "calc.ts" }),
      toolCall("tc-edit", "edit_file", { path: "calc.ts", oldText: "return a - b;", newText: "return a + b;" }),
      textTurn("Fixed the add function."),
    ]);

    const result = await runtimeFor(provider).executeAgentRun({
      runId: "run-blind-edit", agentId: "coder", role: "coder", goal: "Fix add()", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: CODER_PERMISSIONS,
    });

    expect(result.status).toBe("completed");
    const denied = result.toolExecutions.find((exec) => exec.toolExecutionId.startsWith("denied-"));
    expect(denied).toBeDefined();
    expect(denied!.error).toBe(ERROR_CODES.EDIT_MISSING_STATE);
    expect(denied!.output).toContain("read_file");

    const attempts = result.contextMetrics?.editAttempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ tool: "edit_file", priorObservation: "none", outcome: "denied", failureClass: "missing_state" });
    expect(attempts[1]).toMatchObject({ priorObservation: "read", outcome: "success" });
    // The retried edit omitted expectedHash; the runtime attached the observed hash for free.
    expect(attempts[1]!.hashAutoAttached).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "calc.ts"), "utf-8")).toContain("return a + b;");
  });

  it("attaches the observed hash to a model edit and fails closed when the file drifts", async () => {
    const file = path.join(tmpDir, "state.ts");
    await fs.writeFile(file, "export const mode = 'a';", "utf-8");

    const provider = new DeterministicScriptedProvider("test-provider", [
      toolCall("tc-read", "read_file", { path: "state.ts" }),
      async function* () {
        // External sibling mutation between the read and the edit.
        await fs.writeFile(file, "export const mode = 'externally-changed';", "utf-8");
        yield { type: "tool_call_started", toolCallId: "tc-edit", toolName: "edit_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-edit", toolName: "edit_file", arguments: JSON.stringify({ path: "state.ts", oldText: "'a'", newText: "'b'" }) };
        yield { type: "finish", finishReason: "tool_calls" };
      },
      textTurn("The edit was rejected as stale."),
    ]);

    const result = await runtimeFor(provider).executeAgentRun({
      runId: "run-drift-edit", agentId: "coder", role: "coder", goal: "Flip mode", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: CODER_PERMISSIONS,
    });

    const attempts = result.contextMetrics?.editAttempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "failed", failureClass: "stale_hash", errorCode: ERROR_CODES.CONTEXT_EVIDENCE_STALE, hashAutoAttached: true });
    expect(await fs.readFile(file, "utf-8")).toBe("export const mode = 'externally-changed';");
  });

  it("allows write_file to create a new file but denies a blind overwrite of an existing one", async () => {
    await fs.writeFile(path.join(tmpDir, "existing.ts"), "export const keep = 1;", "utf-8");

    const provider = new DeterministicScriptedProvider("test-provider", [
      toolCall("tc-create", "write_file", { path: "fresh.ts", content: "export const made = true;" }),
      toolCall("tc-blind-write", "write_file", { path: "existing.ts", content: "export const keep = 2;" }),
      toolCall("tc-read", "read_file", { path: "existing.ts" }),
      toolCall("tc-write", "write_file", { path: "existing.ts", content: "export const keep = 2;" }),
      textTurn("Done."),
    ]);

    const result = await runtimeFor(provider).executeAgentRun({
      runId: "run-write-gate", agentId: "coder", role: "coder", goal: "Update files", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: CODER_PERMISSIONS,
    });

    const attempts = result.contextMetrics?.editAttempts ?? [];
    expect(attempts).toHaveLength(3);
    // New-file create: never gated.
    expect(attempts[0]).toMatchObject({ tool: "write_file", path: "fresh.ts", outcome: "success", priorObservation: "none" });
    // Blind overwrite of existing file: denied.
    expect(attempts[1]).toMatchObject({ tool: "write_file", path: "existing.ts", outcome: "denied", failureClass: "missing_state" });
    // After observing: write proceeds (hash verified current at dispatch).
    expect(attempts[2]).toMatchObject({ tool: "write_file", path: "existing.ts", outcome: "success", priorObservation: "read" });
    expect(await fs.readFile(path.join(tmpDir, "existing.ts"), "utf-8")).toBe("export const keep = 2;");
  });

  it("denies a write_file overwrite when the file drifted since this run's observation", async () => {
    const file = path.join(tmpDir, "drift.ts");
    await fs.writeFile(file, "v1", "utf-8");

    const provider = new DeterministicScriptedProvider("test-provider", [
      toolCall("tc-read", "read_file", { path: "drift.ts" }),
      async function* () {
        await fs.writeFile(file, "v2-external", "utf-8");
        yield { type: "tool_call_started", toolCallId: "tc-write", toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-write", toolName: "write_file", arguments: JSON.stringify({ path: "drift.ts", content: "v3" }) };
        yield { type: "finish", finishReason: "tool_calls" };
      },
      textTurn("Write rejected."),
    ]);

    const result = await runtimeFor(provider).executeAgentRun({
      runId: "run-drift-write", agentId: "coder", role: "coder", goal: "Update drift.ts", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: CODER_PERMISSIONS,
    });

    const attempts = result.contextMetrics?.editAttempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ tool: "write_file", outcome: "denied", failureClass: "stale_hash", errorCode: ERROR_CODES.CONTEXT_EVIDENCE_STALE });
    expect(await fs.readFile(file, "utf-8")).toBe("v2-external");
  });
});

describe("R44 — structured-output telemetry", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-r44-so-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records the repair strategy when prose-wrapped fenced JSON validates", async () => {
    const provider = new DeterministicScriptedProvider("test-provider", [
      async function* () {
        yield { type: "text_delta", delta: 'Here is the review.\n```json\n{"verdict":"pass","findings":[],"summary":"Looks good"}\n```\nEnd.' };
        yield { type: "finish", finishReason: "stop" };
      },
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "test-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });

    const result = await runtime.executeAgentRun({
      runId: "run-fenced-review", agentId: "reviewer", role: "reviewer", goal: "Review", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
    });

    expect(result.status).toBe("completed");
    const so = result.contextMetrics?.structuredOutput;
    expect(so).toBeDefined();
    expect(so!.repairs).toBe(0);
    expect(so!.repairStrategies).toEqual(["fenced_block"]);
    expect(so!.exhausted).toBe(false);
  });

  it("counts rejections and records exhaustion when the repair budget runs out", async () => {
    const provider = new DeterministicScriptedProvider("test-provider", [
      async function* () {
        yield { type: "text_delta", delta: "this is not json at all" };
        yield { type: "finish", finishReason: "stop" };
      },
      async function* () {
        yield { type: "text_delta", delta: "still not json" };
        yield { type: "finish", finishReason: "stop" };
      },
    ]);
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: "test-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });

    const result = await runtime.executeAgentRun({
      runId: "run-bad-review", agentId: "reviewer", role: "reviewer", goal: "Review", workspaceId: "ws-1", workspacePath: tmpDir,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "reviewer",
      roleRouting: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.error).toBe(ERROR_CODES.AGENT_INVALID_STRUCTURED_OUTPUT);
    expect(result.route).toEqual({ providerId: "test-provider", modelId: "free-model-1" });
    const so = result.contextMetrics?.structuredOutput;
    expect(so).toBeDefined();
    expect(so!.repairs).toBe(1);
    expect(so!.rejections.length).toBe(2);
    expect(so!.exhausted).toBe(true);

    // R44 regression: a structured-output exhaustion must journal converged_failed — before the
    // stopReason fix the durable record claimed "completed" and misled recovery classification.
    const journals = (await persistence.getWorkItems("test-session")).filter((i) => (i as unknown as { kind: string }).kind === "agent_run_journal");
    expect(journals.length).toBe(1);
    expect((journals[0] as unknown as { state: string }).state).toBe("converged_failed");
  });
});

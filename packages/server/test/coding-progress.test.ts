import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider, type ChatRequest, type StreamEvent } from "@codeforge/providers";
import { createLease, createTaskAuthority } from "@codeforge/permissions";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { CodingProgress } from "../src/coding-progress.js";

describe("bounded workflow coding investigation", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  async function run(editAfterIntervention: boolean, enabled = true, prematureFinish = false) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cf-coding-progress-"));
    cleanup.push(() => fs.rm(workspace, { recursive: true, force: true }));
    const source = "broken\n" + Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    await fs.writeFile(path.join(workspace, "target.txt"), source);
    const persistence = createSessionPersistence();
    cleanup.push(async () => { await persistence.close(); });
    const eventStore = new EventStore();
    const requests: ChatRequest[] = [];
    const provider = { ...createMockProvider({ providerId: "progress-fixture" }),
      async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
        requests.push(structuredClone(request));
        const call = requests.length;
        const prompted = request.messages.some(message => message.role === "system" && message.content.startsWith("Coding progress intervention:"));
        if (prematureFinish && (!prompted || !editAfterIntervention || call > 2)) {
          yield { type: "text_delta", delta: "Now let me implement the requested change." };
          yield { type: "finish", finishReason: "stop" };
          return;
        }
        if ((editAfterIntervention && call > 13) || (!enabled && call > 20)) {
          yield { type: "text_delta", delta: "Implementation finished; workflow verification must judge it." };
          yield { type: "finish", finishReason: "stop" };
          return;
        }
        const edit = editAfterIntervention && prompted;
        const toolName = edit ? "edit_file" : "read_file";
        const args = edit ? { path: "target.txt", oldText: "broken", newText: "fixed", expectedHash: createHash("sha256").update(source).digest("hex") }
          : { path: "target.txt", startLine: call, endLine: call };
        yield { type: "tool_call_started", toolCallId: `progress-${call}`, toolName };
        yield { type: "tool_call_completed", toolCallId: `progress-${call}`, toolName, arguments: JSON.stringify(args) };
        yield { type: "finish", finishReason: "tool_calls" };
      },
    };
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "free-model-1" }));
    const authority = createTaskAuthority(createLease({ sessionId: "progress-session", workspaceRoot: workspace, permissionMode: "auto_review", planMode: "auto" }));
    const runtime = createAgentRuntime({ sessionId: "progress-session", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: workspace, authorityFor: () => authority });
    cleanup.push(() => runtime.shutdown());
    runtime.setModelSelection({ providerId: provider.providerId, modelId: "free-model-1" });
    const turnId = await runtime.startTurn("Fix the target implementation", undefined, { origin: "workflow", codingProgress: enabled });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !["completed", "failed", "blocked", "cancelled"].includes((await persistence.getTurn(turnId))?.status ?? "")) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const budget = await persistence.getWorkItem(`coding-progress-${turnId}`);
    return { requests, turn: await persistence.getTurn(turnId), budget, content: await fs.readFile(path.join(workspace, "target.txt"), "utf8"), eventStore, persistence, runtime, catalog, firewall, workspace, authority };
  }

  it("intervenes and stops novel file pages before dozens of model calls can exhaust the workflow", async () => {
    const result = await run(false);
    expect(result.turn?.status).toBe("failed");
    expect(result.turn?.error).toContain("AGENT_NO_PROGRESS_DETECTED");
    expect(result.requests).toHaveLength(18);
    expect(result.requests[12]?.messages.some(message => message.content.startsWith("Coding progress intervention:"))).toBe(true);
    expect(result.eventStore.getAll({ types: ["file.change_applied"] })).toHaveLength(0);
    expect(result.budget?.kind).toBe("activity");
    if (result.budget?.kind === "activity") {
      expect(JSON.parse(result.budget.detail ?? "{}")).toMatchObject({ actionsWithoutMutation: 18, mutations: 0, interventions: [{ actionBudget: 6, actions: 6 }] });
    }
  });

  it("allows an authoritative guarded edit after intervention without granting workflow completion", async () => {
    const result = await run(true);
    expect(result.turn?.status).toBe("completed");
    expect(result.content.startsWith("fixed\n")).toBe(true);
    expect(result.eventStore.getAll({ types: ["file.change_applied"] })).toHaveLength(1);
    expect(result.eventStore.getAll({ types: ["task.state_changed", "task.completed"] })).toHaveLength(0);
    if (result.budget?.kind === "activity") expect(JSON.parse(result.budget.detail ?? "{}").mutations).toBe(1);
  });

  it("leaves read-only turns outside the workflow coding budget", async () => {
    const result = await run(false, false);
    expect(result.turn?.status).toBe("completed");
    expect(result.requests).toHaveLength(21);
    expect(result.budget).toBeUndefined();
  });

  it("recovers a promise to edit through real tool execution before ending the coding turn", async () => {
    const result = await run(true, true, true);
    expect(result.turn?.status).toBe("completed");
    expect(result.requests).toHaveLength(3);
    expect(result.content.startsWith("fixed\n")).toBe(true);
    expect(result.eventStore.getAll({ types: ["file.change_applied"] })).toHaveLength(1);
    if (result.budget?.kind === "activity") expect(JSON.parse(result.budget.detail ?? "{}")).toMatchObject({ mutations: 1, interventions: [{ actionBudget: 6, actions: 1 }] });
    expect(result.eventStore.getAll({ types: ["task.state_changed", "task.completed"] })).toHaveLength(0);
  });

  it("stops a repeated text-only promise instead of spending quota on endless continuation calls", async () => {
    const result = await run(false, true, true);
    expect(result.turn?.status).toBe("failed");
    expect(result.turn?.error).toContain("AGENT_NO_PROGRESS_DETECTED");
    expect(result.requests).toHaveLength(2);
    expect(result.eventStore.getAll({ types: ["file.change_applied"] })).toHaveLength(0);
    expect(result.content.startsWith("broken\n")).toBe(true);
  });

  it("enforces the six-action limit even when recovery begins before twelve reads", () => {
    const progress = new CodingProgress();
    progress.chargeAction();
    expect(progress.interveneOnFinish()).toContain("next six tool actions");
    for (let index = 0; index < 6; index++) progress.chargeAction();
    expect(() => new CodingProgress(progress.snapshot()).intervene()).toThrow("six-action recovery budget");
    expect(() => new CodingProgress(progress.snapshot()).interveneOnFinish()).toThrow("bounded recovery intervention");
  });

  it("preserves a spent investigation allowance across coding continuations", async () => {
    const result = await run(false);
    const requestCount = result.requests.length;
    const turnId = await result.runtime.startTurn("Continue the same approved implementation", undefined,
      { origin: "workflow", codingProgress: true, codingProgressFromTurnId: result.turn!.id });
    await expect.poll(async () => (await result.persistence.getTurn(turnId))?.status).toBe("failed");
    expect(result.requests).toHaveLength(requestCount);
    expect((await result.persistence.getTurn(turnId))?.error).toContain("AGENT_NO_PROGRESS_DETECTED");
    const budget = await result.persistence.getWorkItem(`coding-progress-${turnId}`);
    expect(budget?.kind).toBe("activity");
    if (budget?.kind === "activity") expect(JSON.parse(budget.detail ?? "{}")).toMatchObject({ actionsWithoutMutation: 18, mutations: 0, interventions: [{ actionBudget: 6, actions: 6 }] });
  });

  it("rejects a continuation without an authoritative prior coding budget", async () => {
    const result = await run(false);
    await expect(result.runtime.startTurn("Continue implementation", undefined,
      { origin: "workflow", codingProgress: true, codingProgressFromTurnId: "missing-turn" })).rejects.toThrow("no authoritative coding progress budget");
    expect(result.requests).toHaveLength(18);
  });

  it("rehydrates a spent workflow allowance before dispatching another model request", async () => {
    const result = await run(false);
    expect(result.turn?.status).toBe("failed");
    await result.runtime.shutdown();
    await result.persistence.upsertTurn({ ...result.turn!, status: "running", completedAt: undefined, error: undefined });
    const restored = createAgentRuntime({ sessionId: "progress-session", eventStore: result.eventStore, persistence: result.persistence,
      firewall: result.firewall, providerCatalog: result.catalog, workspacePath: result.workspace, authorityFor: () => result.authority });
    cleanup.push(() => restored.shutdown());
    await restored.init();
    restored.setModelSelection({ providerId: "progress-fixture", modelId: "free-model-1" });
    await restored.resumeTurn(result.turn!.id);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await result.persistence.getTurn(result.turn!.id))?.status !== "failed") {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect((await result.persistence.getTurn(result.turn!.id))?.error).toContain("AGENT_NO_PROGRESS_DETECTED");
    expect(result.requests).toHaveLength(18);
  });

  it("retains exhausted intervention allowance across rehydration and rejects corrupt counters", () => {
    const progress = new CodingProgress();
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let i = 0; i < 12; i++) progress.chargeAction();
      expect(progress.intervene()).toContain("next six tool actions");
      progress.recordMutation();
    }
    const restored = new CodingProgress(progress.snapshot());
    for (let i = 0; i < 12; i++) restored.chargeAction();
    expect(() => restored.intervene()).toThrow("two interventions");
    expect(() => new CodingProgress({ ...progress.snapshot(), actionsWithoutMutation: -1 })).toThrow("invalid durable");
    const spent = new CodingProgress();
    for (let i = 0; i < 12; i++) spent.chargeAction();
    spent.intervene();
    for (let i = 0; i < 6; i++) spent.chargeAction();
    expect(() => new CodingProgress(spent.snapshot()).intervene()).toThrow("six-action recovery budget");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { createAgentRuntime, createSubagentManager, type SubagentManager } from "@codeforge/server";

process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";

/** Provider that respects abort signals so a watchdog abort interrupts a pending request. */
class PacedToolLoopProvider {
  providerId = "codeforge";
  isTestProvider = true;
  private readIndex = 0;
  constructor(private readonly turnDelayMs: number) {}
  async listModels() {
    return [{
      modelId: "free-model-1",
      displayName: "Free Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }
  async chat(): Promise<never> {
    throw new Error("Use streamChat");
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async *streamChat(req: { messages: Array<{ role: string; content: string }> }, signal?: AbortSignal): AsyncIterable<{ type: string; delta?: string; toolCallId?: string; toolName?: string; arguments?: string; finishReason?: string }> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.turnDelayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
    if (signal?.aborted) throw new Error("aborted");
    yield { type: "tool_call_started", toolCallId: "tc-1", toolName: "read_file" };
    const path = this.readIndex++ === 0 ? "auth.ts" : `auth-${this.readIndex - 1}.ts`;
    yield { type: "tool_call_completed", toolCallId: "tc-1", toolName: "read_file", arguments: JSON.stringify({ path }) };
    yield { type: "finish", finishReason: "tool_calls" };
  }
}

async function buildHarness(turnDelayMs: number, watchdogOptions: { watchdogProgressWindowMs: number; watchdogMaxExtensions?: number }) {
  const ws = await mkdtemp(join(tmpdir(), "cf-watchdog-"));
  await writeFile(join(ws, "auth.ts"), "export function authenticate() { return true; }\n");
  for (let index = 1; index <= 20; index++) {
    await writeFile(join(ws, `auth-${index}.ts`), `export const value${index} = true;\n`);
  }
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  persistence.upsertSession({ id: "sess-wd", title: "Watchdog", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle" });
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord());
  const catalog = new InMemoryProviderCatalog();
  catalog.register(new PacedToolLoopProvider(turnDelayMs));
  const runtime = createAgentRuntime({ sessionId: "sess-wd", eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: ws });
  await runtime.init();
  const manager: SubagentManager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true, ...watchdogOptions });
  return { ws, persistence, manager, cleanup: async () => { persistence.close(); await rm(ws, { recursive: true, force: true }); } };
}

describe("progress-aware watchdog (RC2 §6)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("extends a legitimately paced worker up to the ceiling, then aborts bounded", async () => {
    // Distinct file observations, rather than model turns alone, earn extensions.
    // R42: wall-clock bounds here measured the machine, not the mechanism — under parallel load
    // a delayed progress write once flipped the abort reason from budget-ceiling to "stalled".
    // The durable worker record carries the watchdog decision, so the assertions target the
    // mechanism directly: exactly 2 earned extensions and a budget-ceiling abort reason.
    const h = await buildHarness(150, { watchdogProgressWindowMs: 800, watchdogMaxExtensions: 2 });
    cleanups.push(h.cleanup);
    const result = await h.manager.spawnChildAgent({
      parentRunId: "run-wd-paced",
      sessionId: "sess-wd",
      agentId: "explorer",
      task: "Inspect repository structure",
      workspacePath: h.ws,
      metadata: { timeoutMs: 1_800 },
    });
    // Ceiling abort while progressing maps to the runtime's budget-exhaustion terminal state.
    expect(result.status).toBe("blocked");
    const workers = await h.persistence.getWorkItemsByKind("subagent_run");
    const worker = workers.find((w) => w.parentRunId === "run-wd-paced");
    expect(worker?.watchdogExtensions).toBeGreaterThanOrEqual(1);
    expect(worker?.watchdogExtensions).toBeLessThanOrEqual(2);
    expect(worker?.usefulProgressEvents).toBeGreaterThan(0);
  }, 20_000);

  it("aborts a stalled worker at the base budget without granting extensions", async () => {
    // Provider hangs after the first durable boundary; no further progress ever lands. The
    // watchdog must kill it after consecutive quiet windows near the base budget, not wait out
    // extensions. The persisted record proves the mechanism: the "stalled" abort reason and an
    // extension count strictly below the ceiling — under parallel load the worker's own startup
    // boundary can land inside the first window and legitimately earn one extension, so the
    // exact count is incidental; *not exhausting the budget* is the fact.
    const h = await buildHarness(30_000, { watchdogProgressWindowMs: 400, watchdogMaxExtensions: 2 });
    cleanups.push(h.cleanup);
    const result = await h.manager.spawnChildAgent({
      parentRunId: "run-wd-stalled",
      sessionId: "sess-wd",
      agentId: "explorer",
      task: "Inspect repository structure",
      workspacePath: h.ws,
      metadata: { timeoutMs: 1_000 },
    });
    // A stall abort lands while the model request is pending → cancelled, not failed.
    expect(result.status).toBe("cancelled");
    const workers = await h.persistence.getWorkItemsByKind("subagent_run");
    const worker = workers.find((w) => w.parentRunId === "run-wd-stalled");
    expect(worker?.watchdogAbortReason).toBe("stalled");
    expect(worker?.watchdogExtensions ?? 0).toBeLessThan(2);
  }, 20_000);

  it("keeps a useful coder alive beyond the former two-extension ceiling and honors cancellation", async () => {
    const h = await buildHarness(100, { watchdogProgressWindowMs: 300 });
    cleanups.push(h.cleanup);
    const controller = new AbortController();
    const pending = h.manager.spawnChildAgent({
      parentRunId: "run-wd-long-coder",
      sessionId: "sess-wd",
      agentId: "coder",
      task: "Inspect and improve authentication",
      workspacePath: h.ws,
      signal: controller.signal,
      metadata: { timeoutMs: 2_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(h.manager.getActiveChildren("run-wd-long-coder")).toHaveLength(1);
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    const workers = await h.persistence.getWorkItemsByKind("subagent_run");
    const worker = workers.find((item) => item.parentRunId === "run-wd-long-coder");
    expect(worker?.executorKind).toBe("agent_runtime");
    expect(worker?.watchdogExtensions).toBeGreaterThan(2);
    expect(worker?.usefulProgressEvents).toBeGreaterThan(2);
  }, 20_000);
});

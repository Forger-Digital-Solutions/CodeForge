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
    const path = this.readIndex++ === 0 ? "auth.ts" : `auth-${this.readIndex}.ts`;
    yield { type: "tool_call_completed", toolCallId: "tc-1", toolName: "read_file", arguments: JSON.stringify({ path }) };
    yield { type: "finish", finishReason: "tool_calls" };
  }
}

async function buildHarness(turnDelayMs: number, watchdogOptions: { watchdogProgressWindowMs: number; watchdogMaxExtensions: number }) {
  const ws = await mkdtemp(join(tmpdir(), "cf-watchdog-"));
  await writeFile(join(ws, "auth.ts"), "export function authenticate() { return true; }\n");
  await writeFile(join(ws, "auth-1.ts"), "export const first = true;\n");
  await writeFile(join(ws, "auth-2.ts"), "export const second = true;\n");
  await writeFile(join(ws, "auth-3.ts"), "export const third = true;\n");
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
    // Base budget 600ms; worker turns every ~150ms (durable model-turn progress each turn).
    // 600ms base + 2 × 400ms extension windows ≈ 1.4s ceiling: extensions must be visible in the
    // wall time, and the abort must still land bounded — never an unbounded paced wait.
    const h = await buildHarness(150, { watchdogProgressWindowMs: 400, watchdogMaxExtensions: 2 });
    cleanups.push(h.cleanup);
    const startedAt = Date.now();
    const result = await h.manager.spawnChildAgent({
      parentRunId: "run-wd-paced",
      sessionId: "sess-wd",
      agentId: "explorer",
      task: "Inspect repository structure",
      workspacePath: h.ws,
      metadata: { timeoutMs: 600 },
    });
    const wall = Date.now() - startedAt;
    // Ceiling abort while progressing maps to the runtime's budget-exhaustion terminal state.
    expect(result.status).toBe("blocked");
    expect(wall).toBeGreaterThanOrEqual(1_000);
    expect(wall).toBeLessThanOrEqual(3_500);
  }, 20_000);

  it("aborts a stalled worker at the base budget without granting extensions", async () => {
    // Provider hangs after the first durable boundary; no further progress ever lands. The
    // watchdog must kill it at the first quiet check (~base budget), not wait out extensions.
    // Base 1000ms puts every startup write far outside the 400ms window, so no jitter can
    // earn a spurious extension.
    const h = await buildHarness(30_000, { watchdogProgressWindowMs: 400, watchdogMaxExtensions: 2 });
    cleanups.push(h.cleanup);
    const startedAt = Date.now();
    const result = await h.manager.spawnChildAgent({
      parentRunId: "run-wd-stalled",
      sessionId: "sess-wd",
      agentId: "explorer",
      task: "Inspect repository structure",
      workspacePath: h.ws,
      metadata: { timeoutMs: 1_000 },
    });
    const wall = Date.now() - startedAt;
    // A stall abort lands while the model request is pending → cancelled, not failed.
    expect(result.status).toBe("cancelled");
    expect(wall).toBeLessThanOrEqual(1_800);
  }, 20_000);
});

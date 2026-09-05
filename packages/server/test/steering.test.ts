import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createDevelopmentEntitlementProvider, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";

async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

describe("Agent Steering Safety & Turn Concurrency (CF-06)", () => {
  let ws: string;
  let server: any;
  let port: number;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-steer-test-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    firewall = new ForgeZero({ entitlementProvider: createDevelopmentEntitlementProvider() });
    firewall.register(createGenericFreeRecord());
    catalog = new InMemoryProviderCatalog();
  });

  afterEach(async () => {
    if (server) await server.stop();
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  it("enforces single active mutable turn per session (rejects concurrent startTurn)", async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((res) => { release = res; });

    catalog.register({
      providerId: "codeforge",
      displayName: "Mock Provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: () => (async function* () {
        yield { type: "text_delta", delta: "Working..." };
        await blocker;
        yield { type: "finish", finishReason: "stop" as const };
      })(),
    } as any);

    const runtime = createAgentRuntime({
      sessionId: "sess-concurrency",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });

    const turn1 = await runtime.startTurn("First long task");
    expect(turn1).toBeDefined();

    // Attempting a second startTurn on the same session MUST fail
    await expect(runtime.startTurn("Second competing task")).rejects.toThrow(
      /already active in session sess-concurrency/,
    );

    release();
  });

  it("injects steering constraint into model message history at safe iteration boundary", async () => {
    const recordedRequests: any[] = [];
    catalog.register({
      providerId: "codeforge",
      displayName: "Mock Provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: (req: any) => {
        recordedRequests.push(JSON.parse(JSON.stringify(req)));
        return (async function* () {
          if (recordedRequests.length === 1) {
            // First step: make a tool call
            yield { type: "tool_call_started", toolCallId: "tc-1", toolName: "read_file" };
            yield { type: "tool_call_delta", toolCallId: "tc-1", delta: JSON.stringify({ path: "src/calc.ts" }) };
            yield { type: "tool_call_completed", toolCallId: "tc-1", toolName: "read_file", arguments: JSON.stringify({ path: "src/calc.ts" }) };
            yield { type: "finish", finishReason: "tool_calls" as const };
          } else {
            // Second step after tool: finish
            yield { type: "text_delta", delta: "Done obeying steering constraint" };
            yield { type: "finish", finishReason: "stop" as const };
          }
        })();
      },
    } as any);

    const runtime = createAgentRuntime({
      sessionId: "sess-steer-boundary",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });

    // Start turn
    const turnId = await runtime.startTurn("Fix calculate function");

    // Steer active turn while it is in tool loop
    await runtime.steerTurn(turnId, "Do NOT modify the public export signature");

    // Wait for turn to complete
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const state = runtime.getTurn(turnId);
      if (state?.status === "completed" || state?.status === "failed") break;
    }

    expect(runtime.getTurn(turnId)?.status).toBe("completed");

    // Verify that the second model inference request contained the steering instruction
    expect(recordedRequests.length).toBeGreaterThanOrEqual(2);
    const secondReqMessages = recordedRequests[1].messages;
    const steeringMessage = secondReqMessages.find(
      (m: any) => m.role === "user" && m.content.includes("Do NOT modify the public export signature"),
    );

    expect(steeringMessage).toBeDefined();
    expect(steeringMessage.content).toContain("[User Steering Instruction]: Do NOT modify the public export signature");
  });

  it("preserves order when multiple steering messages are queued", async () => {
    const recordedRequests: any[] = [];
    catalog.register({
      providerId: "codeforge",
      displayName: "Mock Provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: (req: any) => {
        recordedRequests.push(JSON.parse(JSON.stringify(req)));
        return (async function* () {
          if (recordedRequests.length === 1) {
            yield { type: "tool_call_started", toolCallId: "tc-1", toolName: "read_file" };
            yield { type: "tool_call_completed", toolCallId: "tc-1", toolName: "read_file", arguments: "{}" };
            yield { type: "finish", finishReason: "tool_calls" as const };
          } else {
            yield { type: "text_delta", delta: "Final response" };
            yield { type: "finish", finishReason: "stop" as const };
          }
        })();
      },
    } as any);

    const runtime = createAgentRuntime({
      sessionId: "sess-steer-order",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });

    const turnId = await runtime.startTurn("Initial task");
    await runtime.steerTurn(turnId, "Constraint 1: keep backward compatibility");
    await runtime.steerTurn(turnId, "Constraint 2: add JSDoc comments");

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const state = runtime.getTurn(turnId);
      if (state?.status === "completed" || state?.status === "failed") break;
    }

    expect(runtime.getTurn(turnId)?.status).toBe("completed");

    const secondReqMessages = recordedRequests[1].messages;
    const steering1Idx = secondReqMessages.findIndex((m: any) => m.content?.includes("Constraint 1"));
    const steering2Idx = secondReqMessages.findIndex((m: any) => m.content?.includes("Constraint 2"));

    expect(steering1Idx).toBeGreaterThan(-1);
    expect(steering2Idx).toBeGreaterThan(-1);
    expect(steering1Idx).toBeLessThan(steering2Idx);
  });

  it("cannot steer a completed or cancelled turn", async () => {
    catalog.register(
      createMockProvider({
        providerId: "codeforge",
        streamEvents: [
          [{ type: "text_delta", delta: "Quick answer" }, { type: "finish", finishReason: "stop" }],
        ],
      }) as any,
    );

    const runtime = createAgentRuntime({
      sessionId: "sess-steer-terminal",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: ws,
    });

    const turnId = await runtime.startTurn("Short task");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (runtime.getTurn(turnId)?.status === "completed") break;
    }

    expect(runtime.getTurn(turnId)?.status).toBe("completed");

    // Steer on completed turn MUST reject
    await expect(runtime.steerTurn(turnId, "Late steer")).rejects.toThrow(
      /Cannot steer turn .* in terminal state completed/,
    );
  });

  it("HTTP API: /api/send with steer: true steers active turn and rejects concurrent start", async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((res) => { release = res; });

    catalog.register({
      providerId: "codeforge",
      displayName: "Mock Provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: () => (async function* () {
        yield { type: "text_delta", delta: "Waiting..." };
        await blocker;
        yield { type: "finish", finishReason: "stop" as const };
      })(),
    } as any);

    server = createServer({
      port: 0,
      dbPath: ":memory:",
      providerCatalog: catalog,
      useRealRuntime: true,
    } as any);
    await server.start();
    port = server.httpPort;

    // Start first turn
    const send1 = await fetchJson(`http://localhost:${port}/api/send`, {
      sessionId: "http-steer-sess",
      message: "First long turn",
    });
    expect(send1.status).toBe(200);
    expect(send1.body.ok).toBe(true);
    const turn1Id = send1.body.turnId;

    // Attempting a second send without steer MUST return 409 CONCURRENT_TURN_REJECTED
    const send2 = await fetchJson(`http://localhost:${port}/api/send`, {
      sessionId: "http-steer-sess",
      message: "Second competing turn",
    });
    expect(send2.status).toBe(409);
    expect(send2.body.error).toBe("CONCURRENT_TURN_REJECTED");

    // Sending with steer: true MUST succeed
    const steerRes = await fetchJson(`http://localhost:${port}/api/send`, {
      sessionId: "http-steer-sess",
      message: "Add this constraint to the turn",
      steer: true,
    });
    expect(steerRes.status).toBe(200);
    expect(steerRes.body.ok).toBe(true);
    expect(steerRes.body.steered).toBe(true);
    expect(steerRes.body.turnId).toBe(turn1Id);

    // Steer with non-existent session returns 404
    const badSteer = await fetchJson(`http://localhost:${port}/api/send`, {
      sessionId: "non-existent-session",
      message: "Orphan steer",
      steer: true,
    });
    expect(badSteer.status).toBe(404);

    release();
  });
});

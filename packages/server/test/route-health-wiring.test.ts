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
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import {
  createEightBitRouteHealthAuthority,
  EightBitRouteHealthLedger,
  type EightBitRouteHealthAuthority,
} from "@codeforge/eight-bit";
import { NormalizedModelRegistry, createFreeCloudService } from "@codeforge/model-registry";
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * R24 Mission A server wiring proof: a real provider event enters once through the actual
 * execution path, becomes a normalized 8-Bit observation with role/latency/tokens/correlation,
 * changes the route's temporal health, persists through the ledger, and changes what ForgeAuto
 * selects — across sessions that share the host-scoped authority.
 */

type StreamScript = (call: number) => StreamEvent[];

class ScriptedRouteProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  callCount = 0;

  constructor(
    readonly providerId: string,
    private readonly modelId: string,
    private readonly script: StreamScript,
  ) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: this.modelId,
      displayName: `${this.providerId} ${this.modelId}`,
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    yield* this.script(this.callCount);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const okEvents = (text = "Task complete.", inputTokens = 40, outputTokens = 12): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", usage: { inputTokens, outputTokens } },
  { type: "finish", finishReason: "stop" },
];

const errorEvent = (code: string, status: number, message: string, retryAfter?: number): StreamEvent[] => [
  { type: "error", code, status, message, retryable: true, retryAfter },
];

async function waitForTerminal(
  runtime: ReturnType<typeof createAgentRuntime>,
  persistence: ISessionPersistence,
  sessionId: string,
  turnId: string,
) {
  const approved = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed") return state;
    if (state?.status === "waiting_for_approval") {
      const items = await persistence.getWorkItems(sessionId);
      const pending = items.find((it) => it.kind === "approval" && it.turnId === turnId && !it.decision && !approved.has(it.id));
      if (pending) {
        approved.add(pending.id);
        await runtime.resolveApproval(pending.id, "allow_once");
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return runtime.getTurn(turnId);
}

describe("R24 — server route-health wiring (Mission A)", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let catalog: InMemoryProviderCatalog;
  let authority: EightBitRouteHealthAuthority;
  let ledger: EightBitRouteHealthLedger;

  const registerRoute = (providerId: string, modelId: string) =>
    firewall.register(createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}` }));

  const makeRuntime = (sessionId: string) =>
    createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir, routeHealth: authority });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-route-health-wiring-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    catalog = new InMemoryProviderCatalog();
    // One host-scoped authority + ledger, exactly what CodeForgeServer owns in production;
    // runtimes receive it through the `routeHealth` option instead of growing private copies.
    authority = createEightBitRouteHealthAuthority();
    ledger = new EightBitRouteHealthLedger(persistence);
    ledger.attach(authority);
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("a successful interactive model call lands once as a measured call_success (role, latency, tokens, turn correlation) plus durable ledger rows", async () => {
    registerRoute("provider-a", "aaa-model");
    const providerA = new ScriptedRouteProvider("provider-a", "aaa-model", () => okEvents());
    catalog.register(providerA);
    const runtime = makeRuntime("sess-wiring-ok");
    await runtime.init();

    const turnId = await runtime.startTurn("Say hello");
    const final = await waitForTerminal(runtime, persistence, "sess-wiring-ok", turnId);

    expect(final?.status).toBe("completed");
    expect(providerA.callCount).toBe(1);

    const assessment = authority.assess("provider-a", "aaa-model", { role: "CODER" });
    expect(assessment.state).toBe("HEALTHY");
    expect(assessment.hardExclude).toBe(false);
    expect(assessment.window.calls).toBe(1);
    expect(assessment.window.successes).toBe(1);
    expect(assessment.window.latencyP50Ms).not.toBeNull();

    await ledger.flush();
    const observations = await ledger.loadObservations({ providerId: "provider-a" });
    const success = observations.find((o) => o.kind === "call_success");
    expect(success).toBeDefined();
    expect(success!.kind === "call_success" && success!.role === "CODER").toBe(true);
    expect(success!.correlationId).toBe(turnId);
    expect(success!.requestShape).toBe("production");
    expect(success!.kind === "call_success" && success!.inputTokens === 40 && success!.outputTokens === 12).toBe(true);
    // Exactly one call_success for exactly one provider call — no duplicated observation.
    expect(observations.filter((o) => o.kind === "call_success")).toHaveLength(1);
    // The governor's post-call pressure reading reached the same authority (§18).
    expect(observations.some((o) => o.kind === "governor_pressure" && o.source === "governor")).toBe(true);
  });

  it("a 410 stream error becomes a permanent MODEL_RETIRED exclusion and ForgeAuto never calls the route again", async () => {
    registerRoute("provider-a", "aaa-model");
    registerRoute("provider-b", "zzz-model");
    const providerA = new ScriptedRouteProvider("provider-a", "aaa-model", () =>
      errorEvent("PROVIDER_GONE", 410, "410 Gone: this model has been retired"),
    );
    const providerB = new ScriptedRouteProvider("provider-b", "zzz-model", () => okEvents());
    catalog.register(providerA);
    catalog.register(providerB);
    const runtime = makeRuntime("sess-wiring-retired");
    await runtime.init();

    // Turn 1 starts on the alphabetically-first route (A), hits the 410, and must rotate to B.
    const turn1 = await runtime.startTurn("Do work");
    const final1 = await waitForTerminal(runtime, persistence, "sess-wiring-retired", turn1);
    expect(final1?.status).toBe("completed");
    expect(final1?.providerId).toBe("provider-b");
    expect(providerA.callCount).toBe(1);

    const assessment = authority.assess("provider-a", "aaa-model", { role: "CODER" });
    expect(assessment.state).toBe("MODEL_RETIRED");
    expect(assessment.hardExclude).toBe(true);
    // Permanent: the condition carries no expiry — only a catalog refresh can clear it.
    expect(assessment.activeConditions[0]?.state).toBe("MODEL_RETIRED");
    expect(assessment.activeConditions[0]?.expiresAt).toBeNull();

    // Turn 2 is a fresh routing decision: selectModel must drop A before any request is sent.
    const turn2 = await runtime.startTurn("Do more work");
    const final2 = await waitForTerminal(runtime, persistence, "sess-wiring-retired", turn2);
    expect(final2?.status).toBe("completed");
    expect(final2?.providerId).toBe("provider-b");
    expect(providerA.callCount).toBe(1); // never called again
    expect(providerB.callCount).toBe(2);
  });

  it("a provider-rejected tool call feeds the authority exactly once (call_failure drives the malformed sample; no double tool_outcome)", async () => {
    registerRoute("provider-a", "aaa-model");
    registerRoute("provider-b", "zzz-model");
    const providerA = new ScriptedRouteProvider("provider-a", "aaa-model", () =>
      errorEvent("INVALID_TOOL_OUTPUT", 400, "Invalid function call format: tool name not in schema"),
    );
    const providerB = new ScriptedRouteProvider("provider-b", "zzz-model", () => okEvents());
    catalog.register(providerA);
    catalog.register(providerB);
    const runtime = makeRuntime("sess-wiring-tool");
    await runtime.init();

    const turnId = await runtime.startTurn("Do work");
    const final = await waitForTerminal(runtime, persistence, "sess-wiring-tool", turnId);

    // INVALID_TOOL_OUTPUT is a bounded same-route retry (threshold 3), then rotation to B.
    expect(final?.status).toBe("completed");
    expect(providerA.callCount).toBe(3);
    expect(providerB.callCount).toBe(1);

    const snapshot = authority.get("provider-a", "aaa-model");
    expect(snapshot).toBeDefined();
    // Three provider rejections = three malformed samples, not six. Before the dedupe the
    // failover path re-fed each rejection as a second tool_outcome — six samples would have
    // tripped the quarantine streak (4) on the third rejection.
    expect(snapshot!.window.malformedToolCalls).toBe(3);
    expect(snapshot!.window.toolCalls).toBe(3);
    expect(snapshot!.window.failures).toBe(3);
    expect(snapshot!.consecutiveMalformed).toBe(3);
    expect(snapshot!.state).not.toBe("QUARANTINED");

    await ledger.flush();
    const observations = await ledger.loadObservations({ providerId: "provider-a" });
    expect(observations.filter((o) => o.kind === "call_failure" && o.reason === "INVALID_TOOL_OUTPUT")).toHaveLength(3);
    expect(observations.filter((o) => o.kind === "tool_outcome")).toHaveLength(0);
  });

  it("a saturation condition in the shared authority re-ranks route selection for a DIFFERENT session runtime", async () => {
    registerRoute("provider-a", "aaa-model");
    registerRoute("provider-b", "zzz-model");
    const providerA = new ScriptedRouteProvider("provider-a", "aaa-model", () => okEvents());
    const providerB = new ScriptedRouteProvider("provider-b", "zzz-model", () => okEvents());
    catalog.register(providerA);
    catalog.register(providerB);

    // Session A observes shared-worker saturation on provider-a (R23's NVIDIA 16/16 signal).
    authority.observe({
      kind: "call_failure",
      providerId: "provider-a",
      modelId: "aaa-model",
      observedAt: new Date().toISOString(),
      source: "runtime",
      reason: "TEMPORARY_CAPACITY",
      message: "503 Worker local total request limit reached (16/16)",
      role: "CODER",
      correlationId: "sess-a-turn",
    });
    const saturated = authority.assess("provider-a", "aaa-model", { role: "CODER" });
    expect(saturated.state).toBe("SATURATED");
    expect(saturated.hardExclude).toBe(false); // a ranking penalty, not a door — but enough to lose to a healthy route
    expect(saturated.scoreAdjustment).toBeLessThan(0);

    // Session B shares the host authority: with equal capability scores the alphabetical
    // baseline would pick aaa-model, but SATURATED's -60 drops it below B's UNKNOWN -5.
    const runtimeB = makeRuntime("sess-wiring-b");
    await runtimeB.init();
    const turnId = await runtimeB.startTurn("Do work");
    const final = await waitForTerminal(runtimeB, persistence, "sess-wiring-b", turnId);

    expect(final?.status).toBe("completed");
    expect(final?.providerId).toBe("provider-b");
    expect(providerA.callCount).toBe(0); // session B never touched the saturated route
    expect(providerB.callCount).toBe(1);
  });

  it("provider response headers reach the authority once through FreeCloudService.onProviderResponse", async () => {
    const freeCloud = createFreeCloudService({
      firewall,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
    });
    // The desktop host attaches the server-owned authority after construction.
    freeCloud.setRouteHealth(authority);

    const observedAt = Date.now();
    freeCloud.onProviderResponse({
      providerId: "groq",
      modelId: "openai/gpt-oss-120b",
      status: 429,
      headers: [
        ["x-ratelimit-limit-requests", "30"],
        ["x-ratelimit-remaining-requests", "0"],
        ["x-ratelimit-reset-requests", "45s"],
      ],
      observedAt,
    });

    const assessment = authority.assess("groq", "openai/gpt-oss-120b");
    expect(assessment.state).toBe("RATE_LIMITED");
    expect(assessment.hardExclude).toBe(true);
    // The provider's own reset (45s) sets the TTL, not a synthetic guess.
    const condition = assessment.activeConditions.find((c) => c.state === "RATE_LIMITED");
    expect(condition?.expiresAt).toBeGreaterThan(observedAt + 30_000);
    expect(condition?.expiresAt).toBeLessThanOrEqual(observedAt + 46_000);

    // Quota facts are stored on the route for probe budgeting, from the same single observation.
    const snapshot = authority.get("groq", "openai/gpt-oss-120b");
    expect(snapshot?.quota.requestsRemaining).toBe(0);
    expect(snapshot?.quota.requestsLimit).toBe(30);
  });

  it("a healthy 200 header observation carries quota facts without manufacturing a failure", async () => {
    const freeCloud = createFreeCloudService({
      firewall,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      routeHealth: authority,
    });
    freeCloud.onProviderResponse({
      providerId: "groq",
      modelId: "openai/gpt-oss-120b",
      status: 200,
      headers: [
        ["x-ratelimit-limit-requests", "30"],
        ["x-ratelimit-remaining-requests", "29"],
      ],
      observedAt: Date.now(),
    });

    const snapshot = authority.get("groq", "openai/gpt-oss-120b");
    expect(snapshot?.quota.requestsRemaining).toBe(29);
    const assessment = authority.assess("groq", "openai/gpt-oss-120b");
    // Status-only headers are capacity facts, never a health failure.
    expect(assessment.state).not.toBe("RATE_LIMITED");
    expect(assessment.hardExclude).toBe(false);
    expect(assessment.window.failures).toBe(0);
  });
});

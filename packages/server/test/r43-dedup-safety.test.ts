import { describe, it, expect } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { createForgeGreenAdvisor } from "@codeforge/forge-green";
import { createModelExecutionAdapter, type ModelExecutionRequest } from "../src/model-execution-adapter.js";
import { ForgeGreenRunPolicy } from "../src/forgegreen-run-policy.js";

class ScriptedProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  public requests: ChatRequest[] = [];
  constructor(
    readonly providerId: string,
    private readonly text: string,
  ) {}
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: `${this.providerId}-model`, displayName: this.providerId, isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(): Promise<ChatResponse> { throw new Error("stream only"); }
  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    yield { type: "text_delta", delta: this.text };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
}

function fixture() {
  const providerA = new ScriptedProvider("provider-a", "answer-from-a");
  const providerB = new ScriptedProvider("provider-b", "answer-from-b");
  const catalog = new InMemoryProviderCatalog();
  catalog.register(providerA);
  catalog.register(providerB);
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "provider-a-model" }));
  firewall.register(createGenericFreeRecord({ providerId: "provider-b", modelId: "provider-b-model" }));
  const forgeGreen = createForgeGreenAdvisor({ enabled: true });
  return { providerA, providerB, catalog, firewall, forgeGreen };
}

const ceiling = { duplicateSuppression: true, toolOutputCompression: true, supersededCompaction: true };
const req = (providerId?: string): ModelExecutionRequest => ({
  modelSelection: providerId ? { providerId, modelId: `${providerId}-model` } : undefined,
  messages: [{ role: "user", content: "same question" }],
  dedupeScope: "run-x",
});

describe("R43 model-request dedup safety", () => {
  it("FULL replays a completed identical response once — same provider, same request", async () => {
    const { providerA, catalog, firewall, forgeGreen } = fixture();
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ceiling, "FULL");
    const adapter = createModelExecutionAdapter(catalog, firewall, forgeGreen, undefined, policy);
    const first = await adapter.execute(req("provider-a"));
    const second = await adapter.execute(req("provider-a"));
    expect(providerA.requests).toHaveLength(1);
    expect(first.text).toBe("answer-from-a");
    expect(second.text).toBe("answer-from-a");
    expect(second.optimization?.duplicateSuppressed).toBe(true);
  });

  it("a quality-risk escalation invalidates the cached answer — an identical retry re-executes", async () => {
    const { providerA, catalog, firewall, forgeGreen } = fixture();
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ceiling, "FULL");
    const adapter = createModelExecutionAdapter(catalog, firewall, forgeGreen, undefined, policy);
    await adapter.execute(req("provider-a"));
    policy.escalate("model_response_unusable", "finishReason=stop textBytes=0");
    const retry = await adapter.execute(req("provider-a"));
    expect(providerA.requests).toHaveLength(2);
    expect(retry.optimization?.duplicateSuppressed).toBe(false);
  });

  it("a response cached before failover can never replay after it — the epoch folds into the key", async () => {
    const { providerA, providerB, catalog, firewall, forgeGreen } = fixture();
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ceiling, "FULL");
    const adapter = createModelExecutionAdapter(catalog, firewall, forgeGreen, undefined, policy);
    const first = await adapter.execute(req("provider-a"));
    expect(first.text).toBe("answer-from-a");
    // Failover: different provider means a different key — B executes fresh, never replays A.
    policy.escalate("provider_failover", "provider-a/provider-a-model -> provider-b/provider-b-model");
    const failed = await adapter.execute(req("provider-b"));
    expect(providerB.requests).toHaveLength(1);
    expect(failed.text).toBe("answer-from-b");
    // Rotation back to A: the epoch moved, so A's pre-failover answer cannot be replayed either.
    const backToA = await adapter.execute(req("provider-a"));
    expect(providerA.requests).toHaveLength(2);
    expect(backToA.optimization?.duplicateSuppressed).toBe(false);
  });

  it("CONSERVATIVE joins in-flight duplicates but never replays a completed response", async () => {
    const { providerA, catalog, firewall, forgeGreen } = fixture();
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ceiling, "CONSERVATIVE");
    const adapter = createModelExecutionAdapter(catalog, firewall, forgeGreen, undefined, policy);
    // In-flight join: two concurrent identical dispatches become one provider request.
    const [a, b] = await Promise.all([adapter.execute(req("provider-a")), adapter.execute(req("provider-a"))]);
    expect(providerA.requests).toHaveLength(1);
    expect(a.text).toBe("answer-from-a");
    expect(b.text).toBe("answer-from-a");
    // Completed-response replay is off: a sequential repeat re-executes.
    const third = await adapter.execute(req("provider-a"));
    expect(providerA.requests).toHaveLength(2);
    expect(third.optimization?.duplicateSuppressed).toBe(false);
  });

  it("OFF disables dedup entirely — every request executes", async () => {
    const { providerA, catalog, firewall, forgeGreen } = fixture();
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ceiling, "OFF");
    const adapter = createModelExecutionAdapter(catalog, firewall, forgeGreen, undefined, policy);
    await adapter.execute(req("provider-a"));
    await adapter.execute(req("provider-a"));
    expect(providerA.requests).toHaveLength(2);
  });

  it("a failed (thrown) request is never cached — the retry reaches the provider", async () => {
    const failing = new ScriptedProvider("provider-a", "unused");
    const catalog = new InMemoryProviderCatalog();
    catalog.register(failing);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "provider-a", modelId: "provider-a-model" }));
    const forgeGreen = createForgeGreenAdvisor({ enabled: true });
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ceiling, "FULL");
    const adapter = createModelExecutionAdapter(catalog, firewall, forgeGreen, undefined, policy);
    let attempts = 0;
    const orig = failing.streamChat.bind(failing);
    failing.streamChat = async function* (r: ChatRequest): AsyncIterable<StreamEvent> {
      attempts++;
      if (attempts === 1) {
        throw new Error("provider exploded");
      }
      yield* orig(r);
    };
    await expect(adapter.execute(req("provider-a"))).rejects.toThrow();
    const retry = await adapter.execute(req("provider-a"));
    expect(attempts).toBe(2);
    expect(retry.optimization?.duplicateSuppressed).toBe(false);
  });
});

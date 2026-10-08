import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  InMemoryProviderCatalog,
  ProviderCapacityGovernor,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderModel,
  type StreamEvent,
} from "@codeforge/providers";
import { ModelExecutionAdapter, type FreeDispatchCapacityAuthority, type ModelExecutionRequest } from "../src/model-execution-adapter.js";

/**
 * R70 quota-domain dispatch proof: the admission authority's `independenceKey` — and only that
 * key — decides which physical quota bucket paces and cools a production Free dispatch. One
 * exhausted account domain must not suppress a verified-independent account on the same
 * provider; an alias of the same account must share its cooldown; unverified domains stay
 * pooled; and a dispatch with no domain authority keeps conservative provider-global pacing.
 */

const PROVIDER = "quota-x";
const MODEL = "quota-x-model";
const domainKey = (account: string) => `${PROVIDER}:USER_ACCOUNT:${createHash("sha256").update(account).digest("hex")}`;

class ScriptedQuotaProvider implements ProviderAdapter {
  readonly providerId = PROVIDER;
  readonly isTestProvider = false;
  calls = 0;

  constructor(private readonly script: (call: number) => StreamEvent[]) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{
      modelId: MODEL,
      displayName: MODEL,
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    yield* this.script(this.calls);
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

const okEvents = (): StreamEvent[] => [
  { type: "text_delta", delta: "ok" },
  { type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
  { type: "finish", finishReason: "stop" },
];

const accountLimited = (): StreamEvent[] => [
  { type: "error", code: "RATE_LIMITED", status: 429, message: "429 insufficient_quota: account daily quota exhausted", retryable: true, retryAfter: Date.now() + 3_600_000 },
];

const request = (userId: string): ModelExecutionRequest => ({
  modelSelection: { providerId: PROVIDER, modelId: MODEL },
  messages: [{ role: "user", content: "hello" }],
  userId,
});

async function drain(adapter: ModelExecutionAdapter, req: ModelExecutionRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamExecution(req)) events.push(event);
  return events;
}

function fixture(authority: (req: ModelExecutionRequest) => FreeDispatchCapacityAuthority | void, script: (call: number) => StreamEvent[]) {
  const catalog = new InMemoryProviderCatalog();
  const provider = new ScriptedQuotaProvider(script);
  catalog.register(provider);
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: PROVIDER, modelId: MODEL }));
  const governor = new ProviderCapacityGovernor();
  const adapter = new ModelExecutionAdapter(catalog, firewall, undefined, governor, undefined, undefined,
    (_selection, req) => authority(req));
  return { adapter, provider, governor };
}

describe("quota-domain scoped dispatch authority", () => {
  it("an exhausted account domain never suppresses a verified-independent domain on the same provider", async () => {
    const f = fixture((req) => ({ independenceKey: domainKey(req.userId === "carol" ? "acct-alice" : `acct-${req.userId}`) }),
      (call) => (call === 1 ? accountLimited() : okEvents()));

    const aliceEvents = await drain(f.adapter, request("alice"));
    expect(aliceEvents.at(-1)).toMatchObject({ type: "error", code: "PROVIDER_RATE_LIMITED" });
    expect(f.provider.calls).toBe(1);

    // The 429 cooled only Alice's domain — the shared provider governor stays clean.
    const aliceDomain = f.governor.quotaDomainGovernor(PROVIDER, domainKey("acct-alice"));
    expect(aliceDomain?.isCoolingDown(PROVIDER)).toBe(true);
    expect(f.governor.isCoolingDown(PROVIDER)).toBe(false);

    const bobEvents = await drain(f.adapter, request("bob"));
    expect(bobEvents.at(-1)).toMatchObject({ type: "finish" });
    expect(f.provider.calls).toBe(2);
    expect(f.governor.quotaDomainGovernor(PROVIDER, domainKey("acct-bob"))?.isCoolingDown(PROVIDER)).toBe(false);

    // Carol authenticates through Alice's physical account: same domain, same cooldown,
    // and the provider is never even asked.
    await expect(drain(f.adapter, request("carol"))).rejects.toThrow("PROVIDER_RATE_LIMITED");
    expect(f.provider.calls).toBe(2);
  });

  it("pools unverified quota scopes conservatively under one shared domain", async () => {
    const shared = `${PROVIDER}:UNKNOWN:shared-unverified`;
    const f = fixture(() => ({ independenceKey: shared }), (call) => (call === 1 ? accountLimited() : okEvents()));

    const aliceEvents = await drain(f.adapter, request("alice"));
    expect(aliceEvents.at(-1)).toMatchObject({ type: "error" });
    await expect(drain(f.adapter, request("bob"))).rejects.toThrow("PROVIDER_RATE_LIMITED");
    expect(f.provider.calls).toBe(1);
    expect(f.governor.isCoolingDown(PROVIDER)).toBe(false);
  });

  it("keeps provider-global pacing when admission returns no domain authority", async () => {
    const f = fixture(() => undefined, (call) => (call === 1 ? accountLimited() : okEvents()));

    const aliceEvents = await drain(f.adapter, request("alice"));
    expect(aliceEvents.at(-1)).toMatchObject({ type: "error" });
    expect(f.governor.isCoolingDown(PROVIDER)).toBe(true);
    await expect(drain(f.adapter, request("bob"))).rejects.toThrow("PROVIDER_RATE_LIMITED");
    expect(f.provider.calls).toBe(1);
  });
});

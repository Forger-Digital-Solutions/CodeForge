import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  BudgetGatedProviderAdapter,
  DurablePaidEvaluationBudgetLedger,
  PaidEvaluationBudgetError,
  PaidEvaluationBudgetLedger,
  formatUsd,
  type PaidEvaluationReceipt,
  type PriceCard,
} from "../src/index.js";

const price: PriceCard = {
  modelIdentity: {
    canonicalModelId: "gpt-5.6-luna",
    providerId: "openrouter",
    providerModelId: "openai/gpt-5.6-luna",
    gatewayModelId: "openai/gpt-5.6-luna",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
  },
  providerIdentity: {
    providerId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
  },
  canonicalModelId: "gpt-5.6-luna",
  providerId: "openrouter",
  providerModelId: "openai/gpt-5.6-luna",
  uncachedInputUsdPerMillion: "1.0",
  cachedInputUsdPerMillion: "0.1",
  outputUsdPerMillion: "2.0",
  currency: "USD",
  status: "CURRENT",
  source: "test-price-card",
  effectiveAt: "2026-09-18T00:00:00.000Z",
  confidence: "HIGH",
};

const request: ChatRequest = {
  model: "openai/gpt-5.6-luna",
  messages: [{ role: "user", content: "implement a tiny safe fix" }],
  maxTokens: 100,
};

function adapter(options: { resultModel?: string; streamEvents?: StreamEvent[]; calls?: ChatRequest[] } = {}): ProviderAdapter {
  const resultModel = options.resultModel ?? "openai/gpt-5.6-luna";
  const isTestProvider = true;
  return {
    providerId: "openrouter",
    isTestProvider,
    async listModels() { return []; },
    async chat(req) {
      options.calls?.push(req);
      return {
        id: "response",
        model: resultModel,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        usage: { inputTokens: 20, outputTokens: 10 },
      } satisfies ChatResponse;
    },
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      options.calls?.push(req);
      for (const event of options.streamEvents ?? [
        { type: "text_delta", delta: "ok" } satisfies StreamEvent,
        { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } } satisfies StreamEvent,
        { type: "finish", finishReason: "stop" } satisfies StreamEvent,
      ]) yield event;
    },
    async healthCheck() { return { status: "available" as const }; },
  };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("R47 budget-gated paid adapter", () => {
  it("reserves before dispatch and reconciles actual usage on chat", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const upstream = adapter();
    const gated = new BudgetGatedProviderAdapter(upstream, { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    const response = await gated.chat(request);
    expect(response.model).toBe("openai/gpt-5.6-luna");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      routeId: "gpt-5.6-luna:openrouter",
      reconciliation: "ACTUAL",
      servedModelId: "openai/gpt-5.6-luna",
      actualUsd: "0.00004",
    });
    expect(ledger.snapshot().committedUsd).toBe("0.00004");
    expect(JSON.stringify(receipts)).not.toContain("implement a tiny safe fix");
  });

  it("fails closed before dispatch when the model is not a registered paid route", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const calls: ChatRequest[] = [];
    const gated = new BudgetGatedProviderAdapter(adapter({ calls }), { ledger, priceCards: [price] });
    await expect(gated.chat({ ...request, model: "meta/llama-free" })).rejects.toMatchObject({ code: "PAID_EVALUATION_PRICE_UNKNOWN" });
    expect(calls).toHaveLength(0);
  });

  it("fails closed before dispatch when no exact current price card exists", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const calls: ChatRequest[] = [];
    const gated = new BudgetGatedProviderAdapter(adapter({ calls }), { ledger, priceCards: [] });
    await expect(gated.chat(request)).rejects.toMatchObject({ code: "PAID_EVALUATION_PRICE_UNKNOWN" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a substituted served model and releases the reservation", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const gated = new BudgetGatedProviderAdapter(adapter({ resultModel: "other/provider" }), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    await expect(gated.chat(request)).rejects.toMatchObject({ code: "PAID_EVALUATION_MODEL_IDENTITY_MISMATCH" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reconciliation).toBe("RELEASED");
    expect(ledger.snapshot()).toMatchObject({ committedUsd: "0.0", reservedUsd: "0.0" });
  });

  it("propagates campaign exhaustion and keeps the upstream call undispatched", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "0.0005" });
    const calls: ChatRequest[] = [];
    const gated = new BudgetGatedProviderAdapter(adapter({ calls }), { ledger, priceCards: [price] });
    await gated.chat(request);
    await expect(gated.chat(request)).rejects.toMatchObject({ code: "PAID_EVALUATION_BUDGET_EXHAUSTED" });
    expect(calls).toHaveLength(1);
  });

  it("settles stream usage as ACTUAL once the stream completes", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const gated = new BudgetGatedProviderAdapter(adapter(), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    const events = await drain(gated.streamChat(request));
    expect(events.map((event) => event.type)).toEqual(["text_delta", "usage", "finish"]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reconciliation: "ACTUAL", actualUsd: "0.00004" });
  });

  it("commits the reserved bound as ESTIMATED_ONLY when a stream completes without usage", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const streamEvents: StreamEvent[] = [
      { type: "text_delta", delta: "ok" },
      { type: "finish", finishReason: "stop" },
    ];
    const gated = new BudgetGatedProviderAdapter(adapter({ streamEvents }), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    await drain(gated.streamChat(request));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reconciliation).toBe("ESTIMATED_ONLY");
    expect(receipts[0]?.usage).toBeUndefined();
    expect(ledger.snapshot().committedUsd).toBe(receipts[0]?.estimatedUsd);
  });

  it("releases a stream reservation when the provider errors mid-stream", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const streamEvents: StreamEvent[] = [
      { type: "text_delta", delta: "partial" },
      { type: "error", code: "STREAM_ERROR", message: "upstream died", retryable: true },
    ];
    const failing: ProviderAdapter = {
      providerId: "openrouter",
      isTestProvider: true,
      async listModels() { return []; },
      async chat() { throw new Error("unreachable"); },
      async *streamChat(): AsyncIterable<StreamEvent> {
        yield streamEvents[0]!;
        throw new Error("upstream died");
      },
      async healthCheck() { return { status: "available" as const }; },
    };
    const gated = new BudgetGatedProviderAdapter(failing, { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    await expect(drain(gated.streamChat(request))).rejects.toThrow("upstream died");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reconciliation).toBe("RELEASED");
    expect(ledger.snapshot().committedUsd).toBe("0.0");
  });

  it("releases a stream reservation when the consumer abandons the generator", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r47-gated", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const gated = new BudgetGatedProviderAdapter(adapter(), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    for await (const _event of gated.streamChat(request)) break;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reconciliation).toBe("RELEASED");
    expect(ledger.snapshot().committedUsd).toBe("0.0");
  });

  it("durable ledger commits ESTIMATED_ONLY for an unmeasured completed call", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    try {
      await persistence.upsertSession({ id: "tenant-r47", title: "r47", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
      const ledger = new DurablePaidEvaluationBudgetLedger(persistence, { campaignId: "r47-durable-unmeasured", sessionId: "tenant-r47", authorizedUsd: "1.00" });
      const gated = new BudgetGatedProviderAdapter(adapter({ streamEvents: [{ type: "finish", finishReason: "stop" }] }), { ledger, priceCards: [price] });
      const events = await drain(gated.streamChat(request));
      expect(events.at(-1)?.type).toBe("finish");
      const snapshot = await ledger.snapshot();
      const reservation = snapshot.reservations[0];
      expect(reservation?.status).toBe("RECONCILED");
      expect(reservation?.actualUsd).toBe(reservation?.estimatedUsd);
      expect(snapshot.committedUsd).toBe(reservation?.estimatedUsd);
      const receipts = await ledger.listReceipts();
      expect(receipts[0]?.reconciliation).toBe("ESTIMATED_ONLY");
      expect(formatUsd(0n)).toBe("0.0");
    } finally {
      await persistence.close();
    }
  });
});

describe("R48 — stream served-model provenance", () => {
  it("binds the provider-reported stream model into the receipt", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r48-stream-id", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const streamEvents: StreamEvent[] = [
      { type: "text_delta", delta: "ok" },
      { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } },
      { type: "finish", finishReason: "stop", model: "openai/gpt-5.6-luna" },
    ];
    const gated = new BudgetGatedProviderAdapter(adapter({ streamEvents }), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    await drain(gated.streamChat(request));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reconciliation: "ACTUAL", servedModelId: "openai/gpt-5.6-luna" });
  });

  it("fails closed when the stream's reported model does not match the priced route", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r48-stream-id", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const streamEvents: StreamEvent[] = [
      { type: "text_delta", delta: "partial" },
      { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } },
      { type: "finish", finishReason: "stop", model: "anthropic/some-other-model" },
    ];
    const gated = new BudgetGatedProviderAdapter(adapter({ streamEvents }), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    await expect(drain(gated.streamChat(request))).rejects.toMatchObject({ code: "PAID_EVALUATION_MODEL_IDENTITY_MISMATCH" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reconciliation: "RELEASED", servedModelId: "anthropic/some-other-model" });
    expect(ledger.snapshot().committedUsd).toBe("0.0");
  });

  it("leaves servedModelId absent — unverified, not fabricated — when the upstream never reports one", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r48-stream-id", authorizedUsd: "1.00" });
    const receipts: PaidEvaluationReceipt[] = [];
    const streamEvents: StreamEvent[] = [
      { type: "text_delta", delta: "ok" },
      { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } },
      { type: "finish", finishReason: "stop" },
    ];
    const gated = new BudgetGatedProviderAdapter(adapter({ streamEvents }), { ledger, priceCards: [price], onReceipt: (receipt) => receipts.push(receipt) });
    await drain(gated.streamChat(request));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reconciliation).toBe("ACTUAL");
    expect(receipts[0]?.servedModelId).toBeUndefined();
  });
});

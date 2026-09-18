import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  DurablePaidEvaluationBudgetLedger,
  PaidAutoOpenRouterEvaluationRunner,
  PaidEvaluationBudgetError,
  PaidEvaluationBudgetLedger,
  estimateRequestUsd,
  formatUsd,
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
  gatewayFeeUsdPerRequest: "0.001",
  currency: "USD",
  status: "CURRENT",
  source: "test-price-card",
  effectiveAt: "2026-09-18T00:00:00.000Z",
  confidence: "HIGH",
};

const request: Omit<ChatRequest, "model"> = { messages: [{ role: "user", content: "implement a tiny safe fix" }], maxTokens: 100 };
const route = { routeId: "gpt-5.6-luna:openrouter", canonicalModelId: "gpt-5.6-luna", kind: "openrouter", providerId: "openrouter", providerModelId: "openai/gpt-5.6-luna", priority: 2, source: "test", pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", status: "UNKNOWN", source: "test" } } as const;

function adapter(resultModel = "openai/gpt-5.6-luna"): ProviderAdapter {
  return {
    providerId: "openrouter",
    async listModels() { return []; },
    async chat(_req) { return { id: "response", model: resultModel, choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { inputTokens: 20, outputTokens: 10 } }; },
    async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> { yield { type: "finish", finishReason: "stop" }; },
    async healthCheck() { return { status: "available" as const }; },
  };
}

describe("R13 paid evaluation budget", () => {
  it("uses decimal-safe accounting and never reserves beyond the campaign ceiling", () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r13", authorizedUsd: "0.005" });
    const tiny: ChatRequest = { ...request, model: "gpt-5.6-luna", maxTokens: 1 };
    const estimated = estimateRequestUsd(tiny, price);
    expect(formatUsd(estimated)).toBe("0.001301");
    const reservations = Array.from({ length: 3 }, (_, index) => ledger.reserve(`r-${index}`, route, price, tiny));
    expect(reservations).toHaveLength(3);
    expect(() => ledger.reserve("over", route, price, tiny)).toThrow(PaidEvaluationBudgetError);
    expect(ledger.snapshot()).toMatchObject({ authorizedUsd: "0.005", reservedUsd: "0.003903", availableUsd: "0.001097" });
  });

  it("requires an explicit output bound and a current exact price", () => {
    expect(() => estimateRequestUsd({ ...request, model: "gpt-5.6-luna", maxTokens: undefined }, price)).toThrow("PAID_EVALUATION_OUTPUT_BOUND_REQUIRED");
    expect(() => estimateRequestUsd({ ...request, model: "gpt-5.6-luna", maxTokens: 1 }, { ...price, status: "UNKNOWN" })).toThrow("PAID_EVALUATION_PRICE_UNKNOWN");
  });

  it("applies a documented context tier using integer-safe token arithmetic", () => {
    const tiered = { ...price, contextTiers: [{ minInputTokens: 10, uncachedInputUsdPerMillion: "2.0", outputUsdPerMillion: "3.0" }] };
    expect(formatUsd(estimateRequestUsd({ ...request, model: "gpt-5.6-luna", maxTokens: 1 }, tiered))).toBe("0.001601");
  });

  it("reconciles an exact pinned OpenRouter response and retains a sanitized receipt", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r13-paid-baseline", authorizedUsd: "15.00" });
    const receipts: unknown[] = [];
    const runner = new PaidAutoOpenRouterEvaluationRunner(adapter(), ledger, [price], (receipt) => receipts.push(receipt));
    const result = await runner.chat({ requestId: "baseline-1", canonicalModelId: "gpt-5.6-luna", request });
    expect(result.receipt).toMatchObject({ requestedProviderModelId: "openai/gpt-5.6-luna", servedModelId: "openai/gpt-5.6-luna", reconciliation: "ACTUAL" });
    expect(JSON.stringify(receipts)).not.toContain("implement a tiny safe fix");
    expect(ledger.snapshot().committedUsd).toBe("0.00104");
  });

  it("rejects a substituted served model and releases its reservation", async () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "r13", authorizedUsd: "15.00" });
    const runner = new PaidAutoOpenRouterEvaluationRunner(adapter("other/provider"), ledger, [price]);
    await expect(runner.chat({ requestId: "substitution", canonicalModelId: "gpt-5.6-luna", request })).rejects.toMatchObject({ code: "PAID_EVALUATION_MODEL_IDENTITY_MISMATCH" });
    expect(ledger.snapshot()).toMatchObject({ committedUsd: "0.0", reservedUsd: "0.0", availableUsd: "15.0" });
  });

  it("durably serializes 100 simultaneous reservations below the finite campaign ceiling", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    try {
      await persistence.upsertSession({ id: "tenant-a", title: "a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
      const ledger = new DurablePaidEvaluationBudgetLedger(persistence, { campaignId: "r13-concurrency", sessionId: "tenant-a", authorizedUsd: "0.005" });
      const tiny: ChatRequest = { ...request, model: "gpt-5.6-luna", maxTokens: 1 };
      const outcomes = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => ledger.reserve(`concurrent-${index}`, route, price, tiny)));
      const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(accepted).toHaveLength(3);
      expect(rejected).toHaveLength(97);
      expect(rejected.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof PaidEvaluationBudgetError && outcome.reason.code === "PAID_EVALUATION_BUDGET_EXHAUSTED")).toBe(true);
      const afterRestart = new DurablePaidEvaluationBudgetLedger(persistence, { campaignId: "r13-concurrency", sessionId: "tenant-a", authorizedUsd: "0.005" });
      await expect(afterRestart.snapshot()).resolves.toMatchObject({ authorizedUsd: "0.005", reservedUsd: "0.003903", availableUsd: "0.001097" });
    } finally {
      await persistence.close();
    }
  });

  it("session-scopes durable paid receipts and rejects credential-shaped identifiers", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    try {
      const now = new Date().toISOString();
      await persistence.upsertSession({ id: "tenant-a", title: "a", createdAt: now, updatedAt: now, status: "running" });
      await persistence.upsertSession({ id: "tenant-b", title: "b", createdAt: now, updatedAt: now, status: "running" });
      const a = new DurablePaidEvaluationBudgetLedger(persistence, { campaignId: "r13-a", sessionId: "tenant-a", authorizedUsd: "15.00" });
      const b = new DurablePaidEvaluationBudgetLedger(persistence, { campaignId: "r13-b", sessionId: "tenant-b", authorizedUsd: "15.00" });
      const reservationA = await a.reserve("request-a", route, price, { ...request, model: "gpt-5.6-luna" });
      const reservationB = await b.reserve("request-b", route, price, { ...request, model: "gpt-5.6-luna" });
      await reservationA.reconcile({ inputTokens: 20, outputTokens: 10 }, "openai/gpt-5.6-luna");
      await reservationB.reconcile({ inputTokens: 20, outputTokens: 10 }, "openai/gpt-5.6-luna");
      expect((await a.listReceipts()).map((receipt) => receipt.requestId)).toEqual(["request-a"]);
      expect((await b.listReceipts()).map((receipt) => receipt.requestId)).toEqual(["request-b"]);
      expect(JSON.stringify(await persistence.getWorkItems("tenant-b"))).not.toContain("request-a");
      await expect(a.reserve("Bearer synthetic-token", route, price, { ...request, model: "gpt-5.6-luna" })).rejects.toMatchObject({ code: "PAID_EVALUATION_LEDGER_STATE_INVALID" });
    } finally {
      await persistence.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import { OpenRouterAdapter } from "../src/openrouter.js";

async function model(pricing: Record<string, string>) {
  const adapter = new OpenRouterAdapter({ credentialStore: { get: () => "fixture-key", has: () => true, set: () => undefined, delete: () => false },
    fetchFn: async () => Response.json({ data: [{ id: "owned-account-model", pricing, supported_parameters: ["tools"], architecture: { modality: "text->text" } }] }) });
  return (await adapter.listModels())[0]!;
}

describe("OpenRouter observed account catalog pricing", () => {
  it("preserves exact observed token prices and their source/freshness without authorizing dispatch", async () => {
    const result = await model({ prompt: "0.000001", completion: "0.000002", request: "0", image: "0" });
    expect(result.pricing).toMatchObject({ inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "AUTHORITATIVE", source: "https://openrouter.ai/api/v1/models", tokenOnly: true });
    expect(Date.parse(result.pricing!.recheckAt) - Date.parse(result.pricing!.verifiedAt)).toBe(300_000);
    expect(result.freeStatus).toBe("paid");
  });

  it.each([{ prompt: "0.000001", completion: "0.000002" }, { prompt: "0.000001", completion: "0.000002", request: "0.01" }, { prompt: "0.000001", completion: "0.000002", request: "0", unknown_fee: "0.1" }])("does not claim token-only spend protection with absent or additional fees %#", async (pricing) => {
    expect((await model(pricing)).pricing?.tokenOnly).toBe(false);
  });

  it("allows known discounted token subsets within the conservative base token estimate", async () => {
    expect((await model({ prompt: "0.000001", completion: "0.000002", request: "0", input_cache_read: "0.0000001", input_cache_write: "0.000001", internal_reasoning: "0.000002" })).pricing?.tokenOnly).toBe(true);
  });

  it.each(["input_cache_read", "input_cache_write", "internal_reasoning"])("excludes an uncovered %s token surcharge", async (dimension) => {
    expect((await model({ prompt: "0.000001", completion: "0.000002", request: "0", [dimension]: "0.000003" })).pricing?.tokenOnly).toBe(false);
  });

  it.each(["", "unknown", "-1", "1e309", "1e305", "0x10", " 0.01 ", "Infinity"])("leaves invalid/unbounded prices unavailable %j", async (prompt) => {
    expect((await model({ prompt, completion: "0.000002", request: "0" })).pricing).toBeUndefined();
  });
});

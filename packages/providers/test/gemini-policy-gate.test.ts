import { describe, expect, it } from "vitest";
import { buildGeminiFreeAcceptance, StaticGeminiFreePolicyGate } from "@codeforge/legal-policy";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import { ProviderError } from "../src/index.js";
import { classifyRegionEvidence } from "@codeforge/legal-policy";

const region = classifyRegionEvidence({ countryCode: "US", source: "ACCOUNT_BILLING_COUNTRY", observedAt: "2026-09-16T00:00:00.000Z" });
const accountId = "gemini-project-fixture";

describe("Gemini unpaid policy gate", () => {
  it("fails closed by default and never sends an exact-selection request", async () => {
    let fetches = 0;
    const adapter = new OpenAICompatibleAdapter({
      providerId: "google",
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      fetchFn: async () => { fetches++; return new Response("{}", { status: 200 }); },
    });
    expect(adapter.canRoute("gemini-2.5-flash")).toBe(false);
    await expect(adapter.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }], maxTokens: 32 })).rejects.toMatchObject({ code: "GEMINI_REGION_UNKNOWN" });
    expect(fetches).toBe(0);
  });

  it("allows only a current accepted revision in an eligible region", async () => {
    const gate = new StaticGeminiFreePolicyGate({
      accountId,
      region,
      acceptance: buildGeminiFreeAcceptance({ accountId, region, now: new Date("2026-09-16T00:00:00.000Z") }),
      now: new Date("2026-09-16T00:01:00.000Z"),
    });
    const adapter = new OpenAICompatibleAdapter({
      providerId: "google",
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      geminiFreePolicyGate: gate,
      fetchFn: async () => new Response(JSON.stringify({ id: "r", model: "gemini-2.5-flash", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(adapter.canRoute("gemini-2.5-flash")).toBe(true);
    await expect(adapter.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }], maxTokens: 32 })).resolves.toMatchObject({ choices: [{ message: { content: "ok" } }] });
  });

  it("does not turn paid Gemini into a free route", () => {
    const adapter = new OpenAICompatibleAdapter({ providerId: "google", baseUrl: "https://example.invalid/v1", apiKey: "test-key", geminiServiceTier: "PAID" });
    expect(adapter.canRoute("gemini-2.5-pro")).toBe(true);
  });

  it("surfaces policy errors as redacted provider errors", async () => {
    const adapter = new OpenAICompatibleAdapter({ providerId: "google", baseUrl: "https://example.invalid/v1", apiKey: "secret-gemini-key" });
    try {
      await adapter.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }], maxTokens: 32 });
      throw new Error("expected policy denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error)).not.toContain("secret-gemini-key");
    }
  });
});

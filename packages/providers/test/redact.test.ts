import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/redact.js";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";

describe("secret redaction in provider errors", () => {
  it("redacts the exact configured key", () => {
    expect(redactSecrets("Consumer 'api_key:MY-SECRET-KEY-123456' suspended", "MY-SECRET-KEY-123456")).not.toContain("MY-SECRET-KEY-123456");
  });

  it("redacts Google, OpenAI, OpenRouter, and Groq key patterns", () => {
    expect(redactSecrets("key AIzaSyD59YlkCFHE6ssh6Ya9o7e3wtfAY0m6NyA here")).toContain("***");
    expect(redactSecrets("key AIzaSyD59YlkCFHE6ssh6Ya9o7e3wtfAY0m6NyA here")).not.toMatch(/AIza\w/);
    expect(redactSecrets("sk-or-v1-abcdef0123456789abcdef")).not.toMatch(/sk-or-v1-\w/);
    expect(redactSecrets("sk-abcdef0123456789abcdef0123")).not.toMatch(/sk-[a-z0-9]{8}/);
    expect(redactSecrets("gsk_abcdefghij0123456789")).not.toMatch(/gsk_\w/);
  });

  it("a 403 error body echoing the api key is redacted before it reaches the ProviderError", async () => {
    const key = "AIzaSyD59YlkCFHE6ssh6Ya9o7e3wtfAY0m6NyA";
    const fetchFn = (async () => new Response(`{"error":{"code":403,"message":"Consumer 'api_key:${key}' suspended"}}`, { status: 403 })) as unknown as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({ providerId: "google", baseUrl: "https://x/v1", apiKey: key, fetchFn });
    await expect(adapter.chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "AUTH_ERROR" });
    try {
      await adapter.chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      expect((e as Error).message).not.toContain(key);
      expect((e as Error).message).toContain("***");
    }
  });
});

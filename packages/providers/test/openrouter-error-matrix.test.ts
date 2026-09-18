import { describe, expect, it } from "vitest";
import { OpenRouterAdapter } from "../src/openrouter.js";
import type { CredentialStore } from "../src/index.js";

const credentials: CredentialStore = {
  get: () => "test-key",
  set: () => {},
  delete: () => {},
  has: () => true,
};

const request = { model: "exact-model", messages: [{ role: "user" as const, content: "safe test" }], maxTokens: 8 };

function adapter(fetchFn: typeof fetch): OpenRouterAdapter {
  return new OpenRouterAdapter({ credentialStore: credentials, fetchFn, baseUrl: "https://example.invalid" });
}

describe("R13 OpenRouter provider-error matrix", () => {
  it("classifies every relevant HTTP error without treating an error as a completion", async () => {
    const cases: Array<[number, string, boolean]> = [
      [400, "PROVIDER_ERROR", false],
      [401, "AUTH_ERROR", false],
      [402, "PAYMENT_REQUIRED", false],
      [403, "AUTH_ERROR", false],
      [404, "MODEL_NOT_FOUND", false],
      [408, "TIMEOUT", true],
      [429, "RATE_LIMITED", true],
      [500, "PROVIDER_ERROR", true],
      [502, "PROVIDER_ERROR", true],
      [503, "MODEL_OVERLOADED", true],
      [504, "PROVIDER_ERROR", true],
    ];
    for (const [status, code, retryable] of cases) {
      const result = adapter((async () => new Response(`error ${status}`, { status, headers: status === 429 ? { "retry-after": "2" } : undefined })) as typeof fetch);
      await expect(result.chat(request)).rejects.toMatchObject({ code, retryable, status });
    }
  });

  it("accepts a 200 only when a usable choice exists, and tolerates missing usage without inventing it", async () => {
    const usable = adapter((async () => new Response(JSON.stringify({ id: "ok", model: "exact-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }), { status: 200 })) as typeof fetch);
    await expect(usable.chat(request)).resolves.toMatchObject({ model: "exact-model", usage: undefined });
    const empty = adapter((async () => new Response(JSON.stringify({ id: "empty", model: "exact-model", choices: [] }), { status: 200 })) as typeof fetch);
    await expect(empty.chat(request)).rejects.toMatchObject({ code: "EMPTY_COMPLETION", retryable: true });
  });

  it("makes malformed responses and connection resets retryable provider failures", async () => {
    const malformed = adapter((async () => new Response("{not-json", { status: 200 })) as typeof fetch);
    await expect(malformed.chat(request)).rejects.toMatchObject({ code: "CHAT_FAILED", retryable: true });
    const reset = adapter((async () => { throw new Error("ECONNRESET"); }) as typeof fetch);
    await expect(reset.chat(request)).rejects.toMatchObject({ code: "CHAT_FAILED", retryable: true });
  });
});

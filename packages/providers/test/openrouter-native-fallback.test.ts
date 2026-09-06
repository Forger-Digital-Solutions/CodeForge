import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterAdapter } from "../src/openrouter.js";
import type { CredentialStore } from "../src/index.js";
import type { ChatRequest } from "../src/chat-types.js";

const fakeCredentials: CredentialStore = {
  get: () => "test-key",
  set: () => {},
  delete: () => {},
  has: () => true,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const chatResponseBody = {
  id: "resp-1",
  model: "primary-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouterAdapter — 8-Bit provider-native fallback wiring", () => {
  it("[PASS] omits `models` entirely when no fallback candidates are supplied (unchanged existing request shape)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chatResponseBody));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenRouterAdapter({ credentialStore: fakeCredentials });
    const req: ChatRequest = { model: "primary-model", messages: [{ role: "user", content: "hi" }] };
    await adapter.chat(req);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe("primary-model");
    expect(body.models).toBeUndefined();
  });

  it("[PASS] sends an ordered `models` fallback array, primary first, when fallback candidates are supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chatResponseBody));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenRouterAdapter({ credentialStore: fakeCredentials });
    const req: ChatRequest = {
      model: "primary-model",
      messages: [{ role: "user", content: "hi" }],
      fallbackModels: ["primary-model", "secondary-model", "tertiary-model"],
    };
    await adapter.chat(req);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.models).toEqual(["primary-model", "secondary-model", "tertiary-model"]);
  });

  it("[PASS] a single-candidate fallback list (no real alternative) does not emit `models` at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chatResponseBody));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenRouterAdapter({ credentialStore: fakeCredentials });
    const req: ChatRequest = { model: "primary-model", messages: [{ role: "user", content: "hi" }], fallbackModels: ["primary-model"] };
    await adapter.chat(req);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.models).toBeUndefined();
  });
});

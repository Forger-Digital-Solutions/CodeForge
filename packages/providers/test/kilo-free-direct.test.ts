import { describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import { createKiloFreeDirectAdapter, createProviderAdapterById } from "../src/provider-factory.js";

const request = { model: "kilo-auto/free", messages: [{ role: "user" as const, content: "hello" }] };

describe("Kilo anonymous direct transport", () => {
  it("requires an installed-client authority and pins URL, path, headers, and redirects", async () => {
    expect(createProviderAdapterById("kilo-free-direct")).toBeUndefined();
    let url = "";
    let init: RequestInit | undefined;
    const fetchFn = (async (target: string, options: RequestInit) => {
      url = target; init = options;
      return new Response(JSON.stringify({ id: "1", model: "kilo-auto/free", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    const adapter = createKiloFreeDirectAdapter({ fetchFn });
    expect((await adapter.chat(request)).choices[0]?.message.content).toBe("ok");
    expect(url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string).model).toBe("kilo-auto/free");
  });

  it("ignores runtime properties outside the direct factory allowlist", async () => {
    let url = "";
    let headers: HeadersInit | undefined;
    const untrustedOptions = {
      anonymousFree: false,
      baseUrl: "https://unapproved.example",
      apiKey: "secret",
      defaultHeaders: { Authorization: "Bearer secret" },
      fetchFn: (async (target: string, options: RequestInit) => {
        url = target;
        headers = options.headers;
        return new Response(JSON.stringify({ id: "1", model: "kilo-auto/free", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
      }) as typeof fetch,
    };
    await createKiloFreeDirectAdapter(untrustedOptions).chat(request);
    expect(url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(headers).toEqual({ "Content-Type": "application/json" });
  });

  it("rejects credential, endpoint, and model substitution", async () => {
    expect(() => new OpenAICompatibleAdapter({ providerId: "kilo-free-direct", baseUrl: "http://api.kilo.ai/api/gateway", anonymousFree: true })).toThrow("ANONYMOUS_FREE_TRANSPORT_NOT_ALLOWLISTED");
    expect(() => new OpenAICompatibleAdapter({ providerId: "kilo-free-direct", baseUrl: "https://api.kilo.ai/api/gateway", anonymousFree: true, apiKey: "secret" })).toThrow("ANONYMOUS_FREE_TRANSPORT_NOT_ALLOWLISTED");
    for (const cfg of [
      { baseUrl: "https://unapproved.example/api/gateway" },
      { baseUrl: "https://api.kilo.ai/api/gateway/arbitrary" },
      { modelsPath: "/arbitrary" },
      { defaultHeaders: { "X-CodeForge-Token": "secret-control-token" } },
      { authHeader: () => ({ Authorization: "Bearer secret" }) },
    ]) expect(() => new OpenAICompatibleAdapter({ providerId: "kilo-free-direct", baseUrl: "https://api.kilo.ai/api/gateway", anonymousFree: true, ...cfg })).toThrow("ANONYMOUS_FREE_TRANSPORT_NOT_ALLOWLISTED");
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => { throw new Error("should not fetch"); }) as typeof fetch });
    await expect(adapter.chat({ ...request, model: "anthropic/claude-opus" })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
  });

  it("never follows an upstream redirect", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })) as typeof fetch });
    await expect(adapter.chat(request)).rejects.toBeDefined();
  });

  it("stages only zero-price catalog models and Auto Free", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => new Response(JSON.stringify({ data: [
      { id: "kilo-auto/free", pricing: { prompt: "0", completion: "0" } },
      { id: "lab/zero:free", pricing: { prompt: "0", completion: "0" } },
      { id: "lab/paid:free", pricing: { prompt: "0.1", completion: "0" } },
      { id: "lab/paid", pricing: { prompt: "1", completion: "1" } },
      { id: "lab/null:free", pricing: { prompt: null, completion: null } },
      { id: "lab/blank:free", pricing: { prompt: "", completion: " " } },
      { id: "lab/no-price:free", pricing: null },
    ] }), { status: 200 })) as typeof fetch });
    expect((await adapter.listModels()).map((m) => m.modelId)).toEqual(["kilo-auto/free", "lab/zero:free"]);
  });
});

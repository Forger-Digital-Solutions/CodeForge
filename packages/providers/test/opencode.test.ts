import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OpencodeAdapter, ProviderError } from "../src/opencode.js";
import type { ChatRequest } from "../src/chat-types.js";

function mockFetchOnce(response: { ok: boolean; status: number; body: unknown; headers?: Record<string, string> }) {
  const mock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    headers: new Headers(response.headers ?? {}),
    text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    json: async () => (typeof response.body === "string" ? JSON.parse(response.body) : response.body),
    body: null,
  } as unknown as Response));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchSSE(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const mock = vi.fn(async () => ({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "text/event-stream" }),
    text: async () => chunks.join(""),
    json: async () => JSON.parse(chunks.join("")),
    body: stream,
  } as unknown as Response));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const baseUrl = "https://opencode.ai/zen/v1";

function createAdapter(apiKey = "test-opencode-key", url = baseUrl) {
  const store = {
    get: (id: string) => (id === "opencode" ? apiKey : undefined),
    set: () => {},
    delete: () => false,
    has: (id: string) => id === "opencode" && !!apiKey,
  };
  return new OpencodeAdapter({ credentialStore: store as never, baseUrl: url, timeoutMs: 5000 });
}

describe("OpencodeAdapter", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("has correct providerId and baseUrl", () => {
    const adapter = createAdapter();
    expect(adapter.providerId).toBe("opencode");
  });

  it("throws MISSING_API_KEY when credential absent", async () => {
    const adapter = createAdapter("");
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      code: "MISSING_API_KEY",
    });
    await expect(adapter.listModels()).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });

  it("listModels uses correct endpoint and auth header and parses free detection via known set", async () => {
    const adapter = createAdapter();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        object: "list",
        data: [
          { id: "muse-spark-1.2-contributor-free", object: "model", created: 1, owned_by: "opencode" },
          { id: "muse-spark-1.2", object: "model", created: 1, owned_by: "opencode" },
          { id: "big-pickle", object: "model", created: 1, owned_by: "opencode" },
          { id: "deepseek-v4-pro", object: "model", created: 1, owned_by: "opencode" },
        ],
      },
    });
    const models = await adapter.listModels();
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/models`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-opencode-key" }) }),
    );
    const free = models.find((m) => m.modelId === "muse-spark-1.2-contributor-free");
    expect(free?.isFree).toBe(true);
    expect(free?.freeStatus).toBe("verified_free");
    const paid = models.find((m) => m.modelId === "muse-spark-1.2");
    expect(paid?.isFree).toBe(false);
    expect(paid?.freeStatus).toBe("paid");
    const bigPickle = models.find((m) => m.modelId === "big-pickle");
    expect(bigPickle?.isFree).toBe(true);
    const deepseek = models.find((m) => m.modelId === "deepseek-v4-pro");
    expect(deepseek?.isFree).toBe(false);
  });

  it("listModels respects pricing 0/0 when present", async () => {
    const adapter = createAdapter();
    mockFetchOnce({
      ok: true,
      status: 200,
      body: { data: [{ id: "custom-free", pricing: { prompt: "0", completion: "0" } }] },
    });
    const models = await adapter.listModels();
    expect(models[0]?.isFree).toBe(true);
  });

  it("chat for muse-spark uses /responses endpoint with correct auth and model id", async () => {
    const adapter = createAdapter();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        id: "resp_123",
        model: "muse-spark-1.2-contributor-free",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "CODEFORGE_MUSE_OK" }] }],
        usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
      },
    });
    const req: ChatRequest = {
      model: "muse-spark-1.2-contributor-free",
      messages: [{ role: "user", content: "Return exactly: CODEFORGE_MUSE_OK" }],
    };
    const res = await adapter.chat(req);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/responses`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-opencode-key", "Content-Type": "application/json" }),
      }),
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(sentBody.model).toBe("muse-spark-1.2-contributor-free");
    expect(sentBody.input).toBeDefined();
    expect(res.model).toBe("muse-spark-1.2-contributor-free");
    expect(res.choices[0]?.message.content).toBe("CODEFORGE_MUSE_OK");
    expect(res.usage?.inputTokens).toBe(5);
    expect(res.choices[0]?.message.role).toBe("assistant");
  });

  it("chat for generic model uses /chat/completions endpoint", async () => {
    const adapter = createAdapter();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl_1",
        model: "deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    });
    await adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/chat/completions`,
      expect.objectContaining({ method: "POST" }),
    );
    const sent = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(sent.model).toBe("deepseek-v4-flash");
    expect(sent.messages).toBeDefined();
  });

  it("chat sends correct request body with system and tools", async () => {
    const adapter = createAdapter();
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        id: "resp_1",
        model: "muse-spark-1.2-contributor-free",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    await adapter.chat({
      model: "muse-spark-1.2-contributor-free",
      system: "You are helpful",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      maxTokens: 100,
      tools: [{ type: "function", function: { name: "my_tool", description: "desc", parameters: { type: "object", properties: {} } } }],
    });
    const sent = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(sent.instructions).toBe("You are helpful");
    expect(sent.temperature).toBe(0.7);
    expect(sent.model).toBe("muse-spark-1.2-contributor-free");
  });

  it("chat response parsing preserves normal CodeForge provider response type", async () => {
    const adapter = createAdapter();
    mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl_x",
        model: "deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "parsed content" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    });
    const res = await adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
    expect(res.id).toBe("chatcmpl_x");
    expect(res.choices[0]?.message.content).toBe("parsed content");
    expect(res.choices[0]?.finishReason).toBe("stop");
    expect(res.usage?.totalTokens).toBe(30);
  });

  it("chat handles model mismatch as failure (no silent paid fallback)", async () => {
    const adapter = createAdapter();
    mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        id: "resp_1",
        model: "muse-spark-1.2",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "wrong model" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      code: "MODEL_MISMATCH",
    });
  });

  it("chat HTTP error handling maps 401/402/404/429/503 correctly", async () => {
    const adapter = createAdapter();
    mockFetchOnce({ ok: false, status: 401, body: '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}' });
    await expect(adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "AUTH_ERROR" });

    mockFetchOnce({ ok: false, status: 402, body: "payment required" });
    await expect(adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    mockFetchOnce({ ok: false, status: 404, body: "not found" });
    await expect(adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });

    mockFetchOnce({ ok: false, status: 429, body: "rate limited" });
    await expect(adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "RATE_LIMITED" });

    mockFetchOnce({ ok: false, status: 503, body: "overloaded" });
    await expect(adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MODEL_OVERLOADED" });

    mockFetchOnce({ ok: false, status: 500, body: "internal" });
    await expect(adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("healthCheck returns offline on failure and available on success", async () => {
    const adapter = createAdapter();
    mockFetchOnce({ ok: true, status: 200, body: { object: "list", data: [] } });
    expect((await adapter.healthCheck()).status).toBe("available");

    mockFetchOnce({ ok: false, status: 500, body: "error" });
    expect((await adapter.healthCheck()).status).toBe("offline");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect((await adapter.healthCheck()).status).toBe("offline");
  });

  it("streamChat yields text_delta and finish for chat/completions", async () => {
    const adapter = createAdapter();
    const sse = ['data: {"choices":[{"delta":{"content":"hello "}}]}\n', 'data: {"choices":[{"delta":{"content":"world"}}]}\n', "data: [DONE]\n"];
    mockFetchSSE(sse);
    const events = [];
    for await (const e of adapter.streamChat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "finish")).toBe(true);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe("hello world");
  });

  it("streamChat for responses endpoint yields deltas", async () => {
    const adapter = createAdapter();
    const sse = ['data: {"type":"response.output_text.delta","delta":"resp "}\n', 'data: {"type":"response.output_text.delta","delta":"ok"}\n', "data: [DONE]\n"];
    mockFetchSSE(sse);
    const events = [];
    for await (const e of adapter.streamChat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("provider unavailable propagates via healthCheck offline", async () => {
    const adapter = createAdapter();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unreachable"); }));
    const health = await adapter.healthCheck();
    expect(health.status).toBe("offline");
  });

  it("adapter discovery does not grant ForgeZero authority — suffix alone is not free", async () => {
    const adapter = createAdapter();
    mockFetchOnce({
      ok: true,
      status: 200,
      body: {
        object: "list",
        data: [
          { id: "evil-free", object: "model", created: 1, owned_by: "opencode" },
          { id: "muse-spark-1.2-contributor-free", object: "model", created: 1, owned_by: "opencode" },
        ],
      },
    });
    const models = await adapter.listModels();
    const evil = models.find((m) => m.modelId === "evil-free");
    // evil-free is NOT in KNOWN_FREE_MODEL_IDS and has no pricing 0/0, so must be classified as paid (discovery heuristic alone insufficient)
    expect(evil?.isFree).toBe(false);
    expect(evil?.freeStatus).toBe("paid");
    const muse = models.find((m) => m.modelId === "muse-spark-1.2-contributor-free");
    expect(muse?.isFree).toBe(true);
  });

  it("healthCheck uses GET not HEAD", async () => {
    const adapter = createAdapter();
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { object: "list", data: [] } });
    await adapter.healthCheck();
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/models`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});

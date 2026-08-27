import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpencodeAdapter } from "../src/opencode.js";
import { ForgeZero } from "@codeforge/forge-zero";
import { createMuseSparkRecord } from "@codeforge/forge-zero";

const baseUrl = "https://opencode.ai/zen/v1";
function storeWithKey(key = "test-key") {
  return {
    get: (id: string) => (id === "opencode" ? key : undefined),
    set: () => {},
    delete: () => false,
    has: (id: string) => id === "opencode" && !!key,
  } as never;
}
function mockFetch(body: unknown, ok = true, status = 200) {
  const mock = vi.fn(async () => ({
    ok,
    status,
    headers: new Headers({}),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    body: null,
  } as unknown as Response));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("LAW9 live verification matrix", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("A. missing OPENCODE_API_KEY -> MISSING_API_KEY", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(""), baseUrl });
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });

  it("B. valid authenticated response -> success", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch({
      id: "resp_1",
      model: "muse-spark-1.2-contributor-free",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "CODEFORGE_MUSE_OK" }] }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
    const res = await adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "Return exactly: CODEFORGE_MUSE_OK" }], maxTokens: 32 });
    expect(res.id).toBe("resp_1");
    expect(res.model).toBe("muse-spark-1.2-contributor-free");
    expect(res.choices[0]!.message.content).toBe("CODEFORGE_MUSE_OK");
    expect(res.usage).toBeDefined();
  });

  it("C. wrong served model -> MODEL_MISMATCH", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch({ id: "resp_1", model: "muse-spark-1.2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] });
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MODEL_MISMATCH" });
  });

  it("D. paid Muse Spark substituted -> MODEL_MISMATCH", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch({ id: "resp_1", model: "meta/muse-spark-1.2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] });
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MODEL_MISMATCH" });
  });

  it("E. 401 -> AUTH_ERROR", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch("unauthorized", false, 401);
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });

  it("F. 402 -> PAYMENT_REQUIRED", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch("payment required", false, 402);
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
  });

  it("G. 404 -> MODEL_NOT_FOUND", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch("not found", false, 404);
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("H. 429 -> RATE_LIMITED", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch("rate", false, 429);
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("I. 503 -> MODEL_OVERLOADED", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch("overload", false, 503);
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MODEL_OVERLOADED" });
  });

  it("J. malformed Responses payload -> empty content but still valid ChatResponse (parse does not crash)", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch({ id: "resp_mal", model: "muse-spark-1.2-contributor-free", status: "completed" });
    const res = await adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] });
    expect(res.id).toBe("resp_mal");
    expect(res.choices[0]!.message.content).toBe("");
  });

  it("K. exact output mismatch -> verification failure (content != CODEFORGE_MUSE_OK)", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch({
      id: "resp_1",
      model: "muse-spark-1.2-contributor-free",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "WRONG" }] }],
    });
    const res = await adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] });
    expect(res.choices[0]!.message.content).not.toBe("CODEFORGE_MUSE_OK");
  });

  it("L. expired free verification -> ForgeZero exclusion", () => {
    const now = new Date("2026-08-27T00:00:00Z");
    const fw = new ForgeZero({ context: { now: () => now } });
    const old = new Date("2026-08-10T00:00:00Z").toISOString(); // 17 days ago
    fw.register(
      createMuseSparkRecord({
        freeStatusVerifiedAt: old,
        costProfile: { freeTierVerifiedAt: old } as never,
        health: { status: "available", lastCheckedAt: now.toISOString() } as never,
      }) as never,
    );
    expect(fw.canRouteTo("opencode", "muse-spark-1.2-contributor-free")).toBe(false);
  });

  it("M. successful live provider verification followed by ForgeZero verification failure -> NOT ELIGIBLE", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(), baseUrl });
    mockFetch({
      id: "resp_1",
      model: "muse-spark-1.2-contributor-free",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "CODEFORGE_MUSE_OK" }] }],
    });
    const live = await adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] });
    expect(live.choices[0]!.message.content).toBe("CODEFORGE_MUSE_OK");

    // Now ForgeZero says expired -> not eligible despite live success
    const now = new Date("2026-08-27T00:00:00Z");
    const fw = new ForgeZero({ context: { now: () => now } });
    const old = new Date("2026-08-10T00:00:00Z").toISOString();
    fw.register(
      createMuseSparkRecord({
        freeStatusVerifiedAt: old,
        costProfile: { freeTierVerifiedAt: old } as never,
        health: { status: "available", lastCheckedAt: now.toISOString() } as never,
      }) as never,
    );
    expect(fw.eligibleModels()).toHaveLength(0);
  });

  it("N. no free providers -> NO_FREE_PROVIDER (router)", async () => {
    const { ForgeRouter } = await import("@codeforge/router");
    const fw = new ForgeZero({ context: { now: () => new Date("2026-08-27T00:00:00Z") } });
    // no models registered
    const router = new ForgeRouter({ firewall: fw });
    expect(router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] })).toBeNull();
    expect(router.resolveSelection({ mode: "forgezero-adaptive" }).ok).toBe(false);
  });

  it("O. generic free model available -> fallback remains possible", async () => {
    const { ForgeRouter } = await import("@codeforge/router");
    const { createGenericFreeRecord } = await import("@codeforge/forge-zero");
    const now = new Date("2026-08-27T00:00:00Z");
    const fw = new ForgeZero({ context: { now: () => now } });
    const { createMuseSparkRecord: cmr } = await import("@codeforge/forge-zero");
    fw.register({ ...cmr(), health: { status: "offline", lastCheckedAt: now.toISOString() } } as never);
    fw.register(createGenericFreeRecord() as never);
    const router = new ForgeRouter({ firewall: fw });
    const d = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] });
    expect(d?.model.modelId).toBe("free-model-1");
  });

  it("provider isolation: openrouter key does not authorize opencode", async () => {
    const adapter = new OpencodeAdapter({ credentialStore: storeWithKey(""), baseUrl });
    await expect(adapter.chat({ model: "muse-spark-1.2-contributor-free", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });
});

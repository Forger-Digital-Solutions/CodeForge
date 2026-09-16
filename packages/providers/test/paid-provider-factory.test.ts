import { describe, expect, it, vi } from "vitest";
import { createAlibabaAdapter, createDeepSeekAdapter } from "../src/provider-factory.js";
import type { CredentialStore } from "../src/index.js";

const credentials: CredentialStore = {
  get: (id) => id === "DASHSCOPE_API_KEY" ? "dashscope-key" : id === "deepseek" ? "deepseek-key" : undefined,
  set: () => undefined,
  delete: () => false,
  has: (id) => id === "DASHSCOPE_API_KEY" || id === "deepseek",
};

function response(): Response {
  return new Response(JSON.stringify({ id: "response-1", model: "test", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Paid Auto direct provider factories", () => {
  it("uses Alibaba Model Studio's global compatible endpoint and DashScope key alias", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response());
    const adapter = createAlibabaAdapter({ credentialStore: credentials, fetchFn });
    await adapter.chat({ model: "qwen3.8-flash", messages: [{ role: "user", content: "mock" }] });
    expect(fetchFn).toHaveBeenCalledWith("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body as string).model).toBe("qwen3.8-flash");
  });

  it("uses DeepSeek's direct endpoint and preserves the V4.1 Flash API alias", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response());
    const adapter = createDeepSeekAdapter({ credentialStore: credentials, fetchFn });
    await adapter.chat({ model: "deepseek-flash", messages: [{ role: "user", content: "mock" }] });
    expect(fetchFn).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body as string).model).toBe("deepseek-flash");
  });
});

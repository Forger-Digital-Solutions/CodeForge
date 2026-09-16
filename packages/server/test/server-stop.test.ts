import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { InMemoryProviderCatalog, type ProviderAdapter } from "@codeforge/providers";

describe("CodeForgeServer shutdown", () => {
  it("cancels and drains an active agent turn before closing session persistence", async () => {
    const catalog = new InMemoryProviderCatalog();
    let started = false;
    const provider: ProviderAdapter = {
      providerId: "codeforge",
      listModels: async () => [],
      chat: async () => { throw new Error("Use streamChat"); },
      streamChat: async function* (_request, signal) {
        started = true;
        yield { type: "text_delta", delta: "Working" };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      healthCheck: async () => ({ status: "available" }),
    };
    catalog.register(provider);
    const server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true });
    await server.start();
    const runtime = (server as unknown as { getOrCreateRuntime(sessionId: string): { startTurn(message: string): Promise<string>; getTurn(turnId: string): { status: string } | undefined } }).getOrCreateRuntime("shutdown-active");
    const turnId = await runtime.startTurn("Wait for shutdown");

    for (let attempt = 0; attempt < 50 && !started; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(true);

    await server.stop();
    expect(runtime.getTurn(turnId)?.status).toBe("cancelled");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { CodeForgeServer } from "../src/index.js";
import { InMemoryProviderCatalog, type ProviderAdapter } from "@codeforge/providers";

// A minimal REAL (non-test) provider adapter — isTestProvider is undefined, so it flips the
// server into real runtime the moment it is registered.
const fakeRealAdapter: ProviderAdapter = {
  providerId: "openrouter",
  async listModels() { return []; },
  async chat() { return { id: "1", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "" } }] }; },
  async *streamChat() { yield { type: "finish", finishReason: "stop" as const }; },
  async healthCheck() { return { status: "available" as const }; },
};

async function send(port: number, message: string): Promise<{ mode?: string }> {
  const res = await fetch(`http://localhost:${port}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "default", message, turnId: crypto.randomUUID() }),
  });
  return res.json();
}

let server: CodeForgeServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

describe("dynamic real/demo runtime (connect-after-boot first-run fix)", () => {
  it("routes to demo before any real provider, and flips to real once one is registered post-boot", async () => {
    const catalog = new InMemoryProviderCatalog();
    server = new CodeForgeServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog });
    await server.start();
    const port = server.httpPort;

    // Fresh boot, no provider connected → demo (no silent paid/real inference).
    expect((await send(port, "hi")).mode).toBe("demo");

    // Provider connected AFTER boot (the normal first-run flow) → next send is real,
    // without a server restart.
    catalog.register(fakeRealAdapter);
    expect((await send(port, "hi again")).mode).toBe("real");
  });

  it("explicit useRealRuntime stays real even with no provider yet", async () => {
    server = new CodeForgeServer({ port: 0, dbPath: ":memory:", useRealRuntime: true, providerCatalog: new InMemoryProviderCatalog() });
    await server.start();
    expect((await send(server.httpPort, "hi")).mode).toBe("real");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { ForgeZero, createGenericFreeRecord, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";

/**
 * An explicitly selected route that the provider's own catalog marks as not tool-capable cannot
 * execute a turn (the loop drives tools natively). The runtime must say so before spending a
 * request — not fail a turn later with an opaque provider error.
 */
async function post(port: number, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://localhost:${port}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function noToolsRoute(): FreeModelRecord {
  const base = createGenericFreeRecord();
  return {
    ...base,
    providerId: "codeforge",
    modelId: "music/no-tools:free",
    displayName: "Music (free, no tools)",
    capabilities: { ...base.capabilities, toolCalling: false },
  };
}

describe("explicit selection of a route without tool calling", () => {
  let ws: string;
  let server: any;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-no-tools-"));
  });
  afterEach(async () => {
    if (server) await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  it("fails the turn closed with an actionable message and no provider call", async () => {
    let providerCalls = 0;
    const catalog = new InMemoryProviderCatalog();
    catalog.register({
      providerId: "codeforge",
      displayName: "Mock Provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord(), noToolsRoute()],
      streamChat: () => (async function* () { providerCalls += 1; yield { type: "finish", finishReason: "stop" as const }; })(),
    } as any);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
    firewall.register(noToolsRoute());
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, firewall, useRealRuntime: true } as any);
    await server.start();
    const port = server.httpPort;
    server.setWorkspace(ws);

    const selected = await post(port, "/api/model-selection", { sessionId: "pin", providerId: "codeforge", modelId: "music/no-tools:free" });
    expect(selected.status).toBe(200);

    const started = await post(port, "/api/send", { sessionId: "pin", message: "Refactor the service", executionMode: "chat" });
    expect(started.status).toBe(200);
    const events = () => (server as any).eventStore.getBySession("pin") as Array<{ type: string; payload: any }>;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !events().some((e) => e.type === "turn.failed" || e.type === "turn.completed")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failed = events().find((e) => e.type === "turn.failed");
    expect(failed, JSON.stringify(events().map((e) => e.type))).toBeDefined();
    expect(failed!.payload.error).toMatch(/does not support tool calling/);
    expect(providerCalls).toBe(0);
  });
});

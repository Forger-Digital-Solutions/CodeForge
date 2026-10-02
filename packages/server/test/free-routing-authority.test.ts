import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ProviderAdapter } from "@codeforge/providers";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { ModelExecutionAdapter } from "../src/model-execution-adapter.js";
import { createAgentRuntime } from "../src/agent-runtime.js";

const temporaryPaths: string[] = [];
afterEach(async () => { for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true }); });

function fixture() {
  let calls = 0;
  const provider: ProviderAdapter = {
    providerId: "authority-canary", isTestProvider: false,
    async listModels() { return []; }, async healthCheck() { return { status: "available" }; },
    async chat() { calls++; throw new Error("UNADMITTED_PROVIDER_REACHED"); },
    async *streamChat() { calls++; throw new Error("UNADMITTED_PROVIDER_REACHED"); },
  };
  const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
  const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "free-canary" }));
  return { catalog, firewall, calls: () => calls };
}

describe("production Free dispatch authority canary", () => {
  it.each(["automatic", "exact", "stream"])("%s model execution cannot reach a provider without Fabric authority", async (mode) => {
    const f = fixture(); const adapter = new ModelExecutionAdapter(f.catalog, f.firewall);
    const request = { messages: [{ role: "user" as const, content: "canary" }], ...(mode === "automatic" ? {} : { modelSelection: { providerId: "authority-canary", modelId: "free-canary" } }) };
    const execute = async () => { if (mode === "stream") { for await (const event of adapter.streamExecution(request)) void event; } else await adapter.execute(request); };
    await expect(execute()).rejects.toThrow("FREE_FABRIC_AUTHORITY_REQUIRED");
    expect(f.calls()).toBe(0);
  });

  it.each([false, true])("role runtime with exact pin=%s refuses catalog-only Free admission", async (exact) => {
    const f = fixture(); const persistence = createSessionPersistence();
    const workspace = await mkdtemp(join(tmpdir(), "r63-authority-canary-")); temporaryPaths.push(workspace);
    try {
      const runtime = createAgentRuntime({ sessionId: "r63-canary", eventStore: new EventStore(), persistence, firewall: f.firewall, providerCatalog: f.catalog, workspacePath: workspace });
      const result = await runtime.executeAgentRun({ runId: "r63-role", agentId: "explorer", role: "explorer", goal: "Inspect workspace", workspaceId: "workspace", workspacePath: workspace,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, roleRouting: true,
        ...(exact ? { modelSelection: { providerId: "authority-canary", modelId: "free-canary" } } : {}) });
      expect(result.status).toBe("failed"); expect(f.calls()).toBe(0);
    } finally { await persistence.close(); }
  });
});

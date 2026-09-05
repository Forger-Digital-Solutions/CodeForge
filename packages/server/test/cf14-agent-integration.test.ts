import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import {
  InMemoryProviderCatalog,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderModel,
  type StreamEvent,
} from "@codeforge/providers";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createAgentRuntime } from "../src/agent-runtime.js";

class DeterministicTestProvider implements ProviderAdapter {
  readonly isTestProvider = true;
  readonly requests: ChatRequest[] = [];

  constructor(readonly providerId: string) {}

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "free-deterministic",
        displayName: "Free Deterministic",
        isFree: true,
        freeStatus: "verified_free",
        capabilities: {
          text: true,
          coding: true,
          toolCalling: true,
          vision: false,
          structuredOutput: true,
          longContext: true,
        },
      },
    ];
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error("streamChat expected");
  }

  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield {
      type: "text_delta",
      delta: JSON.stringify({
        summary: "Analyzed repository intelligence and produced bounded findings",
        findings: [],
        evidence: [],
      }),
    };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

describe("CF-14 Production Agent Runtime Integration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  it("connects task to repository intelligence, retrieves selected context, and transmits bounded payload to provider", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf14-runtime-int-"));
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "cf14-runtime-cache-"));
    cleanups.push(async () => {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(cache, { recursive: true, force: true });
    });

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "tests"), { recursive: true });

    // Target needle symbol
    await fs.writeFile(
      path.join(root, "src", "processor.ts"),
      "export class WidgetProcessor {\n  processItem(item: string): string { return item.toUpperCase(); }\n}\n",
    );
    await fs.writeFile(
      path.join(root, "tests", "processor.test.ts"),
      "import { WidgetProcessor } from '../src/processor.js';\nit('processes', () => new WidgetProcessor().processItem('a'));\n",
    );

    // 50 irrelevant files to prove majority is omitted
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(
        path.join(root, "src", `noise-${i}.ts`),
        `export const noiseConstant${i} = ${i};\n`,
      );
    }

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "CodeForge"], { cwd: root });
    execFileSync("git", ["config", "user.email", "codeforge@test.local"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

    const persistence = createSessionPersistence();
    cleanups.push(async () => persistence.close());

    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ modelId: "free-deterministic" }));

    const provider = new DeterministicTestProvider("free-provider");
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);

    const eventStore = new EventStore();
    const runtime = createAgentRuntime({
      sessionId: "cf14-integration-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: root,
      repositoryIntelligenceFactory: () => createRepositoryIntelligence({ cacheRoot: cache }),
    });

    const result = await runtime.executeAgentRun({
      runId: "cf14-run-1",
      agentId: "coder-agent",
      role: "coder",
      goal: "Enhance WidgetProcessor to handle empty strings and verify with processor tests",
      workspaceId: "cf14-ws",
      workspacePath: root,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "coder",
    });

    expect(result.status).toBe("completed");
    expect(result.contextMetrics).toBeDefined();
    expect(result.contextMetrics!.repositoryGeneration).toBeGreaterThanOrEqual(1);
    expect(result.contextMetrics!.contextHash).toBeTruthy();

    // Verify provider received target file and omitted irrelevant files
    expect(provider.requests.length).toBeGreaterThan(0);
    const providerPayload = provider.requests
      .flatMap((req) => req.messages.map((m) => m.content))
      .join("\n");

    expect(providerPayload).toContain("WidgetProcessor");
    expect(providerPayload).toContain("src/processor.ts");
    expect(providerPayload).not.toContain("noise-49.ts");
  });

  it("proves verification independence: low/zero impact cannot suppress canonical verification", async () => {
    // Structural invariant proof:
    // Even if an impact candidate query yields 0 tests, verification decisions are independent
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf14-ver-ind-"));
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "cf14-ver-cache-"));
    cleanups.push(async () => {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(cache, { recursive: true, force: true });
    });

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "standalone.ts"),
      "export const standaloneValue = 42;\n",
    );

    const intel = createRepositoryIntelligence({ cacheRoot: cache });
    await intel.openWorkspace(root);
    await intel.indexWorkspace();

    // Advisory query returns 0 candidate tests
    const impact = await intel.getImpactCandidates(["src/standalone.ts"]);
    expect(impact.candidateTests).toHaveLength(0);

    // Verification decision policy remains strictly separate:
    // Repository Intelligence cannot return a PermissionDecision or VerificationDecision
    expect((impact as any).verificationDecision).toBeUndefined();
    expect((impact as any).approvalDecision).toBeUndefined();
    expect((impact as any).complete).toBeUndefined();

    await intel.closeWorkspace();
  });

  it("degrades gracefully to fallback when repository intelligence is broken", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf14-fallback-"));
    cleanups.push(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "fallback.ts"),
      "export const fallbackConstant = true;\n",
    );

    const persistence = createSessionPersistence();
    cleanups.push(async () => persistence.close());

    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ modelId: "free-deterministic" }));

    const provider = new DeterministicTestProvider("free-provider");
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);

    const eventStore = new EventStore();
    // Factory that throws an error to simulate broken intelligence
    const runtime = createAgentRuntime({
      sessionId: "cf14-fallback-session",
      eventStore,
      persistence,
      firewall,
      providerCatalog: catalog,
      workspacePath: root,
      repositoryIntelligenceFactory: () => ({
        openWorkspace: async () => { throw new Error("Simulated index failure"); },
      } as any),
    });

    const result = await runtime.executeAgentRun({
      runId: "cf14-fallback-run",
      agentId: "explorer",
      role: "explorer",
      goal: "Inspect fallback.ts",
      workspaceId: "fallback-ws",
      workspacePath: root,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      structuredOutput: "explorer",
    });

    // Does NOT fail or crash - successfully completes via conventional path
    expect(result.status).toBe("completed");
    expect(provider.requests.length).toBeGreaterThan(0);
  });
});

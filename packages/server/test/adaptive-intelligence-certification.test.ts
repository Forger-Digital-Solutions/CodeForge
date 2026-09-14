import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createCustomAutoStore, assertTrustDomain, TrustDomainViolationError } from "@codeforge/custom-auto";
import { selectForgeAutoTeam, classifyTask, NO_ELIGIBLE_FREE_MODEL } from "@codeforge/forge-auto";
import { createAgentRuntime } from "../src/agent-runtime.js";

class MockUserByokProvider implements ProviderAdapter {
  readonly providerId = "user-byok-groq";
  readonly isTestProvider = true;
  callCount = 0;
  receivedRequests: ChatRequest[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "llama-3.3-70b-versatile",
        displayName: "Llama 3.3 70B (User BYOK)",
        isFree: true,
        freeStatus: "verified_free",
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      },
    ];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    this.receivedRequests.push(req);
    yield { type: "text_delta", delta: "Execution completed by User BYOK model." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

class MockReviewerProvider implements ProviderAdapter {
  readonly providerId = "user-byok-reviewer";
  readonly isTestProvider = true;
  callCount = 0;

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "deepseek-r1",
        displayName: "DeepSeek R1 (Reviewer)",
        isFree: true,
        freeStatus: "verified_free",
        capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: true, longContext: true },
      },
    ];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    yield { type: "text_delta", delta: "Code review: verified clean, no regression detected." };
    yield { type: "finish", finishReason: "stop" };
  }

  async healthCheck() {
    return { status: "available" as const };
  }
}

async function waitForTerminal(
  runtime: ReturnType<typeof createAgentRuntime>,
  turnId: string,
) {
  for (let i = 0; i < 100; i++) {
    const state = runtime.getTurn(turnId);
    if (state?.status === "completed" || state?.status === "failed") return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  return runtime.getTurn(turnId);
}

describe("Adaptive Intelligence R1 Certification", () => {
  let tempDir: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let providerCatalog: InMemoryProviderCatalog;
  let userByokProvider: MockUserByokProvider;
  let reviewerProvider: MockReviewerProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-adaptive-cert-"));
    persistence = createSessionPersistence({ dbPath: path.join(tempDir, "test.sqlite") });
    eventStore = new EventStore();
    firewall = new ForgeZero();
    providerCatalog = new InMemoryProviderCatalog();

    userByokProvider = new MockUserByokProvider();
    reviewerProvider = new MockReviewerProvider();
    providerCatalog.register(userByokProvider);
    providerCatalog.register(reviewerProvider);
  });

  afterEach(async () => {
    try {
      await persistence.close();
    } catch {}
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("proves BYOK isolation: Forge Auto/Free fails closed when operator credentials are absent, NEVER stealing user BYOK keys", async () => {
    // Simulate user personal BYOK key present in environment
    const prevGroqKey = process.env.GROQ_API_KEY;
    const prevOperatorKey = process.env.CODEFORGE_GROQ_API_KEY;

    try {
      process.env.GROQ_API_KEY = "gsk_user_personal_secret_key_12345";
      delete process.env.CODEFORGE_GROQ_API_KEY;
      delete process.env.CODEFORGE_CLOUDFLARE_API_TOKEN;

      // Register generic free model
      firewall.register(createGenericFreeRecord());

      const runtime = createAgentRuntime({
        sessionId: "sess-isolation",
        persistence,
        eventStore,
        firewall,
        providerCatalog,
        workspacePath: tempDir,
      });

      // Execute turn in default Forge Auto / Free mode
      // Operator credentials are absent; Forge Auto MUST NOT use user BYOK keys and must fail closed
      const turnId = await runtime.startTurn("Implement a binary search function");
      const turn = await waitForTerminal(runtime, turnId);
      expect(turn?.status).toBe("failed");
      expect(turn?.error).toMatch(/No eligible free route/);

      // Verify that user BYOK provider was NEVER invoked
      expect(userByokProvider.callCount).toBe(0);
    } finally {
      if (prevGroqKey !== undefined) process.env.GROQ_API_KEY = prevGroqKey;
      else delete process.env.GROQ_API_KEY;
      if (prevOperatorKey !== undefined) process.env.CODEFORGE_GROQ_API_KEY = prevOperatorKey;
    }
  });

  it("verifies Custom AUTO allows user-configured BYOK models and executes multi-specialist team", async () => {
    const store = createCustomAutoStore(persistence);
    const profile = await store.create({
      id: "team-byok-custom",
      name: "Custom BYOK Team",
      description: "User BYOK Groq coder with DeepSeek Reviewer",
      roles: {
        coder: {
          providerId: userByokProvider.providerId,
          modelId: "llama-3.3-70b-versatile",
          displayName: "Llama 3.3 70B",
        },
        reviewer: {
          providerId: reviewerProvider.providerId,
          modelId: "deepseek-r1",
          displayName: "DeepSeek R1",
        },
      },
      mode: "pinned",
      verificationStrictness: "STANDARD",
    });

    expect(profile.trustDomain).toBe("USER_CUSTOM_AUTO");

    const runtime = createAgentRuntime({
      sessionId: "sess-custom-auto",
      persistence,
      eventStore,
      firewall,
      providerCatalog,
      workspacePath: tempDir,
    });

    // Select Custom AUTO profile
    runtime.setModelSelection({
      providerId: profile.roles.coder.providerId,
      modelId: profile.roles.coder.modelId,
      customAutoProfileId: profile.id,
      trustDomain: "USER_CUSTOM_AUTO",
      lock: "model",
    });

    const turnId = await runtime.startTurn("Write a unit test for math helpers");
    const turn = await waitForTerminal(runtime, turnId);

    expect(turn?.status).toBe("completed");

    // Both SWE Coder and Reviewer Specialist were executed
    expect(userByokProvider.callCount).toBe(1);
    expect(reviewerProvider.callCount).toBe(1);

    // Verify durable delegation record was created and saved
    const latestDelegation = runtime.getLatestDelegation();
    expect(latestDelegation).toBeDefined();
    expect(latestDelegation?.trustDomain).toBe("USER_CUSTOM_AUTO");
    expect(latestDelegation?.reviewResult?.performed).toBe(true);
    expect(latestDelegation?.specialists.length).toBe(2);

    // Verify work item persistence
    const workItems = await persistence.getWorkItems("sess-custom-auto");
    const delegationWorkItem = workItems.find((w) => w.kind === "forge_auto_delegation_record");
    expect(delegationWorkItem).toBeDefined();
  });

  it("enforces trust domain assertions across boundary violations", () => {
    expect(() => {
      assertTrustDomain("FORGE_AUTO_FREE", "USER_CUSTOM_AUTO", "Execution boundary check");
    }).toThrow(TrustDomainViolationError);

    expect(() => {
      assertTrustDomain("USER_CUSTOM_AUTO", "USER_CUSTOM_AUTO", "Valid Custom AUTO check");
    }).not.toThrow();
  });

  it("evaluates task classification and team sizing deterministically", () => {
    const featureClassification = classifyTask({
      goal: "Implement OAuth2 login with session persistence",
      changedFileScope: 5,
      repositoryFileCount: 200,
    });
    expect(featureClassification.kind).toBe("FEATURE");
    expect(featureClassification.specialistPlan.length).toBeGreaterThanOrEqual(2);
    expect(featureClassification.verificationBurden).toBe("STANDARD");

    const securityClassification = classifyTask({
      goal: "Fix security vulnerability prompt injection sanitization bypass",
      changedFileScope: 1,
      repositoryFileCount: 200,
    });
    expect(securityClassification.kind).toBe("SECURITY");
    expect(securityClassification.risk).toBeGreaterThanOrEqual(70);
    expect(securityClassification.verificationBurden).toBe("EXTENSIVE");
  });
});

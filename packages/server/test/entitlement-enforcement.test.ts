import { describe, it, expect } from "vitest";
import { EventStore } from "@codeforge/sessions";
import {
  ForgeZero,
  createDevelopmentEntitlementProvider,
  createFailingEntitlementProvider,
} from "@codeforge/forge-zero";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { AgentRuntime, type TurnState } from "../src/agent-runtime.js";

function gemsModel(): FreeModelRecord {
  return {
    providerId: "codeforge",
    modelId: "topaz",
    displayName: "Topaz",
    freeStatus: "paid",
    tier: "gems_paid",
    contextWindow: 128000,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      longContext: true,
    },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: false,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "official",
    },
    isRemote: true,
    isCloudHosted: true,
  };
}

const stubPersistence = {
  appendEvent: () => {},
  upsertSession: () => {},
  upsertTurn: () => {},
  getSession: () => undefined,
  listSessions: () => [],
  getTurns: () => [],
  getWorkItems: () => [],
  getEvents: () => [],
  close: () => {},
} as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>;

function makeRuntime(options: { firewall: ForgeZero; userId?: string }): AgentRuntime {
  const providerCatalog = new InMemoryProviderCatalog();
  providerCatalog.register(createMockProvider({ providerId: "codeforge" }));
  return new AgentRuntime({
    sessionId: "entitlement-session",
    eventStore: new EventStore(),
    persistence: stubPersistence,
    firewall: options.firewall,
    providerCatalog,
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
  });
}

async function waitForTerminalState(runtime: AgentRuntime, turnId: string): Promise<TurnState> {
  for (let i = 0; i < 200; i++) {
    const state = runtime.getTurn(turnId);
    if (state && (state.status === "completed" || state.status === "failed")) {
      return state;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("turn did not reach a terminal state");
}

describe("Entitlement enforcement in the production turn path", () => {
  it("denies a free user selecting a GEMS paid model (REQUIRES_SUBSCRIPTION)", async () => {
    const fw = new ForgeZero({ entitlementProvider: createDevelopmentEntitlementProvider() });
    fw.register(gemsModel());
    const runtime = makeRuntime({ firewall: fw, userId: "free-user" });
    runtime.setModelSelection({ providerId: "codeforge", modelId: "topaz" });

    const turnId = await runtime.startTurn("use topaz");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.status).toBe("failed");
    expect(state.error).toContain("REQUIRES_SUBSCRIPTION");
  });

  it("allows a paid user selecting a GEMS model and completes the turn", async () => {
    const fw = new ForgeZero({ entitlementProvider: createDevelopmentEntitlementProvider() });
    fw.register(gemsModel());
    const runtime = makeRuntime({ firewall: fw, userId: "paid-user" });
    runtime.setModelSelection({ providerId: "codeforge", modelId: "topaz" });

    const turnId = await runtime.startTurn("use topaz");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.status).toBe("completed");
    expect(state.error).toBeUndefined();
  });

  it("allows a trial user selecting a GEMS model", async () => {
    const fw = new ForgeZero({ entitlementProvider: createDevelopmentEntitlementProvider() });
    fw.register(gemsModel());
    const runtime = makeRuntime({ firewall: fw, userId: "trial-user" });
    runtime.setModelSelection({ providerId: "codeforge", modelId: "topaz" });

    const turnId = await runtime.startTurn("trial run");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.status).toBe("completed");
  });

  it("fails closed when the entitlement service is unavailable", async () => {
    const fw = new ForgeZero({ entitlementProvider: createFailingEntitlementProvider() });
    fw.register(gemsModel());
    const runtime = makeRuntime({ firewall: fw, userId: "paid-user" });
    runtime.setModelSelection({ providerId: "codeforge", modelId: "topaz" });

    const turnId = await runtime.startTurn("paid user during outage");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.status).toBe("failed");
    expect(state.error).toContain("PROVIDER_UNAVAILABLE");
  });

  it("fails closed for an anonymous/unknown user selecting a GEMS model", async () => {
    const fw = new ForgeZero({ entitlementProvider: createDevelopmentEntitlementProvider() });
    fw.register(gemsModel());
    const runtime = makeRuntime({ firewall: fw });
    runtime.setModelSelection({ providerId: "codeforge", modelId: "topaz" });

    const turnId = await runtime.startTurn("anonymous");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/NOT_ENTITLED|REQUIRES_SUBSCRIPTION/);
  });

  it("never routes auto-selection to GEMS models even when registered", async () => {
    const fw = new ForgeZero({ entitlementProvider: createDevelopmentEntitlementProvider() });
    fw.register(gemsModel());
    const runtime = makeRuntime({ firewall: fw, userId: "free-user" });

    // No manual selection: auto-routing must pick nothing (only a paid model exists)
    const turnId = await runtime.startTurn("auto route");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.modelId).toBeUndefined();
    expect(state.providerId).toBeUndefined();
  });

  it("free-tier turns work without any entitlement provider configured", async () => {
    const fw = new ForgeZero();
    fw.register({
      ...gemsModel(),
      modelId: "free-model-1",
      displayName: "CodeForge Free Model",
      freeStatus: "verified_free",
      tier: undefined,
      health: { status: "available", lastCheckedAt: new Date().toISOString() },
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        isFree: true,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "official",
      },
    });
    const runtime = makeRuntime({ firewall: fw, userId: "free-user" });

    const turnId = await runtime.startTurn("free path");
    const state = await waitForTerminalState(runtime, turnId);

    expect(state.status).toBe("completed");
    expect(state.modelId).toBe("free-model-1");
  });

  it("ForgeZero.checkEntitlement allows free models without an entitlement provider", async () => {
    const fw = new ForgeZero();
    const result = await fw.checkEntitlement("anyone", "unknown-provider", "some-free-model");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");

    const fwWithFree = new ForgeZero();
    fwWithFree.register({
      ...gemsModel(),
      modelId: "free-model-1",
      freeStatus: "verified_free",
      tier: undefined,
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        isFree: true,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "official",
      },
    });
    const allowed = await fwWithFree.checkEntitlement("anyone", "codeforge", "free-model-1");
    expect(allowed.ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import {
  classifyProviderFailure,
  nextDailyResetUtc,
  planFailureHealthMarking,
} from "../src/health-classify.js";
import type { FreeModelRecord } from "../src/types.js";
import type { VerifyContext } from "../src/verifier.js";

const NOW = new Date("2026-09-15T23:00:00Z");
let currentTime = new Date(NOW);

function eligibleModel(providerId: string, modelId: string): FreeModelRecord {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: NOW.toISOString(),
    isRemote: true,
    isCloudHosted: true,
    contextWindow: 128000,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      longContext: false,
    },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      cacheReadCostPerMillion: 0,
      cacheWriteCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: NOW.toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "test",
    },
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
  };
}

function buildFirewall(): ForgeZero {
  const ctx: VerifyContext = { now: () => new Date(currentTime) };
  const firewall = new ForgeZero({ context: ctx });
  firewall.register(eligibleModel("groq", "openai/gpt-oss-120b"));
  firewall.register(eligibleModel("groq", "openai/gpt-oss-20b"));
  firewall.register(eligibleModel("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b"));
  return firewall;
}

describe("classifyProviderFailure", () => {
  it("classifies a Groq TPD 429 body as model-scoped quota_exhausted until the daily reset", () => {
    const body =
      'groq error (429): Rate limit reached for model `openai/gpt-oss-120b` in organization org_x on tokens per day (TPD): Limit 200000, Used 199876. Please try again in 8m43s.';
    const c = classifyProviderFailure(body, NOW);
    expect(c).toBeDefined();
    expect(c!.scope).toBe("model");
    expect(c!.status).toBe("quota_exhausted");
    expect(c!.retryAfter).toBe(nextDailyResetUtc(NOW));
    expect(c!.retryAfter).toBeGreaterThan(NOW.getTime());
  });

  it("classifies Cloudflare neurons exhaustion as quota_exhausted", () => {
    const c = classifyProviderFailure("workers-ai error (429): daily neuron allocation exhausted", NOW);
    expect(c!.status).toBe("quota_exhausted");
    expect(c!.scope).toBe("model");
  });

  it("classifies a minute-level 429 as model-scoped rate_limited with bounded cooldown", () => {
    const c = classifyProviderFailure("groq error (429): Rate limit reached (TPM): Limit 8000, Used 7990", NOW);
    expect(c!.scope).toBe("model");
    expect(c!.status).toBe("rate_limited");
    expect(c!.retryAfter).toBe(NOW.getTime() + 60_000);
  });

  it("honors a parsed retry-after hint but caps the minute cooldown", () => {
    const c = classifyProviderFailure("error (429): Rate limit reached. Please try again in 5s.", NOW);
    expect(c!.retryAfter).toBe(NOW.getTime() + 5_000);
    const huge = classifyProviderFailure("error (429): Rate limit reached. Please try again in 3600s.", NOW);
    expect(huge!.retryAfter).toBe(NOW.getTime() + 15 * 60_000);
  });

  it("classifies auth failures as provider-scoped with no expiry", () => {
    const c = classifyProviderFailure("error (401): Invalid API key", NOW);
    expect(c!.scope).toBe("provider");
    expect(c!.status).toBe("auth_required");
  });

  it("classifies upstream 5xx as provider-scoped bounded degradation", () => {
    const c = classifyProviderFailure("OpenRouter stream error (502): Upstream error from Nvidia: Service temporarily overloaded", NOW);
    expect(c!.scope).toBe("provider");
    expect(c!.status).toBe("degraded");
    expect(c!.retryAfter).toBe(NOW.getTime() + 60_000);
  });

  it("returns undefined for unclassified errors (never guesses health)", () => {
    expect(classifyProviderFailure("context length exceeded", NOW)).toBeUndefined();
  });
});

describe("failure-scoped health marking (R3.6 window-1 cascade fix)", () => {
  it("a model-scoped TPD wall cools down ONLY the named model, not the provider", () => {
    const firewall = buildFirewall();
    const marking = planFailureHealthMarking(
      "groq",
      "openai/gpt-oss-120b",
      'groq error (429): Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199999.',
      NOW,
    );
    expect(marking!.scope).toBe("model");
    firewall.markModelHealth(marking!.providerId, marking!.modelId!, marking!.status, {
      retryAfter: marking!.retryAfter,
      lastError: marking!.reason,
    });

    const exhausted = firewall.verify("groq", "openai/gpt-oss-120b");
    expect(exhausted.ok).toBe(false);
    const sibling = firewall.verify("groq", "openai/gpt-oss-20b");
    expect(sibling.ok).toBe(true);
  });

  it("quota_exhausted routes auto-restore at the daily reset (§33) without manual re-discovery", () => {
    const firewall = buildFirewall();
    const reset = nextDailyResetUtc(NOW);
    firewall.markModelHealth("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b", "quota_exhausted", { retryAfter: reset });

    currentTime = new Date(reset - 1000);
    expect(firewall.verify("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b").ok).toBe(false);
    currentTime = new Date(reset + 1000);
    expect(firewall.verify("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b").ok).toBe(true);
  });

  it("quota_exhausted without a reset time stays excluded (fail closed)", () => {
    const firewall = buildFirewall();
    firewall.markModelHealth("groq", "openai/gpt-oss-20b", "quota_exhausted");
    currentTime = new Date("2027-01-01T00:00:00Z");
    expect(firewall.verify("groq", "openai/gpt-oss-20b").ok).toBe(false);
  });

  it("auth failures still cascade provider-wide (credential is organization-wide)", () => {
    const firewall = buildFirewall();
    const marking = planFailureHealthMarking("groq", "openai/gpt-oss-120b", "error (401): Invalid API key", NOW);
    firewall.markProviderHealth(marking!.providerId, marking!.status, { lastError: marking!.reason });
    expect(firewall.verify("groq", "openai/gpt-oss-120b").ok).toBe(false);
    expect(firewall.verify("groq", "openai/gpt-oss-20b").ok).toBe(false);
  });

  it("rate_limited remains excluded only until its cooldown elapses", () => {
    const firewall = buildFirewall();
    firewall.markModelHealth("groq", "openai/gpt-oss-20b", "rate_limited", { retryAfter: NOW.getTime() + 60_000 });
    expect(firewall.verify("groq", "openai/gpt-oss-20b").ok).toBe(false);
    currentTime = new Date(NOW.getTime() + 61_000);
    expect(firewall.verify("groq", "openai/gpt-oss-20b").ok).toBe(true);
  });
});

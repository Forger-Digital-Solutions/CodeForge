import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { CloudFirewallManager, GEMS_MODELS } from "@codeforge/cloud-gateway";
import { HostedProviderAdapter, type ProviderAdapter, type StreamEvent, type ChatRequest } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { loginToCloud, createMockGitHubFetch } from "./helpers/cloud-login.js";

/**
 * GEMS IDENTITY FIREWALL.
 *
 * GEMS models are CodeForge's own first-party capacity. A GEMS request must execute on GEMS or not
 * at all — it may never be aliased onto OpenRouter, Groq, OpenAI, Anthropic, Google, Cloudflare, or
 * any other provider, and no "compatible" or "equivalent" model may stand in for it. Serving a
 * different vendor's model under the GEMS name would misrepresent to the user whose model processed
 * their code, which is a correctness and trust failure, not a routing convenience.
 *
 * GEMS capacity is currently offline (no first-party inference backend). The required behavior is
 * therefore a clean, honest "GEMS unavailable" — never a silent fallback.
 */

/** Any provider that is NOT gems. If one of these is ever entered for a GEMS request, that is the bug. */
class ForeignProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  readonly received: Array<{ model: string }> = [];

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.received.push({ model: req.model });
    yield { type: "text_delta", delta: `SERVED_BY_${this.providerId}` };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat(req: ChatRequest) {
    this.received.push({ model: req.model });
    return { id: "1", model: req.model, choices: [], usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const FOREIGN_PROVIDER_IDS = ["openrouter", "groq", "openai", "anthropic", "google", "cloudflare-workers-ai", "zai", "opencode"];
const GEMS_MODEL_IDS = GEMS_MODELS.map((m) => m.modelId);

describe("GEMS identity firewall", () => {
  let server: CodeForgeCloudServer;
  let cloudUrl: string;
  let accessToken: string;
  let foreign: Map<string, ForeignProvider>;

  beforeEach(async () => {
    server = new CodeForgeCloudServer({
      db: new CloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: "gems-firewall-cert-jwt-secret-32-characters",
      fetchFn: createMockGitHubFetch({ id: 616161, login: "gems_user", name: "GEMS User" }),
    });

    // Register every plausible substitution target as a healthy, eligible, free provider. This makes
    // the environment maximally tempting: if any fallback path exists, one of these will be entered.
    foreign = new Map();
    for (const providerId of FOREIGN_PROVIDER_IDS) {
      server.firewallManager.registerModel(createGenericFreeRecord({ providerId, modelId: `${providerId}-free` }));
      const adapter = new ForeignProvider(providerId);
      foreign.set(providerId, adapter);
      server.firewallManager.registerProvider(adapter);
    }

    const port = await server.start(0);
    cloudUrl = `http://127.0.0.1:${port}`;
    accessToken = (await loginToCloud(cloudUrl)).accessToken;
  });

  afterEach(async () => {
    await server.stop();
  });

  function noForeignProviderRan(): void {
    for (const [providerId, adapter] of foreign) {
      expect(adapter.received, `provider '${providerId}' must not have executed a GEMS request`).toEqual([]);
    }
  }

  async function hostedRequest(body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${cloudUrl}/v1/hosted/inference`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), messages: [{ role: "user", content: "hi" }], ...body }),
    });
    return res.text();
  }

  it("reports GEMS unavailable for every GEMS model, and runs nothing else", async () => {
    for (const modelId of GEMS_MODEL_IDS) {
      const sse = await hostedRequest({ providerId: "gems", modelId });
      expect(sse, `GEMS model ${modelId}`).toContain("turn.failed");
      expect(sse).not.toContain("turn.completed");
      expect(sse).toMatch(/GEMS|unavailable|not currently available/i);
      expect(sse).not.toContain("SERVED_BY_");
    }
    noForeignProviderRan();
  });

  it("never routes a bare GEMS model id onto another provider", async () => {
    for (const modelId of GEMS_MODEL_IDS) {
      const sse = await hostedRequest({ modelId });
      expect(sse, `bare GEMS model ${modelId}`).toContain("turn.failed");
      expect(sse).not.toContain("SERVED_BY_");
    }
    noForeignProviderRan();
  });

  it("refuses hostile attempts to execute a GEMS model under a foreign provider id", async () => {
    for (const providerId of FOREIGN_PROVIDER_IDS) {
      for (const modelId of GEMS_MODEL_IDS.slice(0, 2)) {
        const sse = await hostedRequest({ providerId, modelId });
        expect(sse, `${providerId}::${modelId}`).toContain("turn.failed");
        expect(sse).not.toContain("SERVED_BY_");
      }
    }
    noForeignProviderRan();
  });

  it("refuses a foreign model claimed under the GEMS provider id", async () => {
    for (const providerId of FOREIGN_PROVIDER_IDS) {
      const sse = await hostedRequest({ providerId: "gems", modelId: `${providerId}-free` });
      expect(sse, `gems::${providerId}-free`).toContain("turn.failed");
      expect(sse).not.toContain("SERVED_BY_");
    }
    noForeignProviderRan();
  });

  it("never selects GEMS through Auto routing while GEMS is offline", async () => {
    // Auto must pick from verified-free capacity, and GEMS is paid-tier and offline.
    for (let i = 0; i < 8; i++) {
      const sse = await hostedRequest({ modelId: "auto" });
      expect(sse).toContain("turn.completed");
      expect(sse).not.toContain('"provider":"gems"');
    }
    // Auto legitimately used the foreign free pool — which is exactly what it is for.
    expect([...foreign.values()].some((a) => a.received.length > 0)).toBe(true);
  });

  it("excludes GEMS from routable Hosted Free capacity in the catalog", () => {
    const models = server.firewallManager.listHostedModels();
    const gems = models.filter((m) => m.providerId === "gems");

    expect(gems.length).toBe(GEMS_MODELS.length);
    for (const model of gems) {
      // Present in the catalog (so the UI can show it) but never routable as free capacity.
      expect(model.isEligibleFree).toBe(false);
      expect(model.accessClass).toBe("gems_paid");
      expect(model.availability).toBe("offline");
    }

    // ForgeZero's eligible pool — the set Auto can actually choose from — contains no GEMS at all.
    const eligible = server.firewallManager.firewall.eligibleModels();
    expect(eligible.some((m) => m.providerId === "gems")).toBe(false);
  });

  it("keeps GEMS unroutable even when a provider adapter registers itself under the gems id", async () => {
    // The strongest form of the attack: something claims to BE the GEMS backend.
    const impostor = new ForeignProvider("gems");
    server.firewallManager.registerProvider(impostor);

    for (const modelId of GEMS_MODEL_IDS) {
      const sse = await hostedRequest({ providerId: "gems", modelId });
      expect(sse, `impostor gems::${modelId}`).toContain("turn.failed");
      expect(sse).not.toContain("SERVED_BY_gems");
    }
    expect(impostor.received).toEqual([]);
    noForeignProviderRan();
  });

  it("holds the firewall through the desktop Hosted client, not just the raw HTTP boundary", async () => {
    const client = new HostedProviderAdapter({ cloudApiUrl: cloudUrl, getAccessToken: () => accessToken });

    for (const modelId of GEMS_MODEL_IDS.slice(0, 2)) {
      const consume = async () => {
        for await (const _ of client.streamChat({ model: `gems::${modelId}`, messages: [{ role: "user", content: "hi" }] } as never)) {
          /* drain */
        }
      };
      await expect(consume(), `client gems::${modelId}`).rejects.toThrow();
    }
    noForeignProviderRan();
  });

  it("keeps GEMS records marked paid and non-fallbackable in the shared catalog definition", () => {
    const manager = new CloudFirewallManager();
    for (const gems of GEMS_MODELS) {
      const record = manager.firewall.getModel("gems", gems.modelId);
      expect(record, `GEMS record ${gems.modelId}`).toBeDefined();
      expect(record!.tier).toBe("gems_paid");
      expect(record!.costProfile.isFree).toBe(false);
      // The explicit "do not fall back to a paid substitute" marker.
      expect(record!.costProfile.paidFallbackDisabled).toBe(true);
      expect(record!.costProfile.paidFallbackPossible).toBe(false);
      expect(record!.health?.status).toBe("offline");
    }
  });
});

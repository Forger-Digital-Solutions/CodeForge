import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { HostedProviderAdapter, type ProviderAdapter, type StreamEvent, type ChatRequest } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { loginToCloud, createMockGitHubFetch } from "./helpers/cloud-login.js";

/**
 * EXACT-MODEL CONTRACT, END TO END.
 *
 * When a user picks a specific model, CodeForge runs THAT model or fails. It never quietly serves a
 * different one, because "close enough" silently changes cost, capability, and licensing, and hides
 * capacity problems the user needs to see.
 *
 * The request is traced through every hop that could rewrite it:
 *
 *   renderer intent -> HostedProviderAdapter (IPC/client) -> Cloud HTTP boundary -> GatewayService
 *   -> ForgeZero verification -> provider adapter
 *
 * The provider adapter at the end records the model id it was actually asked for, so a substitution
 * anywhere in that chain is visible as a mismatch rather than as a passing test.
 */

/** Terminal adapter: records exactly what arrived, and streams back its own identity. */
class RecordingProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  readonly received: Array<{ model: string }> = [];

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.received.push({ model: req.model });
    yield { type: "text_delta", delta: `served:${this.providerId}::${req.model}` };
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

describe("Exact-model contract end to end", () => {
  let server: CodeForgeCloudServer;
  let cloudUrl: string;
  let alpha: RecordingProvider;
  let beta: RecordingProvider;
  let accessToken: string;

  const ALPHA_ID = "exact-alpha";
  const BETA_ID = "exact-beta";
  const ALPHA_MODEL = "alpha-precise-v1";
  const BETA_MODEL = "beta-precise-v1";

  beforeEach(async () => {
    server = new CodeForgeCloudServer({
      db: new CloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: "exact-model-contract-jwt-secret-32-chars",
      fetchFn: createMockGitHubFetch({ id: 707070, login: "exact_user", name: "Exact User" }),
    });

    // Two genuinely different, equally-eligible providers. If routing were allowed to "helpfully"
    // substitute, beta is exactly what it would substitute in — which is why both exist here.
    server.firewallManager.registerModel(createGenericFreeRecord({ providerId: ALPHA_ID, modelId: ALPHA_MODEL }));
    server.firewallManager.registerModel(createGenericFreeRecord({ providerId: BETA_ID, modelId: BETA_MODEL }));
    alpha = new RecordingProvider(ALPHA_ID);
    beta = new RecordingProvider(BETA_ID);
    server.firewallManager.registerProvider(alpha);
    server.firewallManager.registerProvider(beta);

    const port = await server.start(0);
    cloudUrl = `http://127.0.0.1:${port}`;
    accessToken = (await loginToCloud(cloudUrl)).accessToken;
  });

  afterEach(async () => {
    await server.stop();
  });

  async function hostedRequest(body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${cloudUrl}/v1/hosted/inference`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), messages: [{ role: "user", content: "hi" }], ...body }),
    });
    return res.text();
  }

  it("carries providerId+modelId unchanged from the desktop client through to the provider adapter", async () => {
    // The renderer's intent, expressed the way the desktop encodes an exact model: "provider::model".
    const rendererSelection = `${ALPHA_ID}::${ALPHA_MODEL}`;

    const client = new HostedProviderAdapter({ cloudApiUrl: cloudUrl, getAccessToken: () => accessToken });
    let text = "";
    for await (const event of client.streamChat({ model: rendererSelection, messages: [{ role: "user", content: "hi" }] } as never)) {
      if (event.type === "text_delta") text += event.delta;
    }

    // The terminal adapter was entered with EXACTLY the requested model, and beta was never touched.
    expect(alpha.received).toEqual([{ model: ALPHA_MODEL }]);
    expect(beta.received).toEqual([]);
    // The stream itself reports the identity that actually served the request.
    expect(text).toBe(`served:${ALPHA_ID}::${ALPHA_MODEL}`);
  });

  it("announces the served provider and model on the wire so a substitution would be visible", async () => {
    const sse = await hostedRequest({ providerId: BETA_ID, modelId: BETA_MODEL });

    expect(sse).toContain(`"provider":"${BETA_ID}"`);
    expect(sse).toContain(`"model":"${BETA_MODEL}"`);
    expect(sse).toContain("turn.completed");
    expect(beta.received).toEqual([{ model: BETA_MODEL }]);
    expect(alpha.received).toEqual([]);
  });

  it("resolves a bare exact model id to its own provider — not to whichever provider is handy", async () => {
    const sse = await hostedRequest({ modelId: BETA_MODEL });

    expect(sse).toContain(`"provider":"${BETA_ID}"`);
    expect(beta.received).toEqual([{ model: BETA_MODEL }]);
    expect(alpha.received).toEqual([]);
  });

  it("FAILS rather than substituting when the exact model is unavailable", async () => {
    // Take alpha offline while beta remains perfectly usable — the classic substitution temptation.
    server.firewallManager.markProviderHealth(ALPHA_ID, "offline");

    const sse = await hostedRequest({ providerId: ALPHA_ID, modelId: ALPHA_MODEL });

    expect(sse).toContain("turn.failed");
    expect(sse).not.toContain("turn.completed");
    // Nothing ran. Especially not beta.
    expect(alpha.received).toEqual([]);
    expect(beta.received).toEqual([]);
  });

  it("FAILS rather than substituting when the exact model was never registered", async () => {
    const sse = await hostedRequest({ providerId: ALPHA_ID, modelId: "alpha-model-that-does-not-exist" });

    expect(sse).toContain("turn.failed");
    expect(alpha.received).toEqual([]);
    expect(beta.received).toEqual([]);
  });

  it("refuses a mismatched provider/model pairing instead of routing to the model's real provider", async () => {
    // beta's model, claimed under alpha's provider. A tolerant implementation would "fix" this.
    const sse = await hostedRequest({ providerId: ALPHA_ID, modelId: BETA_MODEL });

    expect(sse).toContain("turn.failed");
    expect(alpha.received).toEqual([]);
    expect(beta.received).toEqual([]);
  });

  it("does not let hostile request fields redirect an exact model", async () => {
    const hostile = [
      { providerId: ALPHA_ID, modelId: ALPHA_MODEL, upstreamProviderId: BETA_ID, upstreamModelId: BETA_MODEL },
      { providerId: ALPHA_ID, modelId: ALPHA_MODEL, provider: BETA_ID, model: BETA_MODEL },
      { providerId: ALPHA_ID, modelId: ALPHA_MODEL, resolvedProviderId: BETA_ID, forceProvider: BETA_ID },
      { providerId: ALPHA_ID, modelId: ALPHA_MODEL, fallbackProviderId: BETA_ID, allowFallback: true },
    ];

    for (const body of hostile) {
      alpha.received.length = 0;
      beta.received.length = 0;
      const sse = await hostedRequest(body);
      expect(sse).toContain("turn.completed");
      expect(alpha.received).toEqual([{ model: ALPHA_MODEL }]);
      expect(beta.received).toEqual([]);
    }
  });

  it("keeps Auto routing separate from exact selection", async () => {
    // Auto is allowed to choose; it must still choose a REGISTERED, verified-free model and report it.
    const sse = await hostedRequest({ modelId: "auto" });
    expect(sse).toContain("turn.completed");

    const served = [...alpha.received, ...beta.received];
    expect(served).toHaveLength(1);
    expect([ALPHA_MODEL, BETA_MODEL]).toContain(served[0]!.model);

    // And an exact request immediately afterwards still honors the exact choice.
    alpha.received.length = 0;
    beta.received.length = 0;
    await hostedRequest({ providerId: ALPHA_ID, modelId: ALPHA_MODEL });
    expect(alpha.received).toEqual([{ model: ALPHA_MODEL }]);
    expect(beta.received).toEqual([]);
  });

  it("fails Auto closed when no verified-free capacity remains, rather than reaching for anything else", async () => {
    server.firewallManager.markProviderHealth(ALPHA_ID, "offline");
    server.firewallManager.markProviderHealth(BETA_ID, "offline");

    const sse = await hostedRequest({ modelId: "auto" });
    expect(sse).toContain("turn.failed");
    expect(alpha.received).toEqual([]);
    expect(beta.received).toEqual([]);
  });
});

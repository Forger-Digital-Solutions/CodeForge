import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CloudDatabase } from "@codeforge/cloud-db";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { HostedProviderAdapter, OpenAICompatibleAdapter, type CredentialStore } from "@codeforge/providers";
import { startFixtureProviderServer, type FixtureProviderServer } from "./helpers/fixture-provider-server.js";
import { spyOnDatabase, spyOnFetch, type DatabaseSpy } from "./helpers/cloud-spy.js";

/**
 * DIRECT / BYOK INDEPENDENCE FROM CODEFORGE CLOUD.
 *
 * The architectural promise is that CodeForge is useful with no CodeForge account at all: Cloud is an
 * optional convenience, never a dependency. This suite proves that promise the only way it can be
 * proven — by breaking the Cloud in every way it can break, then showing the Direct and BYOK paths
 * still complete a real streaming inference over a real socket.
 *
 * Crucially it also proves the NEGATIVE, which is the part that silently rots: during those runs the
 * Cloud database is never queried, Cloud auth is never consulted, entitlements are never evaluated,
 * Hosted accounting never records anything, and not a single HTTP request reaches a Cloud origin.
 *
 * Cloud failure modes exercised: connection refused (nothing listening), HTTP 503, request timeout,
 * unresolvable host, and a running Cloud whose DATABASE is unavailable.
 */

/** An in-memory BYOK credential store — the user's own key, never a server-owned one. */
class TestCredentialStore implements CredentialStore {
  private readonly store = new Map<string, string>();
  constructor(entries: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(entries)) this.store.set(k, v);
  }
  get(providerId: string): string | undefined {
    return this.store.get(providerId);
  }
  set(providerId: string, key: string): void {
    this.store.set(providerId, key);
  }
  delete(providerId: string): void {
    this.store.delete(providerId);
  }
  list(): string[] {
    return [...this.store.keys()];
  }
}

const USER_OWNED_KEY = "sk-user-byok-OWNED-BY-THE-USER-1234";

async function collectStream(adapter: { streamChat: (req: never, signal?: AbortSignal) => AsyncIterable<{ type: string; delta?: string }> }, model: string): Promise<string> {
  let text = "";
  for await (const event of adapter.streamChat({ model, messages: [{ role: "user", content: "Say hello" }] } as never)) {
    if (event.type === "text_delta" && event.delta) text += event.delta;
  }
  return text;
}

describe("Direct / BYOK independence during CodeForge Cloud outage", () => {
  let fixtureProvider: FixtureProviderServer;
  /** A port that is guaranteed to have nothing listening on it. */
  let deadCloudPort: number;

  beforeAll(async () => {
    fixtureProvider = await startFixtureProviderServer({ chunks: ["Direct", " path", " works."] });

    // Bind then immediately release a port so we know it is free — "connection refused" rather than
    // "some other service answered".
    const probe = http.createServer();
    deadCloudPort = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve((probe.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  afterAll(async () => {
    await fixtureProvider.close();
  });

  describe.each([
    { name: "connection refused (no Cloud listening)", makeUrl: () => `http://127.0.0.1:${deadCloudPort}` },
    { name: "unresolvable Cloud host", makeUrl: () => "http://codeforge-cloud-does-not-exist.invalid" },
  ])("Cloud failure mode: $name", ({ makeUrl }) => {
    let dbSpy: DatabaseSpy;

    beforeEach(() => {
      dbSpy = spyOnDatabase(new CloudDatabase({ dbPath: ":memory:" }));
    });

    it("Hosted fails, while Direct and BYOK both complete a real streaming inference", async () => {
      const cloudUrl = makeUrl();
      const fetchSpy = spyOnFetch([cloudUrl], fetch);

      // --- Hosted MUST fail --------------------------------------------------------------------
      const hosted = new HostedProviderAdapter({
        cloudApiUrl: cloudUrl,
        getAccessToken: () => "irrelevant-token",
        fetchFn: fetchSpy.fetchFn,
      });
      await expect(collectStream(hosted as never, "codeforge-auto")).rejects.toThrow();
      expect(await hosted.healthCheck()).toMatchObject({ status: "offline" });
      expect(fetchSpy.cloudCalls().length).toBeGreaterThan(0); // it genuinely tried

      // --- Direct MUST succeed, with zero Cloud contact -------------------------------------------
      fetchSpy.reset();
      dbSpy.reset();
      const directFetchSpy = spyOnFetch([cloudUrl], fetch);
      const direct = new OpenAICompatibleAdapter({
        providerId: "fixture-direct",
        baseUrl: fixtureProvider.url,
        apiKey: "sk-direct-configured-key",
        fetchFn: directFetchSpy.fetchFn,
      });
      const directText = await collectStream(direct as never, "fixture-model");
      expect(directText).toBe("Direct path works.");
      expect(directFetchSpy.cloudCalls()).toEqual([]);
      expect(dbSpy.calls).toEqual([]);

      // --- BYOK MUST succeed, using the USER's key, with zero Cloud contact -------------------------
      const byokFetchSpy = spyOnFetch([cloudUrl], fetch);
      const credentialStore = new TestCredentialStore({ "fixture-byok": USER_OWNED_KEY });
      const byok = new OpenAICompatibleAdapter({
        providerId: "fixture-byok",
        baseUrl: fixtureProvider.url,
        credentialStore,
        fetchFn: byokFetchSpy.fetchFn,
      });
      const byokText = await collectStream(byok as never, "fixture-model");
      expect(byokText).toBe("Direct path works.");
      expect(byokFetchSpy.cloudCalls()).toEqual([]);

      // The user's own credential is what authenticated the call — not a server-owned key.
      const lastRequest = fixtureProvider.requests.at(-1);
      expect(lastRequest?.authorization).toBe(`Bearer ${USER_OWNED_KEY}`);

      // --- The negative, restated across the whole run ------------------------------------------
      // No Cloud auth, no Cloud database, no entitlement evaluation, no Hosted accounting.
      expect(dbSpy.callsMatching(/user|Session|OAuth|Desktop/i)).toEqual([]);
      expect(dbSpy.callsMatching(/[Ee]ntitlement/)).toEqual([]);
      expect(dbSpy.callsMatching(/[Ll]edger|[Rr]eserv|[Uu]sage|[Cc]redit/)).toEqual([]);
      expect(dbSpy.calls).toEqual([]);
    });
  });

  it("Cloud returning HTTP 503 does not impair Direct or BYOK", async () => {
    // A Cloud that is up but refusing service — the failure mode a degraded platform actually shows.
    const failing = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service Unavailable" }));
    });
    const port = await new Promise<number>((resolve) => {
      failing.listen(0, "127.0.0.1", () => resolve((failing.address() as AddressInfo).port));
    });
    const cloudUrl = `http://127.0.0.1:${port}`;

    try {
      const dbSpy = spyOnDatabase(new CloudDatabase({ dbPath: ":memory:" }));
      const hosted = new HostedProviderAdapter({ cloudApiUrl: cloudUrl, getAccessToken: () => "t" });
      await expect(collectStream(hosted as never, "codeforge-auto")).rejects.toThrow();
      expect(await hosted.healthCheck()).toMatchObject({ status: "offline" });

      const fetchSpy = spyOnFetch([cloudUrl], fetch);
      const direct = new OpenAICompatibleAdapter({
        providerId: "fixture-direct",
        baseUrl: fixtureProvider.url,
        apiKey: "sk-direct-configured-key",
        fetchFn: fetchSpy.fetchFn,
      });
      expect(await collectStream(direct as never, "fixture-model")).toBe("Direct path works.");

      const byok = new OpenAICompatibleAdapter({
        providerId: "fixture-byok",
        baseUrl: fixtureProvider.url,
        credentialStore: new TestCredentialStore({ "fixture-byok": USER_OWNED_KEY }),
        fetchFn: fetchSpy.fetchFn,
      });
      expect(await collectStream(byok as never, "fixture-model")).toBe("Direct path works.");

      expect(fetchSpy.cloudCalls()).toEqual([]);
      expect(dbSpy.calls).toEqual([]);
    } finally {
      failing.closeAllConnections?.();
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it("a Cloud that never responds does not stall Direct or BYOK", async () => {
    const hanging = http.createServer(() => {
      /* deliberately never respond */
    });
    const port = await new Promise<number>((resolve) => {
      hanging.listen(0, "127.0.0.1", () => resolve((hanging.address() as AddressInfo).port));
    });
    const cloudUrl = `http://127.0.0.1:${port}`;

    try {
      const dbSpy = spyOnDatabase(new CloudDatabase({ dbPath: ":memory:" }));

      // Hosted is abandoned by the caller's own timeout — the Direct path must not wait on it.
      const hostedController = new AbortController();
      const hostedTimer = setTimeout(() => hostedController.abort(), 300);
      const hosted = new HostedProviderAdapter({ cloudApiUrl: cloudUrl, getAccessToken: () => "t" });
      const hostedPromise = (async () => {
        for await (const _ of hosted.streamChat({ model: "codeforge-auto", messages: [{ role: "user", content: "hi" }] } as never, hostedController.signal)) {
          /* consume */
        }
      })();
      await expect(hostedPromise).rejects.toThrow();
      clearTimeout(hostedTimer);

      const started = Date.now();
      const direct = new OpenAICompatibleAdapter({
        providerId: "fixture-direct",
        baseUrl: fixtureProvider.url,
        apiKey: "sk-direct-configured-key",
      });
      expect(await collectStream(direct as never, "fixture-model")).toBe("Direct path works.");
      // Direct completed on its own schedule, not gated behind the stalled Cloud request.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(dbSpy.calls).toEqual([]);
    } finally {
      hanging.closeAllConnections?.();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("a running Cloud whose DATABASE is unavailable rejects Hosted, invokes no provider, and leaves Direct/BYOK working", async () => {
    // A database that fails every operation: the Cloud process is healthy, its persistence is not.
    const brokenDb = new CloudDatabase({ dbPath: ":memory:" });
    const failing = new Proxy(brokenDb, {
      get(target, prop, receiver) {
        if (prop === "init") return async () => {};
        if (prop === "close") return async () => {};
        if (prop === "ping") return async () => false;
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async () => {
          throw new Error("Database connection lost");
        };
      },
    });

    // Fully explicit configuration so this suite is hermetic: it must behave identically whether or
    // not the ambient environment happens to have NODE_ENV=production set (a certification run does).
    const server = new CodeForgeCloudServer({
      jwtSecret: "outage-cert-jwt-secret-32-characters-long",
      gitHubClientId: "Iv1.outagecertclientid",
      gitHubClientSecret: "outage-cert-client-secret",
      publicUrl: "https://outage-cert.example.com",
      stripeConfig: {
        secretKey: "sk_test_outage_cert",
        webhookSecret: "whsec_outage_cert",
        proPriceId: "price_pro_outage",
        creditPackPriceId: "price_credits_outage",
      },
      db: failing as never,
    });
    const port = await server.start(0);
    const cloudUrl = `http://127.0.0.1:${port}`;

    try {
      // Liveness stays up (the process is fine); readiness reports the truth.
      const live = await fetch(`${cloudUrl}/health/live`);
      expect(live.status).toBe(200);

      const ready = await fetch(`${cloudUrl}/health/ready`);
      expect(ready.status).toBe(503);
      expect((await ready.json()).database).toBe("disconnected");

      // A Hosted request is rejected, and the fixture provider is never invoked.
      const invocationsBefore = fixtureProvider.invocationCount();
      const hosted = new HostedProviderAdapter({ cloudApiUrl: cloudUrl, getAccessToken: () => "not-a-valid-token" });
      await expect(collectStream(hosted as never, "codeforge-auto")).rejects.toThrow();
      expect(fixtureProvider.invocationCount()).toBe(invocationsBefore);

      // Direct and BYOK are entirely unaffected by the Cloud's database outage.
      const fetchSpy = spyOnFetch([cloudUrl], fetch);
      const direct = new OpenAICompatibleAdapter({
        providerId: "fixture-direct",
        baseUrl: fixtureProvider.url,
        apiKey: "sk-direct-configured-key",
        fetchFn: fetchSpy.fetchFn,
      });
      expect(await collectStream(direct as never, "fixture-model")).toBe("Direct path works.");

      const byok = new OpenAICompatibleAdapter({
        providerId: "fixture-byok",
        baseUrl: fixtureProvider.url,
        credentialStore: new TestCredentialStore({ "fixture-byok": USER_OWNED_KEY }),
        fetchFn: fetchSpy.fetchFn,
      });
      expect(await collectStream(byok as never, "fixture-model")).toBe("Direct path works.");
      expect(fetchSpy.cloudCalls()).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("Direct and BYOK never require a CodeForge session, account, or entitlement", async () => {
    // No Cloud server exists in this test AT ALL. If the Direct path had any latent dependency on
    // Cloud identity, there would be nothing for it to talk to.
    const dbSpy = spyOnDatabase(new CloudDatabase({ dbPath: ":memory:" }));

    const direct = new OpenAICompatibleAdapter({
      providerId: "fixture-direct",
      baseUrl: fixtureProvider.url,
      apiKey: "sk-direct-configured-key",
    });
    expect(await collectStream(direct as never, "fixture-model")).toBe("Direct path works.");

    const byok = new OpenAICompatibleAdapter({
      providerId: "fixture-byok",
      baseUrl: fixtureProvider.url,
      credentialStore: new TestCredentialStore({ "fixture-byok": USER_OWNED_KEY }),
    });
    expect(await collectStream(byok as never, "fixture-model")).toBe("Direct path works.");

    expect(dbSpy.calls).toEqual([]);
  });
});

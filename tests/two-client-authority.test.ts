import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudDatabase, PostgresCloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { HostedProviderAdapter, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { loginToCloud, createMockGitHubFetch } from "./helpers/cloud-login.js";
import { sleep } from "./helpers/fixture-provider-server.js";

/**
 * TWO-CLIENT SERVER AUTHORITY.
 *
 * Two completely independent client profiles — separate token stores, separate adapter instances,
 * separate HTTP connections, exactly as two machines signed into one account would be — talk to one
 * production-shaped Cloud.
 *
 * What this proves is that the SERVER, not the client, is the authority. A client cannot invent a
 * balance, a plan, an entitlement, a concurrency allowance, or a routing decision by putting the
 * claim in a request body: the server reads its own database and ignores the client entirely. And
 * the Free-tier concurrency limit of 1 is enforced across independent clients, not merely within one
 * process, because the admission decision lives in the database.
 */

const GITHUB_PROFILE = { id: 424242, login: "two_client_user", name: "Two Client User", email: "tc@example.com" };

/** Provider that holds the stream open until released, so overlapping requests genuinely overlap. */
class GatedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  invocationCount = 0;
  private release!: () => void;
  private gate: Promise<void>;
  /** Resolves once a request has actually entered the provider. */
  entered!: Promise<void>;
  private markEntered!: () => void;

  constructor(providerId: string) {
    this.providerId = providerId;
    this.gate = new Promise<void>((resolve) => (this.release = resolve));
    this.entered = new Promise<void>((resolve) => (this.markEntered = resolve));
  }

  open(): void {
    this.release();
  }

  async *streamChat(): AsyncIterable<StreamEvent> {
    this.invocationCount++;
    this.markEntered();
    yield { type: "text_delta", delta: "held" };
    await this.gate;
    yield { type: "text_delta", delta: " released" };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    this.invocationCount++;
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

/** One isolated client profile: its own token store and its own Hosted adapter instance. */
class ClientProfile {
  readonly name: string;
  accessToken = "";
  refreshToken = "";
  userId = "";
  readonly adapter: HostedProviderAdapter;

  constructor(name: string, cloudUrl: string) {
    this.name = name;
    this.adapter = new HostedProviderAdapter({
      cloudApiUrl: cloudUrl,
      getAccessToken: () => this.accessToken,
    });
  }

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" };
  }
}

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL;

function makeSuite(label: string, createDb: () => ICloudDatabase, skip: boolean) {
  const suite = skip ? describe.skip : describe;

  suite(`Two-client server authority (${label})`, () => {
    let server: CodeForgeCloudServer;
    let cloudUrl: string;
    let provider: GatedProvider;
    let clientA: ClientProfile;
    let clientB: ClientProfile;

    beforeEach(async () => {
      const db = createDb();
      const model = createGenericFreeRecord({ providerId: `two-client-${randomUUID().slice(0, 8)}`, modelId: "shared-free" });
      provider = new GatedProvider(model.providerId);

      server = new CodeForgeCloudServer({
        db,
        jwtSecret: "two-client-authority-jwt-secret-32-chars",
        fetchFn: createMockGitHubFetch({ ...GITHUB_PROFILE, id: GITHUB_PROFILE.id }),
      });
      server.firewallManager.registerModel(model);
      server.firewallManager.registerProvider(provider);

      const port = await server.start(0);
      cloudUrl = `http://127.0.0.1:${port}`;

      // Two INDEPENDENT sign-ins for the same GitHub identity — the way two machines authenticate.
      clientA = new ClientProfile("A", cloudUrl);
      clientB = new ClientProfile("B", cloudUrl);
      const a = await loginToCloud(cloudUrl, { deviceName: "Client A" });
      const b = await loginToCloud(cloudUrl, { deviceName: "Client B" });
      Object.assign(clientA, { accessToken: a.accessToken, refreshToken: a.refreshToken, userId: a.user.id });
      Object.assign(clientB, { accessToken: b.accessToken, refreshToken: b.refreshToken, userId: b.user.id });
    });

    afterEach(async () => {
      provider.open();
      await server.stop();
    });

    it("resolves both independent clients to the SAME account, balance, and entitlements", async () => {
      expect(clientA.userId).toBe(clientB.userId);
      expect(clientA.accessToken).not.toBe(clientB.accessToken);
      expect(clientA.refreshToken).not.toBe(clientB.refreshToken);

      const [accountA, accountB] = await Promise.all([
        (await fetch(`${cloudUrl}/v1/account`, { headers: clientA.headers() })).json(),
        (await fetch(`${cloudUrl}/v1/account`, { headers: clientB.headers() })).json(),
      ]);

      expect(accountA.user.id).toBe(accountB.user.id);
      expect(accountA.planId).toBe("free");
      expect(accountB.planId).toBe("free");
      expect(accountA.creditBalance).toBe(accountB.creditBalance);
      expect(accountA.entitlements.map((e: { featureKey: string }) => e.featureKey).sort()).toEqual(
        accountB.entitlements.map((e: { featureKey: string }) => e.featureKey).sort(),
      );
    });

    it("limits same-account Free hosted concurrency to 1 across two independent clients", async () => {
      const startInference = (client: ClientProfile) =>
        fetch(`${cloudUrl}/v1/hosted/inference`, {
          method: "POST",
          headers: client.headers(),
          body: JSON.stringify({
            requestId: randomUUID(),
            messages: [{ role: "user", content: `hello from ${client.name}` }],
            modelId: "auto",
          }),
        });

      // Client A opens a request and is held inside the provider.
      const responseA = await startInference(clientA);
      const readerA = responseA.body!.getReader();
      await readerA.read(); // ensure the stream is genuinely in flight
      await provider.entered;

      // While A holds the only Free slot, B must be refused by the SERVER.
      const responseB = await startInference(clientB);
      const bodyB = await responseB.text();
      expect(bodyB).toContain("turn.failed");
      expect(bodyB).toMatch(/[Cc]oncurrent|limit/);

      // At most one reservation is active for the shared account at any moment.
      expect(await server.db.getActiveReservationCount(clientA.userId)).toBeLessThanOrEqual(1);

      provider.open();
      // Drain A so the slot is released before teardown.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await readerA.read();
        if (done) break;
      }

      // Exactly one of the two requests ever reached the provider.
      expect(provider.invocationCount).toBe(1);

      // With the slot free, B now succeeds — proving the refusal was admission control, not a bug.
      await sleep(20);
      const responseB2 = await startInference(clientB);
      const bodyB2 = await responseB2.text();
      expect(bodyB2).toContain("turn.completed");
    });

    it("ignores client-supplied balance, plan, entitlement, and concurrency claims", async () => {
      const accountBefore = await (await fetch(`${cloudUrl}/v1/account`, { headers: clientA.headers() })).json();
      expect(accountBefore.planId).toBe("free");

      // Every one of these is a lie the client is telling the server.
      const forged = {
        requestId: randomUUID(),
        messages: [{ role: "user", content: "hi" }],
        modelId: "auto",
        creditBalance: 999_999_999,
        planId: "pro",
        plan: "pro",
        entitlements: ["HOSTED_PAID", "PREMIUM_MODELS", "GEMS_READY"],
        maxConcurrentTasks: 64,
        activeConcurrency: 0,
        userId: "some-other-user-id",
        sub: "some-other-user-id",
        isAdmin: true,
      };

      provider.open();
      const res = await fetch(`${cloudUrl}/v1/hosted/inference`, {
        method: "POST",
        headers: clientA.headers(),
        body: JSON.stringify(forged),
      });
      const body = await res.text();
      expect(body).toContain("turn.completed");

      // The server charged the REAL account, and the plan is still free.
      const accountAfter = await (await fetch(`${cloudUrl}/v1/account`, { headers: clientA.headers() })).json();
      expect(accountAfter.planId).toBe("free");
      expect(accountAfter.user.id).toBe(clientA.userId);
      expect(accountAfter.creditBalance).toBeLessThan(accountBefore.creditBalance);

      // The forged identity was never created.
      expect(await server.db.getUserById("some-other-user-id")).toBeUndefined();

      // The forged entitlements were not granted.
      const entitlements = await server.db.getEntitlements(clientA.userId);
      expect(entitlements.map((e) => e.featureKey)).not.toContain("HOSTED_PAID");
      expect(entitlements.map((e) => e.featureKey)).not.toContain("PREMIUM_MODELS");
    });

    it("rejects a client that forges a provider or model it is not entitled to", async () => {
      provider.open();

      // A provider that is not registered in the server pool.
      const unknownProvider = await fetch(`${cloudUrl}/v1/hosted/inference`, {
        method: "POST",
        headers: clientA.headers(),
        body: JSON.stringify({
          requestId: randomUUID(),
          messages: [{ role: "user", content: "hi" }],
          providerId: "attacker-owned-provider",
          modelId: "gpt-4o",
        }),
      });
      expect(await unknownProvider.text()).toContain("turn.failed");

      // A model id that is not in the ForgeZero catalog.
      const unknownModel = await fetch(`${cloudUrl}/v1/hosted/inference`, {
        method: "POST",
        headers: clientA.headers(),
        body: JSON.stringify({
          requestId: randomUUID(),
          messages: [{ role: "user", content: "hi" }],
          modelId: "definitely-not-a-registered-model",
        }),
      });
      expect(await unknownModel.text()).toContain("turn.failed");
    });

    it("keeps both clients' sessions independent — revoking one does not revoke the other", async () => {
      const logout = await fetch(`${cloudUrl}/v1/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: clientA.refreshToken }),
      });
      expect(logout.status).toBe(200);

      // A's refresh chain is dead.
      const refreshA = await fetch(`${cloudUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: clientA.refreshToken }),
      });
      expect(refreshA.status).toBe(401);

      // B is untouched and still resolves to the same account.
      const refreshB = await fetch(`${cloudUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: clientB.refreshToken }),
      });
      expect(refreshB.status).toBe(200);
      expect((await refreshB.json()).user.id).toBe(clientA.userId);
    });

    it("makes a spend by one client immediately authoritative for the other", async () => {
      provider.open();
      const before = await (await fetch(`${cloudUrl}/v1/usage`, { headers: clientB.headers() })).json();

      const res = await fetch(`${cloudUrl}/v1/hosted/inference`, {
        method: "POST",
        headers: clientA.headers(),
        body: JSON.stringify({ requestId: randomUUID(), messages: [{ role: "user", content: "spend" }], modelId: "auto" }),
      });
      expect(await res.text()).toContain("turn.completed");

      // Client B, which did nothing, observes the balance A consumed — one server-side truth.
      const after = await (await fetch(`${cloudUrl}/v1/usage`, { headers: clientB.headers() })).json();
      expect(after.creditBalance).toBeLessThan(before.creditBalance);
    });
  });
}

makeSuite("SQLite", () => new CloudDatabase({ dbPath: ":memory:" }), false);
makeSuite(
  "real PostgreSQL",
  () => new PostgresCloudDatabase({ connectionString: TEST_PG!, ssl: false }),
  !TEST_PG?.startsWith("postgres"),
);

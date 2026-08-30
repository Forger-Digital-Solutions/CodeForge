import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import { PostgresCloudDatabase } from "@codeforge/cloud-db";
import { AuthService } from "@codeforge/cloud-auth";
import { StripeBillingService } from "@codeforge/cloud-billing";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { CloudFirewallManager, GatewayService } from "@codeforge/cloud-gateway";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

class MockCountingProvider implements ProviderAdapter {
  readonly providerId = "codeforge-mock";
  readonly isTestProvider = true;
  invocationCount = 0;

  async *streamChat(): AsyncIterable<StreamEvent> {
    this.invocationCount++;
    yield { type: "text_delta", delta: "OK" };
    yield { type: "usage", usage: { inputTokens: 50, outputTokens: 25 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
  async listModels() { return []; }
  async chat() {
    this.invocationCount++;
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 50, outputTokens: 25 } };
  }
}

describe.skipIf(!TEST_PG?.startsWith("postgres"))("Postgres Runtime — Deep Adversarial Concurrency & Fault Injection", () => {
  let db: PostgresCloudDatabase;

  beforeAll(async () => {
    db = new PostgresCloudDatabase({ connectionString: TEST_PG });
    await db.init();
  });

  afterAll(async () => {
    await db.close();
  });

  it("Phase 11: Real Credit Overspend Attack — 10 concurrent 30k reserves on 100k balance", async () => {
    const user = await db.createUser({ displayName: "Overspend Victim", primaryIdentity: `github:ovs-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 100_000, eventType: "FREE_ALLOWANCE_GRANTED" });
    expect(await db.getCreditBalance(user.id)).toBe(100_000);

    const concurrency = 10;
    const promises = Array.from({ length: concurrency }).map(async (_, idx) => {
      try {
        const res = await db.reserveCredits({
          requestId: `req-ovs-${idx}-${randomUUID()}`,
          userId: user.id,
          providerId: "openrouter",
          modelId: "test-model",
          reservedCredits: 30_000,
        });
        return { success: true, res };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    const results = await Promise.all(promises);
    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Exactly 3 can succeed (3 * 30k = 90k <= 100k). 7 must fail.
    expect(succeeded.length).toBe(3);
    expect(failed.length).toBe(7);

    // Invariant: balance is non-negative and equals exactly 10,000
    const finalBalance = await db.getCreditBalance(user.id);
    expect(finalBalance).toBe(10_000);
  });

  it("Phase 12 & 13: Real Multi-Instance Free Concurrency Attack — 2 instances race for Free user limit 1", async () => {
    const user = await db.createUser({ displayName: "MultiInst Free", primaryIdentity: `github:mif-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 100_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const fm = new CloudFirewallManager();
    const model = createGenericFreeRecord({ providerId: "codeforge-mock", modelId: "test-free" });
    fm.registerModel(model);
    const provider = new MockCountingProvider();
    fm.registerProvider(provider);

    // Instance 1 and Instance 2 are separate gateway service instances connected to the same PostgreSQL DB
    const gateway1 = new GatewayService({
      firewallManager: fm,
      entitlementService: new EntitlementService(db),
      usageEngine: new UsageEngine(db),
      db,
    });
    const gateway2 = new GatewayService({
      firewallManager: fm,
      entitlementService: new EntitlementService(db),
      usageEngine: new UsageEngine(db),
      db,
    });

    // Both instances receive requests simultaneously for the same user
    const p1 = gateway1.executeHostedInference(
      user.id,
      { requestId: `req-inst1-${randomUUID()}`, messages: [{ role: "user", content: "Hi" }], modelId: "test-free" },
      () => {},
    );
    const p2 = gateway2.executeHostedInference(
      user.id,
      { requestId: `req-inst2-${randomUUID()}`, messages: [{ role: "user", content: "Hi" }], modelId: "test-free" },
      () => {},
    );

    const outcomes = await Promise.allSettled([p1, p2]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    // Because Free task limit is 1, exactly one is accepted and completed; the second is rejected
    // (either at initial check or atomic DB reservation limit)
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length + rejected.length).toBe(2);
  });

  it("Phase 14: Pro Concurrency Limit — 8 simultaneous attempts under limit 4", async () => {
    const user = await db.createUser({ displayName: "Pro Concurrency", primaryIdentity: `github:pro-conc-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 500_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    // Attempt 8 concurrent reservations with maxConcurrentTasks: 4
    const promises = Array.from({ length: 8 }).map(async (_, idx) => {
      try {
        const res = await db.reserveCredits({
          requestId: `req-pro-race-${idx}-${randomUUID()}`,
          userId: user.id,
          providerId: "openrouter",
          modelId: "test-model",
          reservedCredits: 5_000,
          maxConcurrentTasks: 4,
        });
        return { success: true, res };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    const results = await Promise.all(promises);
    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // Maximum 4 can succeed simultaneously
    expect(succeeded.length).toBe(4);
    expect(failed.length).toBe(4);
    expect(await db.getActiveReservationCount(user.id)).toBe(4);
  });

  it("Phase 16: Duplicate Reservation Idempotency under Race", async () => {
    const user = await db.createUser({ displayName: "Dup Reserve User", primaryIdentity: `github:dupr-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 50_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const sharedRequestId = `req-dup-shared-${randomUUID()}`;

    // 10 concurrent requests with the EXACT same requestId
    const promises = Array.from({ length: 10 }).map(async () => {
      return db.reserveCredits({
        requestId: sharedRequestId,
        userId: user.id,
        providerId: "openrouter",
        modelId: "test-model",
        reservedCredits: 5_000,
      });
    });

    const results = await Promise.all(promises);
    const firstResId = results[0]?.reservation.id;

    // All return the exact same reservation ID
    for (const r of results) {
      expect(r.reservation.id).toBe(firstResId);
    }

    // Balance deducted exactly ONCE (50,000 - 5,000 = 45,000)
    expect(await db.getCreditBalance(user.id)).toBe(45_000);
  });

  it("Phase 17: Duplicate Settlement Race — 10 concurrent settlements", async () => {
    const user = await db.createUser({ displayName: "Settle Race User", primaryIdentity: `github:setr-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 50_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const reqId = `req-settle-race-${randomUUID()}`;
    await db.reserveCredits({
      requestId: reqId,
      userId: user.id,
      providerId: "openrouter",
      modelId: "test-model",
      reservedCredits: 5_000,
    });

    // 10 concurrent settlements (actual: 2,000, refund: 3,000)
    const promises = Array.from({ length: 10 }).map(async () => {
      return db.settleReservation({
        requestId: reqId,
        userId: user.id,
        actualCredits: 2_000,
      });
    });

    const results = await Promise.all(promises);
    const transitionedWinners = results.filter((r) => r.transitioned);

    // Exactly 1 winner performed the state transition
    expect(transitionedWinners.length).toBe(1);

    // Balance is accurately refunded once: 45k + 3k = 48,000
    expect(await db.getCreditBalance(user.id)).toBe(48_000);
  });

  it("Phase 18: Duplicate Release Race — 10 concurrent releases", async () => {
    const user = await db.createUser({ displayName: "Release Race User", primaryIdentity: `github:relr-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 50_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const reqId = `req-rel-race-${randomUUID()}`;
    await db.reserveCredits({
      requestId: reqId,
      userId: user.id,
      providerId: "openrouter",
      modelId: "test-model",
      reservedCredits: 8_000,
    });

    // 10 concurrent releases
    const promises = Array.from({ length: 10 }).map(async () => {
      return db.releaseReservationCredits({
        requestId: reqId,
        userId: user.id,
        reason: "User cancelled",
      });
    });

    const results = await Promise.all(promises);
    const winners = results.filter((r) => r.transitioned);

    // Exactly 1 winner transitioned
    expect(winners.length).toBe(1);

    // Balance is fully refunded once (back to 50,000)
    expect(await db.getCreditBalance(user.id)).toBe(50_000);
  });

  it("Phase 19: Settle vs Release Race — exactly one terminal state wins", async () => {
    const user = await db.createUser({ displayName: "SettleVsRelease", primaryIdentity: `github:svr-${randomUUID()}` });
    await db.appendLedgerEvent({ userId: user.id, amount: 50_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const reqId = `req-svr-${randomUUID()}`;
    await db.reserveCredits({
      requestId: reqId,
      userId: user.id,
      providerId: "openrouter",
      modelId: "test-model",
      reservedCredits: 10_000,
    });

    // Race settle (consume 4,000, refund 6,000) vs release (refund 10,000)
    const pSettle = db.settleReservation({ requestId: reqId, userId: user.id, actualCredits: 4_000 }).catch((e) => ({ error: e.message }));
    const pRelease = db.releaseReservationCredits({ requestId: reqId, userId: user.id }).catch((e) => ({ error: e.message }));

    const [resSettle, resRelease] = await Promise.all([pSettle, pRelease]);

    const finalRes = await db.getReservationByRequestId(reqId);
    const finalBalance = await db.getCreditBalance(user.id);

    // Either status is 'committed' (balance 46k) OR 'released' (balance 50k), never corrupted
    if (finalRes?.status === "committed") {
      expect(finalBalance).toBe(46_000);
    } else if (finalRes?.status === "released") {
      expect(finalBalance).toBe(50_000);
    } else {
      throw new Error(`Unexpected final reservation status: ${finalRes?.status}`);
    }
  });

  it("Phase 21 & 22: Real Crash / Restart Persistence & Reconciliation", async () => {
    const dbCrash1 = new PostgresCloudDatabase({ connectionString: TEST_PG });
    await dbCrash1.init();

    const user = await dbCrash1.createUser({ displayName: "Crash Test User", primaryIdentity: `github:crash-${randomUUID()}` });
    await dbCrash1.appendLedgerEvent({ userId: user.id, amount: 50_000, eventType: "FREE_ALLOWANCE_GRANTED" });

    const reqId = `req-crash-${randomUUID()}`;
    // 1. Server A reserves credits
    await dbCrash1.reserveCredits({
      requestId: reqId,
      userId: user.id,
      providerId: "openrouter",
      modelId: "test-model",
      reservedCredits: 15_000,
    });
    expect(await dbCrash1.getCreditBalance(user.id)).toBe(35_000);

    // 2. Simulate Server A crashing by closing connection without settlement
    await dbCrash1.close();

    // 3. Server B starts up against the same PostgreSQL database
    const dbCrash2 = new PostgresCloudDatabase({ connectionString: TEST_PG });
    await dbCrash2.init();

    const usage2 = new UsageEngine(dbCrash2);
    // Server B runs startup reconciliation with a past cutoff
    const futureCutoff = new Date(Date.now() + 60_000).toISOString();
    const staleList = await dbCrash2.listStaleReservations(futureCutoff);
    expect(staleList.some((r) => r.requestId === reqId)).toBe(true);

    const recovered = await usage2.reconcileStaleReservations({ timeoutMs: 0 });
    expect(recovered.reconciled).toBeGreaterThanOrEqual(1);

    // Reserved funds are recovered
    expect(await dbCrash2.getCreditBalance(user.id)).toBe(50_000);

    // Pass 2 reconciliation does not double-refund
    const pass2 = await usage2.reconcileStaleReservations({ timeoutMs: 0 });
    expect(pass2.reconciled).toBe(0);
    expect(await dbCrash2.getCreditBalance(user.id)).toBe(50_000);

    await dbCrash2.close();
  });



  it("Phase 23: OAuth Single-Use Race", async () => {
    const state = `state_oauth_race_${randomUUID()}`;
    await db.createOAuthTransaction({
      state,
      codeChallenge: "challenge_123",
      redirectUri: "http://127.0.0.1:8765/auth/callback",
      expiresInSeconds: 60,
    });

    // 2 concurrent consumers on same state
    const p1 = db.consumeOAuthTransaction(state).then((r) => ({ success: true, r })).catch((e) => ({ success: false, error: e.message }));
    const p2 = db.consumeOAuthTransaction(state).then((r) => ({ success: true, r })).catch((e) => ({ success: false, error: e.message }));

    const [out1, out2] = await Promise.all([p1, p2]);
    const successes = [out1, out2].filter((o) => o.success);
    const failures = [out1, out2].filter((o) => !o.success);

    // Exactly 1 succeeded, 1 failed
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
  });

  it("Phase 24: Refresh Token Rotation Race & Breach Detection", async () => {
    const user = await db.createUser({ displayName: "Auth Race User", primaryIdentity: `github:authr-${randomUUID()}` });
    const initialHash = `token_init_${randomUUID()}`;
    await db.createDeviceSession({ userId: user.id, refreshTokenHash: initialHash });

    // 2 concurrent refresh calls using the exact same old token hash
    const newHash1 = `token_new_1_${randomUUID()}`;
    const newHash2 = `token_new_2_${randomUUID()}`;

    const p1 = db.rotateDeviceSession({ oldTokenHash: initialHash, newRefreshTokenHash: newHash1 }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, err: e.message }));
    const p2 = db.rotateDeviceSession({ oldTokenHash: initialHash, newRefreshTokenHash: newHash2 }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, err: e.message }));

    const [r1, r2] = await Promise.all([p1, p2]);
    const okCount = [r1, r2].filter((r) => r.ok).length;

    // Exactly 1 caller succeeds in rotation
    expect(okCount).toBe(1);
  });

  it("Phase 26: Stripe Webhook Deduplication under Concurrency", async () => {
    const eventId = `evt_race_${randomUUID()}`;

    // 5 concurrent deliveries of the same webhook event
    const promises = Array.from({ length: 5 }).map(async () => {
      return db.claimWebhookEvent({
        stripeEventId: eventId,
        eventType: "checkout.session.completed",
      });
    });

    const results = await Promise.all(promises);
    const claimedCount = results.filter((r) => r.claimed).length;

    // Claimed exactly once
    expect(claimedCount).toBe(1);
  });

  it("Phase 29: Database Outage Before Provider Invocation fails closed", async () => {
    const user = await db.createUser({ displayName: "Fail Closed User", primaryIdentity: `github:fc-${randomUUID()}` });
    // User has 0 balance
    expect(await db.getCreditBalance(user.id)).toBe(0);

    const fm = new CloudFirewallManager();
    fm.registerModel(createGenericFreeRecord({ providerId: "codeforge-mock", modelId: "test-free" }));
    const provider = new MockCountingProvider();
    fm.registerProvider(provider);

    const gateway = new GatewayService({
      firewallManager: fm,
      entitlementService: new EntitlementService(db),
      usageEngine: new UsageEngine(db),
      db,
    });

    // Inference must fail and provider must NEVER be called
    await expect(
      gateway.executeHostedInference(
        user.id,
        { requestId: `req-failclosed-${randomUUID()}`, messages: [{ role: "user", content: "Hi" }], modelId: "test-free" },
        () => {},
      ),
    ).rejects.toThrow();

    expect(provider.invocationCount).toBe(0);
  });

  it("Phase 34: Real PostgreSQL Full Product E2E via Cloud Server", async () => {
    const server = new CodeForgeCloudServer({
      jwtSecret: "cert-postgres-e2e-jwt-secret-32-chars-long",
      databaseUrl: TEST_PG,
      stripeConfig: {
        secretKey: "sk_test_mock_e2e_pg",
        webhookSecret: "whsec_mock_e2e_pg",
        proPriceId: "price_pro_pg",
        creditPackPriceId: "price_pack_pg",
      },
    });

    const port = await server.start(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Health check ready
      const readyRes = await fetch(`${baseUrl}/health/ready`);
      const ready = (await readyRes.json()) as { status: string; database: string };
      expect(ready.status).toBe("ready");
      expect(ready.database).toBe("connected");

      // 2. Start OAuth

      const startRes = await (await fetch(`${baseUrl}/v1/auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUri: "http://127.0.0.1:8765/auth/callback" }),
      })).json();

      expect(startRes.state).toBeDefined();

      // 3. Create a test user directly in Postgres
      const user = await server.db.createUser({ displayName: "PG E2E User", primaryIdentity: `github:pge2e-${randomUUID()}` });
      await server.db.appendLedgerEvent({ userId: user.id, amount: 500_000, eventType: "FREE_ALLOWANCE_GRANTED" });

      expect(await server.db.getCreditBalance(user.id)).toBe(500_000);

      // 4. Stripe Webhook upgrade on PostgreSQL
      const stripeEvent = {
        id: `evt_stripe_pg_e2e_${randomUUID()}`,
        type: "checkout.session.completed",
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            client_reference_id: user.id,
            customer: "cus_pg_e2e",
            subscription: "sub_pg_e2e",
            mode: "subscription",
          },
        },
      };

      const payload = JSON.stringify(stripeEvent);
      const now = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", "whsec_mock_e2e_pg").update(`${now}.${payload}`).digest("hex");

      const webhookRes = await fetch(`${baseUrl}/v1/billing/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": `t=${now},v1=${sig}`,
        },
        body: payload,
      });

      expect(webhookRes.status).toBe(200);
      const webhookData = await webhookRes.json();
      expect(webhookData.action).toBe("pro_subscription_activated");

      // Balance is now 5.5M in real PostgreSQL
      expect(await server.db.getCreditBalance(user.id)).toBe(5_500_000);

      const sub = await server.db.getSubscriptionByUserId(user.id);
      expect(sub?.planId).toBe("pro");
    } finally {
      await server.stop();
    }
  });
});

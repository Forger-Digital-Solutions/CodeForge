import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { ICloudDatabase } from "../src/index.js";
import { SQLiteCloudDatabase } from "../src/sqlite.js";
import { PostgresCloudDatabase } from "../src/postgres.js";

export function defineDatabaseParityTests(suiteName: string, getDb: () => Promise<ICloudDatabase> | ICloudDatabase) {
  describe(`Database Parity — ${suiteName}`, () => {
    let db: ICloudDatabase;

    beforeAll(async () => {
      db = await getDb();
      await db.init();
    });

    afterAll(async () => {
      await db.close();
    });

    it("pings database health successfully", async () => {
      const ok = await db.ping();
      expect(ok).toBe(true);
    });

    it("manages user and identity lifecycle (create, get, provider query)", async () => {
      const tag = randomUUID().slice(0, 8);
      const user = await db.createUser({
        displayName: "Parity User",
        avatarUrl: "https://example.com/avatar.png",
        primaryIdentity: `github:user-${tag}`,
      });
      expect(user.id).toBeDefined();
      expect(user.displayName).toBe("Parity User");

      const byId = await db.getUserById(user.id);
      expect(byId?.id).toBe(user.id);
      expect(byId?.primaryIdentity).toBe(`github:user-${tag}`);

      const byPrimary = await db.getUserByPrimaryIdentity(`github:user-${tag}`);
      expect(byPrimary?.id).toBe(user.id);

      const identity = await db.createIdentity({
        userId: user.id,
        provider: "github",
        providerUserId: `gh-id-${tag}`,
        providerEmail: `user-${tag}@example.com`,
      });
      expect(identity.userId).toBe(user.id);

      const fetchedIdentity = await db.getIdentityByProvider("github", `gh-id-${tag}`);
      expect(fetchedIdentity?.providerEmail).toBe(`user-${tag}@example.com`);
    });

    it("seeds default plans and manages subscription lifecycle", async () => {
      const plans = await db.listPlans();
      expect(plans.length).toBeGreaterThanOrEqual(2);
      expect(plans.some((p) => p.id === "free")).toBe(true);
      expect(plans.some((p) => p.id === "pro")).toBe(true);

      const freePlan = await db.getPlan("free");
      expect(freePlan?.name).toBe("CodeForge Free");
      expect(freePlan?.monthlyCreditAllowance).toBe(500_000);

      const proPlan = await db.getPlan("pro");
      expect(proPlan?.name).toBe("CodeForge Pro");
      expect(proPlan?.monthlyCreditAllowance).toBe(5_000_000);


      const user = await db.createUser({ displayName: "Sub User", primaryIdentity: `github:sub-${randomUUID()}` });
      const sub = await db.upsertSubscription({
        userId: user.id,
        planId: "pro",
        stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
        stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        status: "active",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      });
      expect(sub.planId).toBe("pro");

      const byUser = await db.getSubscriptionByUserId(user.id);
      expect(byUser?.id).toBe(sub.id);

      const byCustomer = await db.getSubscriptionByStripeCustomerId(sub.stripeCustomerId!);
      expect(byCustomer?.userId).toBe(user.id);

      const byStripe = await db.getSubscriptionByStripeSubscriptionId(sub.stripeSubscriptionId!);
      expect(byStripe?.userId).toBe(user.id);

      const updatedSub = await db.upsertSubscription({
        ...sub,
        status: "canceled",
      });
      expect(updatedSub.status).toBe("canceled");
    });


    it("manages entitlements with fail-closed expiry and revocation", async () => {
      const user = await db.createUser({ displayName: "Ent User", primaryIdentity: `github:ent-${randomUUID()}` });
      expect(await db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(false);

      await db.setEntitlement(user.id, "HOSTED_FREE", "true");
      expect(await db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(true);

      const entitlements = await db.getEntitlements(user.id);
      expect(entitlements.some((e) => e.featureKey === "HOSTED_FREE")).toBe(true);

      // Expired entitlement fails closed
      const past = new Date(Date.now() - 10_000).toISOString();
      await db.setEntitlement(user.id, "PREMIUM_MODELS", "true", past);
      expect(await db.hasEntitlement(user.id, "PREMIUM_MODELS")).toBe(false);

      // Remove entitlement
      await db.removeEntitlement(user.id, "HOSTED_FREE");
      expect(await db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(false);
    });

    it("manages device sessions, refresh rotation, revocation, and token replay breach detection", async () => {
      const user = await db.createUser({ displayName: "Device User", primaryIdentity: `github:dev-${randomUUID()}` });
      const hash1 = `hash_old_${randomUUID()}`;
      const hash2 = `hash_new_${randomUUID()}`;
      const session = await db.createDeviceSession({
        userId: user.id,
        deviceName: "MacBook Pro",
        refreshTokenHash: hash1,
      });
      expect(session.revokedAt).toBeNull();

      const fetched = await db.getDeviceSessionByTokenHash(hash1);
      expect(fetched?.id).toBe(session.id);

      // Successful rotation
      const rotated = await db.rotateDeviceSession({
        oldTokenHash: hash1,
        newRefreshTokenHash: hash2,
      });
      expect(rotated.session.refreshTokenHash).toBe(hash2);

      // Old session is revoked
      const oldSession = await db.getDeviceSessionByTokenHash(hash1);
      expect(oldSession?.revokedAt).not.toBeNull();

      // Replay of old hash fails and detects breach
      await expect(async () => {
        await db.rotateDeviceSession({
          oldTokenHash: hash1,
          newRefreshTokenHash: `hash_attacker_${randomUUID()}`,
        });
      }).rejects.toThrow(/replay detected/);

      // Revoke single session
      await db.revokeDeviceSession(rotated.session.id);
      const revoked = await db.getDeviceSessionByTokenHash(hash2);
      expect(revoked?.revokedAt).not.toBeNull();

      // Revoke all user sessions
      const hash3 = `hash_extra_${randomUUID()}`;
      await db.createDeviceSession({ userId: user.id, deviceName: "Phone", refreshTokenHash: hash3 });
      await db.revokeAllUserDeviceSessions(user.id);
      const extraRevoked = await db.getDeviceSessionByTokenHash(hash3);
      expect(extraRevoked?.revokedAt).not.toBeNull();
    });

    it("manages append-only monotonic credit ledger and computes balance accurately", async () => {
      const user = await db.createUser({ displayName: "Ledger User", primaryIdentity: `github:led-${randomUUID()}` });
      expect(await db.getCreditBalance(user.id)).toBe(0);

      const grant = await db.appendLedgerEvent({
        userId: user.id,
        amount: 250_000,
        eventType: "FREE_ALLOWANCE_GRANTED",
        description: "Initial allowance",
      });
      expect(grant.balanceAfter).toBe(250_000);
      expect(await db.getCreditBalance(user.id)).toBe(250_000);

      const usage = await db.appendLedgerEvent({
        userId: user.id,
        amount: -50_000,
        eventType: "CREDIT_USED",
        requestId: `req-ledger-${randomUUID()}`,
        description: "Inference debit",
      });
      expect(usage.balanceAfter).toBe(200_000);
      expect(await db.getCreditBalance(user.id)).toBe(200_000);

      // Disallow overspending
      await expect(async () => {
        await db.appendLedgerEvent({
          userId: user.id,
          amount: -300_000,
          eventType: "CREDIT_USED",
        });
      }).rejects.toThrow(/Insufficient credit balance/);

      const events = await db.listLedgerEvents(user.id);
      expect(events.length).toBe(2);
    });

    it("manages usage events and spend aggregations", async () => {
      const user = await db.createUser({ displayName: "Usage User", primaryIdentity: `github:use-${randomUUID()}` });
      const reqId = `req-usage-${randomUUID()}`;

      const event = await db.recordUsageEvent({
        requestId: reqId,
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 10,
        providerCostUsd: 0.0025,
        creditsConsumed: 200,
        latencyMs: 350,
        status: "success",
      });
      expect(event.id).toBeDefined();

      const recent = await db.listUsageEvents(user.id, 10);
      expect(recent.length).toBe(1);
      expect(recent[0]?.requestId).toBe(reqId);

      const dailySpend = await db.getDailyProviderSpendUsd();
      expect(dailySpend).toBeGreaterThanOrEqual(0.0025);

      const userSpend = await db.getUserBillingPeriodSpendUsd(user.id);
      expect(userSpend).toBeGreaterThanOrEqual(0.0025);
    });

    it("manages usage periods and grants allowances idempotently", async () => {
      const user = await db.createUser({ displayName: "Period User", primaryIdentity: `github:per-${randomUUID()}` });
      const now = new Date("2026-03-01T12:00:00Z");

      const { period: p1, grantedNewAllowance: g1 } = await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, now);
      expect(g1).toBe(true);
      expect(p1.freeAllowanceGranted).toBe(500_000);

      // Repeated call in same period does not re-grant allowance
      const { period: p2, grantedNewAllowance: g2 } = await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, now);
      expect(g2).toBe(false);
      expect(p2.id).toBe(p1.id);
    });

    it("manages server-owned OAuth transactions with single-use consumption", async () => {
      const state = `state_parity_${randomUUID()}`;
      const tx = await db.createOAuthTransaction({
        state,
        codeChallenge: "challenge_parity_1",
        redirectUri: "http://127.0.0.1:8765/auth/callback",
        deviceName: "Desktop Client",
        expiresInSeconds: 60,
      });
      expect(tx.state).toBe(state);
      expect(tx.usedAt).toBeNull();

      const fetched = await db.getOAuthTransaction(state);
      expect(fetched?.state).toBe(state);

      const consumed = await db.consumeOAuthTransaction(state);
      expect(consumed.usedAt).not.toBeNull();

      // Replay rejected
      await expect(async () => {
        await db.consumeOAuthTransaction(state);
      }).rejects.toThrow(/already consumed/);
    });

    it("manages compound atomic two-phase reservations and multi-instance concurrency limits", async () => {
      const user = await db.createUser({ displayName: "Atomic Res User", primaryIdentity: `github:atom-${randomUUID()}` });
      await db.appendLedgerEvent({ userId: user.id, amount: 100_000, eventType: "FREE_ALLOWANCE_GRANTED" });

      expect(await db.getActiveReservationCount(user.id)).toBe(0);

      const reqId1 = `req-atom-1-${randomUUID()}`;

      // 1. Reserve credits with concurrency limit
      const { reservation, balanceAfter, created } = await db.reserveCredits({
        requestId: reqId1,
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        reservedCredits: 10_000,
        maxConcurrentTasks: 1,
      });
      expect(created).toBe(true);
      expect(reservation.status).toBe("reserved");
      expect(balanceAfter).toBe(90_000);
      expect(await db.getActiveReservationCount(user.id)).toBe(1);

      // Second reservation exceeds concurrency limit (limit: 1, active: 1)
      const reqId2 = `req-atom-2-${randomUUID()}`;
      await expect(async () => {
        await db.reserveCredits({
          requestId: reqId2,
          userId: user.id,
          providerId: "openrouter",
          modelId: "meta-llama/llama-3.1-8b-instruct:free",
          reservedCredits: 10_000,
          maxConcurrentTasks: 1,
        });
      }).rejects.toThrow(/Concurrent task limit reached/);

      // Duplicate reserve is idempotent
      const dup = await db.reserveCredits({
        requestId: reqId1,
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        reservedCredits: 10_000,
        maxConcurrentTasks: 1,
      });
      expect(dup.created).toBe(false);
      expect(dup.reservation.id).toBe(reservation.id);
      expect(await db.getActiveReservationCount(user.id)).toBe(1);

      // 2. Settle reservation (actual 4,000 consumed, 6,000 refunded)
      const settled = await db.settleReservation({
        requestId: reqId1,
        userId: user.id,
        actualCredits: 4_000,
      });
      expect(settled.transitioned).toBe(true);
      expect(settled.balanceAfter).toBe(96_000);
      expect(await db.getCreditBalance(user.id)).toBe(96_000);
      expect(await db.getActiveReservationCount(user.id)).toBe(0);

      // Duplicate settle is idempotent no-op
      const dupSettle = await db.settleReservation({
        requestId: reqId1,
        userId: user.id,
        actualCredits: 4_000,
      });
      expect(dupSettle.transitioned).toBe(false);
      expect(dupSettle.balanceAfter).toBe(96_000);

      // 3. Release flow (slot is freed)
      const reqId3 = `req-atom-3-${randomUUID()}`;
      await db.reserveCredits({
        requestId: reqId3,
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        reservedCredits: 6_000,
        maxConcurrentTasks: 1,
      });
      expect(await db.getActiveReservationCount(user.id)).toBe(1);

      const released = await db.releaseReservationCredits({
        requestId: reqId3,
        userId: user.id,
        reason: "Cancelled by user",
      });
      expect(released.transitioned).toBe(true);
      expect(released.refundedCredits).toBe(6_000);
      expect(await db.getCreditBalance(user.id)).toBe(96_000);
      expect(await db.getActiveReservationCount(user.id)).toBe(0);
    });

    it("manages hosted request metadata records", async () => {
      const user = await db.createUser({ displayName: "Hosted User", primaryIdentity: `github:host-${randomUUID()}` });
      const reqId = `host-req-${randomUUID()}`;

      const req = await db.createHostedRequest({
        id: reqId,
        userId: user.id,
        providerId: "openrouter",
        modelId: "test-model",
        estimatedCredits: 5000,
      });
      expect(req.id).toBe(reqId);
      expect(req.status).toBe("pending");

      const fetched = await db.getHostedRequest(reqId);
      expect(fetched?.estimatedCredits).toBe(5000);

      await db.updateHostedRequest(reqId, "completed", 3200);
      const updated = await db.getHostedRequest(reqId);
      expect(updated?.status).toBe("completed");
      expect(updated?.actualCredits).toBe(3200);
    });

    it("claims webhook events with atomic deduplication", async () => {
      const evtId = `evt_parity_${randomUUID()}`;
      const claim1 = await db.claimWebhookEvent({
        stripeEventId: evtId,
        eventType: "checkout.session.completed",
      });
      expect(claim1.claimed).toBe(true);

      const claim2 = await db.claimWebhookEvent({
        stripeEventId: evtId,
        eventType: "checkout.session.completed",
      });
      expect(claim2.claimed).toBe(false);

      expect(await db.isWebhookProcessed(evtId)).toBe(true);

      await db.recordWebhookEvent({
        stripeEventId: `evt_rec_${randomUUID()}`,
        eventType: "customer.subscription.updated",
        status: "processed",
        payload: { test: true },
      });
    });

    it("manages per-account privacy settings and configurations", async () => {
      const user = await db.createUser({ displayName: "Settings User", primaryIdentity: `github:set-${randomUUID()}` });
      const initial = await db.getAccountSettings(user.id);
      expect(initial.privacyMode).toBe("STANDARD");

      const updated = await db.upsertAccountSettings({
        userId: user.id,
        privacyMode: "STRICT",
        spendLimitUsd: 15.0,
      });
      expect(updated.privacyMode).toBe("STRICT");
      expect(updated.spendLimitUsd).toBe(15.0);

      const fetched = await db.getAccountSettings(user.id);
      expect(fetched.privacyMode).toBe("STRICT");
      expect(fetched.spendLimitUsd).toBe(15.0);
    });

    it("records abuse events", async () => {
      const user = await db.createUser({ displayName: "Abuse User", primaryIdentity: `github:abu-${randomUUID()}` });
      const event = await db.recordAbuseEvent({
        userId: user.id,
        ipAddress: "127.0.0.1",
        eventType: "RATE_LIMIT_EXCEEDED",
        details: "50 requests in 10s",
      });
      expect(event.id).toBeDefined();
      expect(event.eventType).toBe("RATE_LIMIT_EXCEEDED");
    });
  });
}

// 1. Run Parity Suite against SQLite
defineDatabaseParityTests("SQLiteCloudDatabase", () => new SQLiteCloudDatabase({ dbPath: ":memory:" }));

// 2. Run Parity Suite against PostgreSQL when connection string is configured
const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
if (TEST_PG && TEST_PG.startsWith("postgres")) {
  defineDatabaseParityTests("PostgresCloudDatabase", () => new PostgresCloudDatabase({ connectionString: TEST_PG }));
}

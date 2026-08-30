import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ICloudDatabase } from "../src/index.js";
import { SQLiteCloudDatabase } from "../src/sqlite.js";
import { PostgresCloudDatabase } from "../src/postgres.js";

export function defineDatabaseParityTests(suiteName: string, getDb: () => Promise<ICloudDatabase> | ICloudDatabase) {
  describe(`Database Parity — ${suiteName}`, () => {
    let db: ICloudDatabase;

    beforeEach(async () => {
      db = await getDb();
      await db.init();
    });

    afterEach(async () => {
      await db.close();
    });

    it("pings database health successfully", async () => {
      const ok = await db.ping();
      expect(ok).toBe(true);
    });

    it("manages user and identity lifecycle", async () => {
      const user = await db.createUser({
        displayName: "Parity User",
        avatarUrl: "https://example.com/avatar.png",
        primaryIdentity: "github:987654",
      });
      expect(user.id).toBeDefined();
      expect(user.displayName).toBe("Parity User");

      const byId = await db.getUserById(user.id);
      expect(byId?.id).toBe(user.id);
      expect(byId?.primaryIdentity).toBe("github:987654");

      const byPrimary = await db.getUserByPrimaryIdentity("github:987654");
      expect(byPrimary?.id).toBe(user.id);

      const identity = await db.createIdentity({
        userId: user.id,
        provider: "github",
        providerUserId: "987654",
        providerEmail: "parity@example.com",
      });
      expect(identity.userId).toBe(user.id);

      const fetchedIdentity = await db.getIdentityByProvider("github", "987654");
      expect(fetchedIdentity?.providerEmail).toBe("parity@example.com");
    });

    it("seeds default plans and manages subscriptions", async () => {
      const plans = await db.listPlans();
      expect(plans.length).toBeGreaterThanOrEqual(2);
      expect(plans.some((p) => p.id === "free")).toBe(true);
      expect(plans.some((p) => p.id === "pro")).toBe(true);

      const user = await db.createUser({ displayName: "Sub User", primaryIdentity: "github:sub-1" });
      const sub = await db.upsertSubscription({
        userId: user.id,
        planId: "pro",
        stripeCustomerId: "cus_sub_parity",
        stripeSubscriptionId: "sub_parity_123",
        status: "active",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      });
      expect(sub.planId).toBe("pro");

      const byUser = await db.getSubscriptionByUserId(user.id);
      expect(byUser?.stripeSubscriptionId).toBe("sub_parity_123");

      const byStripe = await db.getSubscriptionByStripeSubscriptionId("sub_parity_123");
      expect(byStripe?.userId).toBe(user.id);
    });

    it("manages entitlements with fail-closed expiry and revocation", async () => {
      const user = await db.createUser({ displayName: "Ent User", primaryIdentity: "github:ent-1" });
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

    it("manages device sessions, refresh rotation, and token replay breach detection", async () => {
      const user = await db.createUser({ displayName: "Device User", primaryIdentity: "github:dev-1" });
      const session = await db.createDeviceSession({
        userId: user.id,
        deviceName: "MacBook Pro",
        refreshTokenHash: "hash_old_1",
      });
      expect(session.revokedAt).toBeNull();

      const fetched = await db.getDeviceSessionByTokenHash("hash_old_1");
      expect(fetched?.id).toBe(session.id);

      // Successful rotation
      const rotated = await db.rotateDeviceSession({
        oldTokenHash: "hash_old_1",
        newRefreshTokenHash: "hash_new_2",
      });
      expect(rotated.session.refreshTokenHash).toBe("hash_new_2");

      // Old session is revoked
      const oldSession = await db.getDeviceSessionByTokenHash("hash_old_1");
      expect(oldSession?.revokedAt).not.toBeNull();

      // Replay of old hash fails and detects breach
      await expect(async () => {
        await db.rotateDeviceSession({
          oldTokenHash: "hash_old_1",
          newRefreshTokenHash: "hash_attacker_3",
        });
      }).rejects.toThrow(/replay detected/);
    });

    it("manages append-only monotonic credit ledger and computes balance accurately", async () => {
      const user = await db.createUser({ displayName: "Ledger User", primaryIdentity: "github:led-1" });
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
        requestId: "req-ledger-test-1",
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

    it("manages server-owned OAuth transactions with single-use consumption", async () => {
      const tx = await db.createOAuthTransaction({
        state: "state_parity_1",
        codeChallenge: "challenge_parity_1",
        redirectUri: "http://127.0.0.1:8765/auth/callback",
        deviceName: "Desktop Client",
        expiresInSeconds: 60,
      });
      expect(tx.state).toBe("state_parity_1");
      expect(tx.usedAt).toBeNull();

      const consumed = await db.consumeOAuthTransaction("state_parity_1");
      expect(consumed.usedAt).not.toBeNull();

      // Replay rejected
      await expect(async () => {
        await db.consumeOAuthTransaction("state_parity_1");
      }).rejects.toThrow(/already consumed/);
    });

    it("manages compound atomic two-phase reservations and multi-instance concurrency counts", async () => {
      const user = await db.createUser({ displayName: "Atomic Res User", primaryIdentity: "github:atom-1" });
      await db.appendLedgerEvent({ userId: user.id, amount: 100_000, eventType: "FREE_ALLOWANCE_GRANTED" });

      expect(await db.getActiveReservationCount(user.id)).toBe(0);

      // 1. Reserve credits
      const { reservation, balanceAfter, created } = await db.reserveCredits({
        requestId: "req-atom-1",
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        reservedCredits: 10_000,
      });
      expect(created).toBe(true);
      expect(reservation.status).toBe("reserved");
      expect(balanceAfter).toBe(90_000);
      expect(await db.getActiveReservationCount(user.id)).toBe(1);

      // Duplicate reserve is idempotent
      const dup = await db.reserveCredits({
        requestId: "req-atom-1",
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        reservedCredits: 10_000,
      });
      expect(dup.created).toBe(false);
      expect(dup.reservation.id).toBe(reservation.id);
      expect(await db.getActiveReservationCount(user.id)).toBe(1);

      // 2. Settle reservation (actual 4,000 consumed, 6,000 refunded)
      const settled = await db.settleReservation({
        requestId: "req-atom-1",
        userId: user.id,
        actualCredits: 4_000,
      });
      expect(settled.transitioned).toBe(true);
      expect(settled.balanceAfter).toBe(96_000);
      expect(await db.getCreditBalance(user.id)).toBe(96_000);
      expect(await db.getActiveReservationCount(user.id)).toBe(0);

      // Duplicate settle is idempotent no-op
      const dupSettle = await db.settleReservation({
        requestId: "req-atom-1",
        userId: user.id,
        actualCredits: 4_000,
      });
      expect(dupSettle.transitioned).toBe(false);
      expect(dupSettle.balanceAfter).toBe(96_000);

      // 3. Release flow
      await db.reserveCredits({
        requestId: "req-atom-2",
        userId: user.id,
        providerId: "openrouter",
        modelId: "meta-llama/llama-3.1-8b-instruct:free",
        reservedCredits: 6_000,
      });
      expect(await db.getActiveReservationCount(user.id)).toBe(1);

      const released = await db.releaseReservationCredits({
        requestId: "req-atom-2",
        userId: user.id,
        reason: "Cancelled by user",
      });
      expect(released.transitioned).toBe(true);
      expect(released.refundedCredits).toBe(6_000);
      expect(await db.getCreditBalance(user.id)).toBe(96_000);
      expect(await db.getActiveReservationCount(user.id)).toBe(0);
    });

    it("claims webhook events with atomic deduplication", async () => {
      const claim1 = await db.claimWebhookEvent({
        stripeEventId: "evt_parity_unique_1",
        eventType: "checkout.session.completed",
      });
      expect(claim1.claimed).toBe(true);

      const claim2 = await db.claimWebhookEvent({
        stripeEventId: "evt_parity_unique_1",
        eventType: "checkout.session.completed",
      });
      expect(claim2.claimed).toBe(false);

      expect(await db.isWebhookProcessed("evt_parity_unique_1")).toBe(true);
    });

    it("manages per-account privacy settings and configurations", async () => {
      const user = await db.createUser({ displayName: "Settings User", primaryIdentity: "github:set-1" });
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
  });
}

// 1. Run Parity Suite against SQLite
defineDatabaseParityTests("SQLiteCloudDatabase", () => new SQLiteCloudDatabase({ dbPath: ":memory:" }));

// 2. Run Parity Suite against PostgreSQL when connection string is configured
const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
if (TEST_PG && TEST_PG.startsWith("postgres")) {
  defineDatabaseParityTests("PostgresCloudDatabase", () => new PostgresCloudDatabase({ connectionString: TEST_PG }));
}

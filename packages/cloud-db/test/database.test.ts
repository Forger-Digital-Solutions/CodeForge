import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "../src/index.js";

describe("CloudDatabase", () => {
  let db: CloudDatabase;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  it("creates and retrieves a user and identity", () => {
    const user = db.createUser({
      displayName: "Octocat",
      avatarUrl: "https://github.com/images/octocat.png",
      primaryIdentity: "github:12345",
    });
    expect(user.id).toBeDefined();
    expect(user.displayName).toBe("Octocat");

    const fetched = db.getUserById(user.id);
    expect(fetched?.primaryIdentity).toBe("github:12345");

    const byIdentity = db.getUserByPrimaryIdentity("github:12345");
    expect(byIdentity?.id).toBe(user.id);

    const identity = db.createIdentity({
      userId: user.id,
      provider: "github",
      providerUserId: "12345",
      providerEmail: "octocat@github.com",
    });
    expect(identity.userId).toBe(user.id);

    const fetchedIdentity = db.getIdentityByProvider("github", "12345");
    expect(fetchedIdentity?.providerEmail).toBe("octocat@github.com");
  });

  it("manages device sessions and revocation", () => {
    const user = db.createUser({ displayName: "Tester", primaryIdentity: "github:999" });
    const session = db.createDeviceSession({
      userId: user.id,
      deviceName: "Workstation",
      refreshTokenHash: "hash_abc_123",
    });
    expect(session.revokedAt).toBeNull();

    const fetched = db.getDeviceSessionByTokenHash("hash_abc_123");
    expect(fetched?.id).toBe(session.id);

    db.revokeDeviceSession(session.id);
    const revoked = db.getDeviceSessionByTokenHash("hash_abc_123");
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("seeds default plans and manages subscriptions", () => {
    const plans = db.listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans.some((p) => p.id === "free")).toBe(true);
    expect(plans.some((p) => p.id === "pro")).toBe(true);

    const user = db.createUser({ displayName: "Pro User", primaryIdentity: "github:777" });
    const sub = db.upsertSubscription({
      userId: user.id,
      planId: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    expect(sub.planId).toBe("pro");

    const fetched = db.getSubscriptionByUserId(user.id);
    expect(fetched?.stripeSubscriptionId).toBe("sub_123");
  });

  it("manages entitlements with fail-closed expiry", () => {
    const user = db.createUser({ displayName: "Entitled User", primaryIdentity: "github:555" });
    expect(db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(false);

    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    expect(db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(true);

    // Expired entitlement returns false
    const past = new Date(Date.now() - 1000).toISOString();
    db.setEntitlement(user.id, "TEMPORARY_PROMO", "true", past);
    expect(db.hasEntitlement(user.id, "TEMPORARY_PROMO")).toBe(false);

    db.removeEntitlement(user.id, "HOSTED_FREE");
    expect(db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(false);
  });

  it("manages append-only credit ledger and computes balance accurately", () => {
    const user = db.createUser({ displayName: "Wallet User", primaryIdentity: "github:111" });
    expect(db.getCreditBalance(user.id)).toBe(0);

    // Initial grant
    const grant = db.appendLedgerEvent({
      userId: user.id,
      amount: 500_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
      description: "Initial CodeForge Free Tier allowance",
    });
    expect(grant.balanceAfter).toBe(500_000);
    expect(db.getCreditBalance(user.id)).toBe(500_000);

    // Usage deduction
    const usage = db.appendLedgerEvent({
      userId: user.id,
      amount: -12_500,
      eventType: "CREDIT_USED",
      requestId: "req-1",
      description: "Hosted inference turn 1",
    });
    expect(usage.balanceAfter).toBe(487_500);
    expect(db.getCreditBalance(user.id)).toBe(487_500);

    // Cannot spend more than balance
    expect(() => {
      db.appendLedgerEvent({
        userId: user.id,
        amount: -500_000,
        eventType: "CREDIT_USED",
      });
    }).toThrow(/Insufficient credit balance/);

    const history = db.listLedgerEvents(user.id);
    expect(history).toHaveLength(2);
  });

  it("tracks billing webhooks idempotently", () => {
    expect(db.isWebhookProcessed("evt_test_1")).toBe(false);
    db.recordWebhookEvent({
      stripeEventId: "evt_test_1",
      eventType: "checkout.session.completed",
      status: "processed",
      payload: { customer: "cus_1" },
    });
    expect(db.isWebhookProcessed("evt_test_1")).toBe(true);
  });
});

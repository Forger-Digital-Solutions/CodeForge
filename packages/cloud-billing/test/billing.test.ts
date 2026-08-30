import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { StripeBillingService } from "../src/index.js";

describe("Cloud Stripe Billing Service", () => {
  let db: CloudDatabase;
  let entitlementService: EntitlementService;
  let billing: StripeBillingService;
  const webhookSecret = "whsec_test_secret_12345";

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    entitlementService = new EntitlementService(db);
    billing = new StripeBillingService(db, entitlementService, {
      secretKey: "sk_test_12345",
      webhookSecret,
      proPriceId: "price_pro_test",
      creditPackPriceId: "price_credits_test",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("verifies webhook HMAC-SHA256 signatures accurately and rejects invalid signatures", () => {
    const payload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" });
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${now}.${payload}`).digest("hex");
    const header = `t=${now},v1=${signature}`;

    expect(billing.verifyWebhookSignature(payload, header)).toBe(true);

    // Tampered payload
    expect(billing.verifyWebhookSignature(payload + " ", header)).toBe(false);

    // Expired timestamp
    const oldTimestamp = now - 600; // 10 minutes ago (> 5m tolerance)
    const oldSig = createHmac("sha256", webhookSecret).update(`${oldTimestamp}.${payload}`).digest("hex");
    expect(billing.verifyWebhookSignature(payload, `t=${oldTimestamp},v1=${oldSig}`)).toBe(false);
  });

  it("handles checkout.session.completed, activates Pro subscription, and grants credits idempotently", () => {
    const user = db.createUser({ displayName: "Customer", primaryIdentity: "github:500" });
    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    db.appendLedgerEvent({
      userId: user.id,
      amount: 500_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
    });

    const event = {
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          client_reference_id: user.id,
          customer: "cus_stripe_123",
          subscription: "sub_stripe_456",
          mode: "subscription",
        },
      },
    };

    const firstRun = billing.handleWebhookEvent(event);
    expect(firstRun.processed).toBe(true);
    expect(firstRun.action).toBe("pro_subscription_activated");

    // Pro subscription and entitlements active
    const sub = db.getSubscriptionByUserId(user.id);
    expect(sub?.planId).toBe("pro");
    expect(sub?.status).toBe("active");
    expect(entitlementService.hasFeature(user.id, "HOSTED_PAID")).toBe(true);
    expect(entitlementService.hasFeature(user.id, "PREMIUM_MODELS")).toBe(true);

    // Initial 500k + 5M grant = 5.5M credits
    expect(db.getCreditBalance(user.id)).toBe(5_500_000);

    // Duplicate webhook execution (Idempotency)
    const secondRun = billing.handleWebhookEvent(event);
    expect(secondRun.action).toBe("duplicate_skipped");
    expect(db.getCreditBalance(user.id)).toBe(5_500_000); // strictly unchanged
  });

  it("handles subscription cancellation and downgrades entitlements", () => {
    const user = db.createUser({ displayName: "Canceling User", primaryIdentity: "github:600" });
    db.upsertSubscription({
      userId: user.id,
      planId: "pro",
      stripeCustomerId: "cus_cancel_1",
      stripeSubscriptionId: "sub_cancel_1",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    entitlementService.syncSubscriptionEntitlements(user.id, "pro");
    expect(entitlementService.hasFeature(user.id, "PREMIUM_MODELS")).toBe(true);

    billing.handleWebhookEvent({
      id: "evt_sub_deleted_1",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_cancel_1",
        },
      },
    });

    const sub = db.getSubscriptionByUserId(user.id);
    expect(sub?.planId).toBe("free");
    expect(sub?.status).toBe("canceled");
    expect(entitlementService.hasFeature(user.id, "PREMIUM_MODELS")).toBe(false);
  });
});

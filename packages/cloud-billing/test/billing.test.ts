import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { StripeBillingService } from "../src/index.js";

describe("StripeBillingService", () => {
  let db: CloudDatabase;
  let entitlements: EntitlementService;
  let billing: StripeBillingService;
  const webhookSecret = "whsec_test_secret_12345";

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    entitlements = new EntitlementService(db);
    billing = new StripeBillingService(db, entitlements, {
      secretKey: "sk_test_mock_secret",
      webhookSecret,
      proPriceId: "price_pro_test",
      creditPackPriceId: "price_credits_test",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("strictly rejects live Stripe credentials in test mode", () => {
    expect(() => {
      new StripeBillingService(db, entitlements, {
        secretKey: "sk_live_dangerous_secret",
        webhookSecret,
        proPriceId: "price_pro",
        creditPackPriceId: "price_credits",
      });
    }).toThrow(/Live Stripe credentials/);

    expect(() => {
      new StripeBillingService(db, entitlements, {
        secretKey: "rk_live_dangerous_restricted",
        webhookSecret,
        proPriceId: "price_pro",
        creditPackPriceId: "price_credits",
      });
    }).toThrow(/Live Stripe credentials/);
  });

  it("verifies webhook signature with timestamp tolerance and multiple v1 signatures", () => {
    const payload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" });
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${now}.${payload}`).digest("hex");

    // Valid single signature
    expect(billing.verifyWebhookSignature(payload, `t=${now},v1=${signature}`)).toBe(true);

    // Valid multiple signatures (e.g. rotated keys)
    const oldSig = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(billing.verifyWebhookSignature(payload, `t=${now},v1=${oldSig},v1=${signature}`)).toBe(true);

    // Invalid signature
    expect(billing.verifyWebhookSignature(payload, `t=${now},v1=bad_sig`)).toBe(false);

    // Expired timestamp (> 300s)
    const oldTime = now - 500;
    const oldTimeSig = createHmac("sha256", webhookSecret).update(`${oldTime}.${payload}`).digest("hex");
    expect(billing.verifyWebhookSignature(payload, `t=${oldTime},v1=${oldTimeSig}`)).toBe(false);
  });

  it("activates Pro subscription, grants allowance, and handles recurring renewal invoices idempotently", () => {
    const user = db.createUser({ displayName: "Pro Subscriber", primaryIdentity: "github:888" });
    db.getOrCreateCurrentUsagePeriod(user.id, 500_000);

    // 1. Initial checkout
    const checkoutEvent = {
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          client_reference_id: user.id,
          customer: "cus_sub_1",
          subscription: "sub_pro_1",
          mode: "subscription",
        },
      },
    };

    const res1 = billing.handleWebhookEvent(checkoutEvent);
    expect(res1.action).toBe("pro_subscription_activated");
    expect(db.getCreditBalance(user.id)).toBe(5_500_000);
    expect(entitlements.hasFeature(user.id, "HOSTED_PAID")).toBe(true);

    // Duplicate delivery is skipped
    const dupRes = billing.handleWebhookEvent(checkoutEvent);
    expect(dupRes.action).toBe("duplicate_skipped");
    expect(db.getCreditBalance(user.id)).toBe(5_500_000);

    // 2. Monthly recurring renewal invoice
    const renewalInvoiceEvent = {
      id: "evt_inv_renewal_1",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "in_renewal_123",
          subscription: "sub_pro_1",
          customer: "cus_sub_1",
          billing_reason: "subscription_cycle",
          lines: {
            data: [
              {
                period: {
                  start: Math.floor(Date.now() / 1000),
                  end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
                },
              },
            ],
          },
        },
      },
    };

    const res2 = billing.handleWebhookEvent(renewalInvoiceEvent);
    expect(res2.action).toBe("pro_subscription_renewed");
    expect(db.getCreditBalance(user.id)).toBe(10_500_000);

    // 3. Cancellation webhook downgrades user cleanly
    const cancelEvent = {
      id: "evt_cancel_1",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_pro_1",
        },
      },
    };

    const res3 = billing.handleWebhookEvent(cancelEvent);
    expect(res3.action).toBe("subscription_canceled");
    expect(entitlements.hasFeature(user.id, "HOSTED_PAID")).toBe(false);
    expect(entitlements.hasFeature(user.id, "HOSTED_FREE")).toBe(true);
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import type { StripeConfig, StripeCheckoutSessionOptions, StripeCustomerPortalOptions, StripeWebhookPayload } from "./types.js";

export class StripeBillingService {
  private readonly db: CloudDatabase;
  private readonly entitlementService: EntitlementService;
  private readonly config: StripeConfig;

  constructor(db: CloudDatabase, entitlementService: EntitlementService, config: StripeConfig) {
    this.db = db;
    this.entitlementService = entitlementService;
    this.config = config;
  }

  async createCheckoutSession(options: StripeCheckoutSessionOptions, fetchFn: typeof fetch = fetch): Promise<{ sessionId: string; checkoutUrl: string }> {
    const user = this.db.getUserById(options.userId);
    if (!user) {
      throw new Error("User not found for checkout session");
    }

    const priceId = options.planId === "credit_pack" ? this.config.creditPackPriceId : this.config.proPriceId;
    const mode = options.planId === "credit_pack" ? "payment" : "subscription";

    const body = new URLSearchParams({
      mode,
      client_reference_id: options.userId,
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
    });

    if (options.userEmail) {
      body.set("customer_email", options.userEmail);
    }

    const res = await fetchFn("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Stripe Checkout Session creation failed (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { id: string; url: string };
    return {
      sessionId: data.id,
      checkoutUrl: data.url,
    };
  }

  async createCustomerPortalSession(options: StripeCustomerPortalOptions, fetchFn: typeof fetch = fetch): Promise<{ portalUrl: string }> {
    const subscription = this.db.getSubscriptionByUserId(options.userId);
    if (!subscription?.stripeCustomerId) {
      throw new Error("No Stripe customer found for this account");
    }

    const body = new URLSearchParams({
      customer: subscription.stripeCustomerId,
      return_url: options.returnUrl,
    });

    const res = await fetchFn("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Stripe Customer Portal creation failed: ${errText}`);
    }

    const data = (await res.json()) as { url: string };
    return { portalUrl: data.url };
  }

  verifyWebhookSignature(payloadString: string, signatureHeader: string, toleranceSeconds = 300): boolean {
    try {
      const parts = signatureHeader.split(",");
      const timestampPart = parts.find((p) => p.trim().startsWith("t="));
      const sigPart = parts.find((p) => p.trim().startsWith("v1="));

      if (!timestampPart || !sigPart) return false;

      const timestamp = timestampPart.trim().slice(2);
      const signature = sigPart.trim().slice(3);

      const timestampNum = parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestampNum) > toleranceSeconds) {
        return false; // Timestamp out of tolerance
      }

      const signedPayload = `${timestamp}.${payloadString}`;
      const expectedSignature = createHmac("sha256", this.config.webhookSecret)
        .update(signedPayload, "utf8")
        .digest("hex");

      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expectedSignature, "hex");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  handleWebhookEvent(event: StripeWebhookPayload): { processed: boolean; action: string } {
    // Idempotency check
    if (this.db.isWebhookProcessed(event.id)) {
      return { processed: true, action: "duplicate_skipped" };
    }

    let action = "ignored";

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as {
          client_reference_id?: string;
          customer?: string;
          subscription?: string;
          mode?: string;
        };
        const userId = session.client_reference_id;
        if (userId) {
          if (session.mode === "subscription") {
            this.db.upsertSubscription({
              userId,
              planId: "pro",
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              status: "active",
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
              cancelAtPeriodEnd: false,
            });
            this.entitlementService.syncSubscriptionEntitlements(userId, "pro");
            this.db.appendLedgerEvent({
              userId,
              amount: 5_000_000,
              eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
              description: "CodeForge Pro subscription credit grant",
              metadata: { stripeEventId: event.id, subscriptionId: session.subscription },
            });
            action = "pro_subscription_activated";
          } else if (session.mode === "payment") {
            // One-time credit pack purchase (e.g. 1,000,000 credits)
            this.db.appendLedgerEvent({
              userId,
              amount: 1_000_000,
              eventType: "CREDIT_PURCHASED",
              description: "CodeForge 1M Credit Pack Purchase",
              metadata: { stripeEventId: event.id },
            });
            action = "credits_purchased";
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as {
          id: string;
          customer: string;
          status: string;
          current_period_start: number;
          current_period_end: number;
          cancel_at_period_end: boolean;
        };
        const existing = this.db.getSubscriptionByStripeSubscriptionId(sub.id);
        if (existing) {
          const status = sub.status === "active" || sub.status === "trialing" ? "active" : "past_due";
          this.db.upsertSubscription({
            userId: existing.userId,
            planId: "pro",
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            status,
            currentPeriodStart: new Date(sub.current_period_start * 1000).toISOString(),
            currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          });
          action = "subscription_updated";
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as { id: string };
        const existing = this.db.getSubscriptionByStripeSubscriptionId(sub.id);
        if (existing) {
          this.db.upsertSubscription({
            userId: existing.userId,
            planId: "free",
            stripeCustomerId: existing.stripeCustomerId,
            stripeSubscriptionId: existing.stripeSubscriptionId,
            status: "canceled",
            currentPeriodStart: existing.currentPeriodStart,
            currentPeriodEnd: existing.currentPeriodEnd,
            cancelAtPeriodEnd: false,
          });
          this.entitlementService.syncSubscriptionEntitlements(existing.userId, "free");
          action = "subscription_canceled";
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as { subscription?: string };
        if (invoice.subscription) {
          const existing = this.db.getSubscriptionByStripeSubscriptionId(invoice.subscription);
          if (existing) {
            this.db.upsertSubscription({
              ...existing,
              status: "past_due",
            });
            action = "payment_failed_marked_past_due";
          }
        }
        break;
      }
    }

    this.db.recordWebhookEvent({
      stripeEventId: event.id,
      eventType: event.type,
      status: "processed",
      payload: event.data.object,
    });

    return { processed: true, action };
  }
}

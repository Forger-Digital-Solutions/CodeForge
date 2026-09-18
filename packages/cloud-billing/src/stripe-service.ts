import { createHmac, timingSafeEqual } from "node:crypto";
import type { ICloudDatabase } from "@codeforge/cloud-db";
import type { EntitlementService } from "@codeforge/cloud-entitlements";
import type { StripeConfig, StripeCheckoutSessionOptions, StripeCustomerPortalOptions, StripeWebhookPayload } from "./types.js";

interface CheckoutSessionObject {
  id?: string;
  client_reference_id?: string;
  customer?: string;
  subscription?: string;
  mode?: string;
  payment_status?: string;
}

const WEBHOOK_AUDIT_FIELDS = ["id", "object", "customer", "subscription", "mode", "payment_status", "status", "amount_total", "amount_paid", "currency", "billing_reason", "cancel_at_period_end", "current_period_start", "current_period_end", "client_reference_id"] as const;

/** Keep only reconciliation identifiers/amounts from a Stripe object; drop names, emails, addresses. */
export function minimizeWebhookObject(object: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of WEBHOOK_AUDIT_FIELDS) {
    const value = object[field];
    if (value === undefined || value === null) continue;
    out[field] = typeof value === "object" ? (typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : "[object]") : value;
  }
  return out;
}

export class StripeBillingService {
  private readonly db: ICloudDatabase;
  private readonly entitlementService: EntitlementService;
  private readonly config: StripeConfig;

  constructor(db: ICloudDatabase, entitlementService: EntitlementService, config: StripeConfig) {
    // Strictly enforce Stripe Test Mode
    if (config.secretKey.startsWith("sk_live_") || config.secretKey.startsWith("rk_live_")) {
      throw new Error("Live Stripe credentials (sk_live_ / rk_live_) are strictly prohibited. CodeForge Cloud requires Stripe Test Mode credentials.");
    }

    this.db = db;
    this.entitlementService = entitlementService;
    this.config = config;
  }

  async createCheckoutSession(options: StripeCheckoutSessionOptions, fetchFn: typeof fetch = fetch): Promise<{ sessionId: string; checkoutUrl: string }> {
    const user = await this.db.getUserById(options.userId);
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
    const subscription = await this.db.getSubscriptionByUserId(options.userId);
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
      if (!signatureHeader || !payloadString) return false;

      const parts = signatureHeader.split(",");
      const timestampPart = parts.find((p) => p.trim().startsWith("t="));
      const sigParts = parts.filter((p) => p.trim().startsWith("v1="));

      if (!timestampPart || sigParts.length === 0) return false;

      const timestamp = timestampPart.trim().slice(2);
      const timestampNum = parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (isNaN(timestampNum) || Math.abs(now - timestampNum) > toleranceSeconds) {
        return false; // Timestamp out of tolerance
      }

      const signedPayload = `${timestamp}.${payloadString}`;
      const expectedSignature = createHmac("sha256", this.config.webhookSecret)
        .update(signedPayload, "utf8")
        .digest("hex");

      const expBuf = Buffer.from(expectedSignature, "hex");

      for (const sigPart of sigParts) {
        const candidateSig = sigPart.trim().slice(3);
        const sigBuf = Buffer.from(candidateSig, "hex");
        if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Grant the entitlement a paid Checkout Session represents. Shared by `checkout.session.completed`
   * (card payments settle synchronously) and `checkout.session.async_payment_succeeded` (bank
   * debits and other delayed methods settle later). It is the ONLY place a checkout turns into
   * credits or a plan, and it requires Stripe's own `payment_status` to say the money arrived —
   * a completed-but-unpaid session grants nothing.
   */
  private async grantCheckoutSession(event: StripeWebhookPayload, session: CheckoutSessionObject): Promise<string> {
    const userId = session.client_reference_id;
    if (!userId) return "rejected_missing_client_reference";
    // The user named by the session must exist: a mis-targeted session cannot create credit for an
    // account that does not exist, and a deleted account cannot be silently re-credited.
    if (!(await this.db.getUserById(userId))) return "rejected_unknown_user";
    const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
    if (!paid) return "deferred_awaiting_payment";

    if (session.mode === "subscription") {
      if (!session.subscription) return "rejected_subscription_missing";
      const existing = await this.db.getSubscriptionByStripeSubscriptionId(session.subscription);
      if (existing && existing.userId !== userId) return "rejected_subscription_owned_by_other_user";
      await this.db.upsertSubscription({
        userId,
        planId: "pro",
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        status: "active",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      });
      await this.entitlementService.syncSubscriptionEntitlements(userId, "pro");
      await this.db.appendLedgerEvent({
        userId,
        amount: 5_000_000,
        eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
        description: "CodeForge Pro subscription credit grant",
        metadata: { stripeEventId: event.id, subscriptionId: session.subscription, checkoutSessionId: session.id },
      });
      return "pro_subscription_activated";
    }
    if (session.mode === "payment") {
      // One-time credit pack purchase (1,000,000 credits)
      await this.db.appendLedgerEvent({
        userId,
        amount: 1_000_000,
        eventType: "CREDIT_PURCHASED",
        description: "CodeForge 1M Credit Pack Purchase",
        metadata: { stripeEventId: event.id, checkoutSessionId: session.id },
      });
      return "credits_purchased";
    }
    return "ignored";
  }

  async handleWebhookEvent(event: StripeWebhookPayload): Promise<{ processed: boolean; action: string }> {
    if (!event || typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.data || typeof event.data.object !== "object" || event.data.object === null) {
      return { processed: false, action: "rejected_malformed_event" };
    }
    // This deployment is TEST-mode only. A live-mode event can only mean a misconfigured endpoint;
    // it must never mutate a balance.
    if ((event as { livemode?: unknown }).livemode === true) {
      return { processed: false, action: "rejected_livemode_event" };
    }

    // Atomic claim at database level (exactly one delivery wins the race)
    const { claimed } = await this.db.claimWebhookEvent({
      stripeEventId: event.id,
      eventType: event.type,
    });
    if (!claimed) {
      return { processed: true, action: "duplicate_skipped" };
    }

    let action = "ignored";

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        action = await this.grantCheckoutSession(event, event.data.object as CheckoutSessionObject);
        break;
      }

      case "checkout.session.async_payment_failed": {
        // Nothing was granted at completion (payment_status was unpaid), so nothing is reversed.
        action = "async_payment_failed_no_grant";
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as {
          subscription?: string;
          customer?: string;
          billing_reason?: string;
          lines?: { data?: Array<{ period?: { start: number; end: number } }> };
        };
        if (invoice.subscription) {
          const existing = await this.db.getSubscriptionByStripeSubscriptionId(invoice.subscription);
          if (existing && existing.status === "canceled") {
            action = "invoice_ignored_subscription_canceled";
          } else if (existing) {
            // Determine period dates from invoice
            const periodData = invoice.lines?.data?.[0]?.period;
            const periodStart = periodData?.start ? new Date(periodData.start * 1000).toISOString() : new Date().toISOString();
            const periodEnd = periodData?.end ? new Date(periodData.end * 1000).toISOString() : new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

            await this.db.upsertSubscription({
              ...existing,
              status: "active",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            });
            await this.entitlementService.syncSubscriptionEntitlements(existing.userId, "pro");

            // Grant Pro monthly allowance for renewal cycle
            if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_create") {
              await this.db.appendLedgerEvent({
                userId: existing.userId,
                amount: 5_000_000,
                eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
                description: `CodeForge Pro Monthly Renewal Allowance (${periodStart.slice(0, 10)})`,
                metadata: { stripeEventId: event.id, invoiceId: (invoice as any).id, subscriptionId: invoice.subscription },
              });
              action = "pro_subscription_renewed";
            } else {
              action = "invoice_paid_status_synced";
            }
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
        const existing = await this.db.getSubscriptionByStripeSubscriptionId(sub.id);
        if (existing) {
          // Terminal Stripe states arriving out of order (an `updated` delivered after `deleted`)
          // must not resurrect a Pro plan; a subscription already recorded as canceled stays so.
          const terminal = existing.status === "canceled" || sub.status === "canceled" || sub.status === "unpaid" || sub.status === "incomplete_expired";
          const status = terminal ? "canceled" : sub.status === "active" || sub.status === "trialing" ? "active" : "past_due";
          const periodStart = Number.isFinite(sub.current_period_start) ? new Date(sub.current_period_start * 1000).toISOString() : existing.currentPeriodStart;
          const periodEnd = Number.isFinite(sub.current_period_end) ? new Date(sub.current_period_end * 1000).toISOString() : existing.currentPeriodEnd;
          await this.db.upsertSubscription({
            userId: existing.userId,
            planId: terminal ? "free" : "pro",
            stripeCustomerId: sub.customer ?? existing.stripeCustomerId,
            stripeSubscriptionId: sub.id,
            status,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          });
          if (terminal) await this.entitlementService.syncSubscriptionEntitlements(existing.userId, "free");
          action = terminal ? "subscription_canceled" : "subscription_updated";
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as { id: string };
        const existing = await this.db.getSubscriptionByStripeSubscriptionId(sub.id);
        if (existing) {
          await this.db.upsertSubscription({
            userId: existing.userId,
            planId: "free",
            stripeCustomerId: existing.stripeCustomerId,
            stripeSubscriptionId: existing.stripeSubscriptionId,
            status: "canceled",
            currentPeriodStart: existing.currentPeriodStart,
            currentPeriodEnd: existing.currentPeriodEnd,
            cancelAtPeriodEnd: false,
          });
          await this.entitlementService.syncSubscriptionEntitlements(existing.userId, "free");
          action = "subscription_canceled";
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as { subscription?: string };
        if (invoice.subscription) {
          const existing = await this.db.getSubscriptionByStripeSubscriptionId(invoice.subscription);
          if (existing) {
            await this.db.upsertSubscription({
              ...existing,
              status: "past_due",
            });
            action = "payment_failed_marked_past_due";
          }
        }
        break;
      }
    }

    // Data minimization (Security R1): the durable webhook record keeps only the identifiers needed
    // to audit and reconcile — never the full Stripe object, which can carry the customer's email,
    // name, and address. Stripe remains the system of record for those.
    await this.db.recordWebhookEvent({
      stripeEventId: event.id,
      eventType: event.type,
      status: "processed",
      payload: minimizeWebhookObject(event.data.object),
    });

    return { processed: true, action };
  }
}


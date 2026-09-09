import { createHmac, timingSafeEqual } from "node:crypto";
import type { ICloudDatabase } from "@codeforge/cloud-db";
import type { EntitlementService } from "@codeforge/cloud-entitlements";
import type { StripeConfig, StripeCheckoutSessionOptions, StripeCustomerPortalOptions, StripeWebhookPayload } from "./types.js";

type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "incomplete_expired" | "unpaid";

export class StripeBillingService {
  private readonly db: ICloudDatabase;
  private readonly entitlementService: EntitlementService;
  private readonly config: StripeConfig;

  constructor(db: ICloudDatabase, entitlementService: EntitlementService, config: StripeConfig) {
    // Strictly enforce Stripe Test Mode. Refuse unknown key shapes too: a malformed or
    // production-looking credential must never reach the Stripe API by accident.
    if (/^(sk|rk)_live_/.test(config.secretKey)) {
      throw new Error("Live Stripe credentials (sk_live_ / rk_live_) are strictly prohibited. CodeForge Cloud requires Stripe Test Mode credentials.");
    }
    if (!/^(sk|rk)_test_/.test(config.secretKey)) {
      throw new Error("CodeForge Cloud requires a Stripe TEST-mode secret key.");
    }
    if (!/^whsec_/.test(config.webhookSecret)) {
      throw new Error("CodeForge Cloud requires a Stripe webhook signing secret.");
    }

    this.db = db;
    this.entitlementService = entitlementService;
    this.config = config;
  }

  async createCheckoutSession(options: StripeCheckoutSessionOptions, fetchFn: typeof fetch = fetch): Promise<{ sessionId: string; checkoutUrl: string }> {
    const user = await this.db.getUserById(options.userId);
    if (!user) throw new Error("User not found for checkout session");

    // The database plan row is the business authority. This R3 surface intentionally exposes
    // only the existing, explicitly configured test subscription plan; free/unknown/future rows
    // remain unavailable until a price and policy are explicitly registered server-side.
    const plan = await this.db.getPlan(options.planId);
    if (!plan || plan.id !== "pro") throw new Error("Unknown or unavailable billing plan");
    const priceId = this.config.proPriceId;
    if (!/^price_[A-Za-z0-9_]+$/.test(priceId)) throw new Error("Configured Stripe test price is invalid");

    const existingSubscription = await this.db.getSubscriptionByUserId(options.userId);
    if (existingSubscription?.status === "active" || existingSubscription?.status === "trialing") {
      throw new Error("This account already has an active CodeForge subscription");
    }
    if (!this.config.checkoutSuccessUrl || !this.config.checkoutCancelUrl) {
      throw new Error("Stripe checkout return URLs are not configured by the server");
    }

    const body = new URLSearchParams({
      mode: "subscription",
      client_reference_id: options.userId,
      success_url: this.config.checkoutSuccessUrl,
      cancel_url: this.config.checkoutCancelUrl,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "metadata[plan_id]": plan.id,
      "subscription_data[metadata][plan_id]": plan.id,
    });

    // Reuse the durable customer mapping whenever one exists. If it does not, Stripe creates the
    // customer during Checkout and the signed webhook binds that customer to this authenticated
    // CodeForge account via client_reference_id.
    if (existingSubscription?.stripeCustomerId) body.set("customer", existingSubscription.stripeCustomerId);

    const res = await fetchFn("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Retry-safe for a short checkout-attempt window. The key is derived only from the
        // authenticated account and server-approved plan, never from client pricing input.
        "Idempotency-Key": `codeforge-checkout-${options.userId}-${plan.id}-${Math.floor(Date.now() / 600000)}`,
      },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`Stripe Checkout Session creation failed (HTTP ${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { id?: string; url?: string };
    if (!data.id || !data.url) throw new Error("Stripe Checkout Session response was incomplete");
    return { sessionId: data.id, checkoutUrl: data.url };
  }

  async createCustomerPortalSession(options: StripeCustomerPortalOptions, fetchFn: typeof fetch = fetch): Promise<{ portalUrl: string }> {
    const subscription = await this.db.getSubscriptionByUserId(options.userId);
    if (!subscription?.stripeCustomerId) throw new Error("No Stripe customer found for this account");
    if (!this.config.portalReturnUrl) throw new Error("Stripe portal return URL is not configured by the server");

    const res = await fetchFn("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ customer: subscription.stripeCustomerId, return_url: this.config.portalReturnUrl }).toString(),
    });
    if (!res.ok) throw new Error(`Stripe Customer Portal creation failed: ${await res.text()}`);
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error("Stripe Customer Portal response was incomplete");
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
      if (isNaN(timestampNum) || Math.abs(Math.floor(Date.now() / 1000) - timestampNum) > toleranceSeconds) return false;

      const expectedSignature = createHmac("sha256", this.config.webhookSecret).update(`${timestamp}.${payloadString}`, "utf8").digest("hex");
      const expected = Buffer.from(expectedSignature, "hex");
      return sigParts.some((sigPart) => {
        const candidate = Buffer.from(sigPart.trim().slice(3), "hex");
        return candidate.length === expected.length && timingSafeEqual(candidate, expected);
      });
    } catch {
      return false;
    }
  }

  async handleWebhookEvent(event: StripeWebhookPayload, fetchFn: typeof fetch = fetch): Promise<{ processed: boolean; action: string }> {
    if (!event.id || !event.type || !event.data?.object) throw new Error("Malformed Stripe webhook event");

    // The database claim is a short-lived processing lease. It is not marked "processed" until all
    // subscription, entitlement, and ledger mutations have completed successfully.
    const { claimed } = await this.db.claimWebhookEvent({ stripeEventId: event.id, eventType: event.type });
    if (!claimed) return { processed: true, action: "duplicate_skipped" };

    try {
      let action = "ignored";
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as {
            client_reference_id?: string;
            customer?: string;
            subscription?: string;
            mode?: string;
            metadata?: { plan_id?: string };
            current_period_start?: number;
            current_period_end?: number;
            status?: string;
          };
          const userId = session.client_reference_id;
          if (!userId || session.mode !== "subscription" || session.metadata?.plan_id !== "pro") {
            throw new Error("Stripe Checkout session is not bound to an approved CodeForge subscription plan");
          }
          if (!session.customer || !session.subscription) throw new Error("Stripe Checkout session is missing customer or subscription mapping");

          const byCustomer = await this.db.getSubscriptionByStripeCustomerId(session.customer);
          if (byCustomer && byCustomer.userId !== userId) throw new Error("Stripe customer is already bound to another CodeForge account");
          const bySubscription = await this.db.getSubscriptionByStripeSubscriptionId(session.subscription);
          if (bySubscription && bySubscription.userId !== userId) throw new Error("Stripe subscription is already bound to another CodeForge account");

          // Stripe's Checkout event does not always expand the subscription period. Fetch the
          // authoritative subscription when the event does not carry it; never invent a 30-day period.
          let periodStart = session.current_period_start;
          let periodEnd = session.current_period_end;
          let stripeStatus = session.status;
          if (!periodStart || !periodEnd || !stripeStatus) {
            const subscription = await this.fetchSubscription(session.subscription, fetchFn);
            periodStart ??= subscription.current_period_start;
            periodEnd ??= subscription.current_period_end;
            stripeStatus ??= subscription.status;
          }
          if (!periodStart || !periodEnd || !stripeStatus) throw new Error("Stripe subscription is missing authoritative period state");

          const status = this.mapSubscriptionStatus(stripeStatus);
          const plan = await this.db.getPlan("pro");
          if (!plan) throw new Error("CodeForge Pro plan is not registered");
          await this.db.upsertSubscription({
            userId,
            planId: "pro",
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            status,
            currentPeriodStart: new Date(periodStart * 1000).toISOString(),
            currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
            cancelAtPeriodEnd: false,
          });
          await this.entitlementService.syncSubscriptionEntitlements(userId, status === "active" || status === "trialing" ? "pro" : "free");
          if (status === "active" || status === "trialing") {
            await this.db.appendLedgerEvent({
              userId,
              amount: plan.monthlyCreditAllowance,
              eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
              requestId: `stripe:${event.id}:subscription-allowance`,
              description: "CodeForge Pro subscription credit grant",
              metadata: { stripeEventId: event.id, subscriptionId: session.subscription },
            });
            action = "pro_subscription_activated";
          } else {
            action = "subscription_recorded_not_active";
          }
          break;
        }

        case "invoice.paid":
        case "invoice.payment_succeeded": {
          const invoice = event.data.object as {
            id?: string;
            subscription?: string;
            billing_reason?: string;
            lines?: { data?: Array<{ period?: { start: number; end: number } }> };
          };
          if (invoice.subscription) {
            const existing = await this.db.getSubscriptionByStripeSubscriptionId(invoice.subscription);
            if (existing) {
              const period = invoice.lines?.data?.[0]?.period;
              if (!period?.start || !period.end) throw new Error("Stripe invoice is missing authoritative subscription period");
              const periodStart = new Date(period.start * 1000).toISOString();
              const periodEnd = new Date(period.end * 1000).toISOString();
              await this.db.upsertSubscription({ ...existing, status: "active", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd });
              await this.entitlementService.syncSubscriptionEntitlements(existing.userId, "pro");

              const plan = await this.db.getPlan("pro");
              if (!plan) throw new Error("CodeForge Pro plan is not registered");
              if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_create") {
                await this.db.appendLedgerEvent({
                  userId: existing.userId,
                  amount: plan.monthlyCreditAllowance,
                  eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
                  requestId: `stripe:${event.id}:subscription-allowance`,
                  description: `CodeForge Pro Monthly Renewal Allowance (${periodStart.slice(0, 10)})`,
                  metadata: { stripeEventId: event.id, invoiceId: invoice.id, subscriptionId: invoice.subscription },
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
            current_period_start?: number;
            current_period_end?: number;
            cancel_at_period_end?: boolean;
          };
          const existing = await this.db.getSubscriptionByStripeSubscriptionId(sub.id);
          if (existing) {
            if (!sub.current_period_start || !sub.current_period_end) throw new Error("Stripe subscription update is missing period state");
            const status = this.mapSubscriptionStatus(sub.status);
            await this.db.upsertSubscription({
              userId: existing.userId,
              planId: status === "canceled" ? "free" : existing.planId,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
              status,
              currentPeriodStart: new Date(sub.current_period_start * 1000).toISOString(),
              currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
              cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
            });
            await this.entitlementService.syncSubscriptionEntitlements(existing.userId, status === "active" || status === "trialing" ? "pro" : "free");
            action = "subscription_updated";
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
              await this.db.upsertSubscription({ ...existing, status: "past_due" });
              await this.entitlementService.syncSubscriptionEntitlements(existing.userId, "free");
              action = "payment_failed_marked_past_due";
            }
          }
          break;
        }
      }

      // Store only event identity and outcome. Stripe payloads can contain billing details that do
      // not belong in the application audit table.
      await this.db.recordWebhookEvent({ stripeEventId: event.id, eventType: event.type, status: "processed" });
      return { processed: true, action };
    } catch (error) {
      // A failed mutation becomes retryable. The claim is a processing lease, not proof of commit.
      await this.db.recordWebhookEvent({ stripeEventId: event.id, eventType: event.type, status: "failed" }).catch(() => undefined);
      throw error;
    }
  }

  private mapSubscriptionStatus(status: string): SubscriptionStatus {
    switch (status) {
      case "active":
      case "trialing":
      case "past_due":
      case "canceled":
      case "incomplete":
      case "incomplete_expired":
      case "unpaid":
        return status;
      default:
        throw new Error(`Unsupported Stripe subscription status: ${status}`);
    }
  }

  private async fetchSubscription(subscriptionId: string, fetchFn: typeof fetch): Promise<{ status: string; current_period_start: number; current_period_end: number }> {
    const res = await fetchFn(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { Authorization: `Bearer ${this.config.secretKey}` },
    });
    if (!res.ok) throw new Error(`Stripe subscription lookup failed (HTTP ${res.status})`);
    const data = (await res.json()) as { status?: string; current_period_start?: number; current_period_end?: number };
    if (!data.status || !data.current_period_start || !data.current_period_end) {
      throw new Error("Stripe subscription lookup returned incomplete lifecycle state");
    }
    return { status: data.status, current_period_start: data.current_period_start, current_period_end: data.current_period_end };
  }
}

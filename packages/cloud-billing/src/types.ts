import { z } from "zod";

export const StripeConfigSchema = z.object({
  secretKey: z.string().regex(/^(sk|rk)_test_/, "Stripe billing requires a TEST-mode secret key"),
  webhookSecret: z.string().regex(/^whsec_/, "Stripe webhook secret has an invalid shape"),
  proPriceId: z.string().default("price_test_pro_monthly"),
  creditPackPriceId: z.string().default("price_test_credits_1m"),
  /** Server-owned destinations. Browser/Desktop clients never supply these values. */
  checkoutSuccessUrl: z.string().url().optional(),
  checkoutCancelUrl: z.string().url().optional(),
  portalReturnUrl: z.string().url().optional(),
});
export type StripeConfig = z.infer<typeof StripeConfigSchema>;

export interface StripeCheckoutSessionOptions {
  userId: string;
  planId: string;
}

export interface StripeCustomerPortalOptions {
  userId: string;
}

export interface StripeWebhookPayload {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
  created: number;
}

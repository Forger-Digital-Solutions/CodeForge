import { z } from "zod";

export const StripeConfigSchema = z.object({
  secretKey: z.string(),
  webhookSecret: z.string(),
  proPriceId: z.string().default("price_test_pro_monthly"),
  creditPackPriceId: z.string().default("price_test_credits_1m"),
});
export type StripeConfig = z.infer<typeof StripeConfigSchema>;

export interface StripeCheckoutSessionOptions {
  userId: string;
  userEmail?: string;
  planId?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCustomerPortalOptions {
  userId: string;
  returnUrl: string;
}

export interface StripeWebhookPayload {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
  created: number;
}

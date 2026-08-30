import { z } from "zod";

export const CostReservationSchema = z.object({
  reservationId: z.string().uuid(),
  userId: z.string().uuid(),
  requestId: z.string(),
  estimatedCredits: z.number().int().positive(),
  status: z.enum(["reserved", "committed", "released"]),
  createdAt: z.string(),
});
export type CostReservation = z.infer<typeof CostReservationSchema>;

export interface UsageCalculationOptions {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  inputRatePerMillion?: number; // USD per 1M input tokens
  outputRatePerMillion?: number; // USD per 1M output tokens
}

export function calculateTokensAndCredits(options: UsageCalculationOptions): {
  totalTokens: number;
  credits: number;
  estimatedCostUsd: number;
} {
  const cached = options.cachedTokens ?? 0;
  const input = Math.max(0, options.inputTokens - cached);
  const output = options.outputTokens;
  const totalTokens = input + cached + output;

  // Credit weighting: 1 input token = 1 credit, 1 cached token = 0.5 credits, 1 output token = 2 credits
  const credits = Math.ceil(input * 1 + cached * 0.5 + output * 2);

  const inputRate = options.inputRatePerMillion ?? 0.15; // default $0.15/1M
  const outputRate = options.outputRatePerMillion ?? 0.60; // default $0.60/1M
  const estimatedCostUsd = (input * inputRate + cached * inputRate * 0.25 + output * outputRate) / 1_000_000;

  return {
    totalTokens,
    credits,
    estimatedCostUsd,
  };
}

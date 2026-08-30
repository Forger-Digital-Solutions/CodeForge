import { z } from "zod";

export const FeatureKeySchema = z.enum([
  "HOSTED_FREE",
  "HOSTED_PAID",
  "PREMIUM_MODELS",
  "GEMS_ACCESS",
  "HIGH_CONTEXT",
  "HIGH_CONCURRENCY",
  "PRIORITY_ROUTING",
  "CLOUD_JOBS",
  "DIRECT_PROVIDERS",
]);
export type FeatureKey = z.infer<typeof FeatureKeySchema>;

export interface TaskExecutionPermission {
  allowed: boolean;
  reason?: string;
  maxEstimatedCredits: number;
  availableCredits: number;
  planId: string;
}

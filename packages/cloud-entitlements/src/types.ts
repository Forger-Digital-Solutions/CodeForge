import { z } from "zod";
import { FeatureKeySchema, type FeatureKey } from "@codeforge/cloud-db";

export { FeatureKeySchema, type FeatureKey };

export interface TaskExecutionPermission {
  allowed: boolean;
  reason?: string;
  maxEstimatedCredits: number;
  availableCredits: number;
  planId: string;
}

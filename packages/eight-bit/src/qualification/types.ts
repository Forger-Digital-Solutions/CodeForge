import { z } from "zod";
import type { FreeModelRecord as ForgeZeroFreeModelRecord } from "@codeforge/forge-zero";
import { EightBitRoleSchema, type EightBitRole } from "../types.js";

/** Version of the qualification suite - increment when fixtures or evaluation logic changes */
export const QUALIFICATION_SUITE_VERSION = "R10_FREE_QUALIFICATION_V1";

/** Re-export for convenience */
export type FreeModelRecord = ForgeZeroFreeModelRecord;
// EightBitRole is imported from ../types.js by consumers
export { EightBitRoleSchema };

/** Role-specific qualification outcomes */
export const RoleQualificationStatusSchema = z.enum([
  "QUALIFIED",
  "NOT_QUALIFIED",
  "HARD_FAILURE",
  "NOT_TESTED",
  "PROBATION",
]);
export type RoleQualificationStatus = z.infer<typeof RoleQualificationStatusSchema>;

/** Individual test case result */
export const TestCaseResultSchema = z.object({
  caseId: z.string(),
  category: z.string(),
  passed: z.boolean(),
  hardFailure: z.boolean(),
  latencyMs: z.number(),
  retries: z.number().default(0),
  details: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

/** Role qualification result with all test cases */
export const RoleQualificationResultSchema = z.object({
  role: EightBitRoleSchema,
  status: RoleQualificationStatusSchema,
  testCases: z.array(TestCaseResultSchema),
  hardFailures: z.array(z.string()),
  overallScore: z.number().min(0).max(1).optional(),
  startedAt: z.string(),
  completedAt: z.string(),
});
export type RoleQualificationResult = z.infer<typeof RoleQualificationResultSchema>;

/** Full model qualification receipt */
export const ModelQualificationReceiptSchema = z.object({
  suiteVersion: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  modelDisplayName: z.string(),
  accessClass: z.string(),
  freeStatus: z.string(),
  roleResults: z.record(RoleQualificationResultSchema),
  startedAt: z.string(),
  completedAt: z.string(),
  totalLatencyMs: z.number(),
  qualificationState: z.enum(["QUALIFIED", "PROBATION", "NOT_QUALIFIED", "HARD_FAILURE"]),
  hardFailureRoles: z.array(EightBitRoleSchema),
  metadata: z.record(z.unknown()).optional(),
});
export type ModelQualificationReceipt = z.infer<typeof ModelQualificationReceiptSchema>;

/** Qualification configuration */
export interface QualificationConfig {
  /** Roles to test (default: all roles that model capabilities suggest) */
  roles?: EightBitRole[];
  /** Timeout per test case in ms */
  caseTimeoutMs?: number;
  /** Max retries per test case */
  maxRetries?: number;
  /** Whether to run in parallel (for independent cases) */
  parallel?: boolean;
  /** Budget limits */
  budget?: {
    maxTotalTokens?: number;
    maxTotalCalls?: number;
    maxWallTimeMs?: number;
  };
  /** Progress callback */
  onProgress?: (progress: { role: string; caseId: string; passed: boolean }) => void;
}

/** Default qualification configuration */
export const DEFAULT_QUALIFICATION_CONFIG: QualificationConfig = {
  caseTimeoutMs: 60000,
  maxRetries: 2,
  parallel: false,
  budget: {
    maxTotalCalls: 50,
    maxWallTimeMs: 300000,
  },
};

/** Provider adapter interface for qualification (minimal) */
export interface QualificationProviderAdapter {
  readonly providerId: string;
  chat(req: any): Promise<any>;
  streamChat(req: any, signal?: AbortSignal): AsyncIterable<any>;
}

/** Qualification context for a single model */
export interface QualificationContext {
  model: FreeModelRecord;
  provider: QualificationProviderAdapter;
  config: QualificationConfig;
  suiteVersion: string;
}

/** Fixture case definition */
export interface FixtureCase {
  id: string;
  name: string;
  category: string;
  description: string;
  files?: string[];
  question?: string;
  instruction?: string;
  task?: string;
  scenario?: any;
  schemaFile?: string;
  schemaName?: string;
  expectedAnswer?: string;
  acceptableAnswers?: string[];
  requiredKeywords?: string[];
  requiredFileReferences?: string[];
  prohibitedActions?: string[];
  checkType?: string;
  expectedTool?: string;
  expectedArgs?: Record<string, any>;
  steps?: Array<{
    instruction: string;
    expectedTool: string;
    expectedArgs: Record<string, any>;
    expectedAnswer: string;
  }>;
  metadata?: Record<string, unknown>;
}
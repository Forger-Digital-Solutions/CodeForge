// qualification-fixtures/structured-output/schema.ts
// Zod schema for structured output test

import { z } from "zod";

export const AnalysisResultSchema = z.object({
  issueType: z.enum(["bug", "feature", "refactor", "docs"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  affectedFiles: z.array(z.string()),
  suggestedFix: z.string().min(10),
  confidence: z.number().min(0).max(1),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const SCHEMA_DESCRIPTION = "Analysis result with issue type, severity, affected files, suggested fix, and confidence";
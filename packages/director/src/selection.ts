import { z } from "zod";

export const ExecutionModeSchema = z.enum([
  "forgezero-adaptive",
  "exact-free",
  "exact-premium",
  "gems",
]);

export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const PremiumFamilySchema = z.enum(["gpt", "glm", "anthropic"]);

export type PremiumFamily = z.infer<typeof PremiumFamilySchema>;

export const ExecutionModelSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("forgezero-adaptive"),
  }),
  z.object({
    mode: z.literal("exact-free"),
    modelId: z.string(),
    providerId: z.string(),
  }),
  z.object({
    mode: z.literal("exact-premium"),
    family: PremiumFamilySchema,
    modelId: z.string(),
    providerId: z.string(),
  }),
  z.object({
    mode: z.literal("gems"),
    modelId: z.string().optional(),
  }),
]);

export type ExecutionModelSelection = z.infer<typeof ExecutionModelSelectionSchema>;

export const ProviderReadinessSchema = z.enum([
  "ready",
  "missing_credential",
  "invalid_configuration",
  "unsupported",
  "coming_soon",
]);

export type ProviderReadiness = z.infer<typeof ProviderReadinessSchema>;

export const ResolvedModelSchema = z.object({
  requestedMode: ExecutionModeSchema,
  resolvedModelId: z.string(),
  resolvedProviderId: z.string(),
  resolvedFamily: PremiumFamilySchema.optional(),
  isAdaptiveResolution: z.boolean(),
});

export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export function isForgeZeroAdaptive(
  selection: ExecutionModelSelection,
): selection is { mode: "forgezero-adaptive" } {
  return selection.mode === "forgezero-adaptive";
}

export function isExactFree(
  selection: ExecutionModelSelection,
): selection is { mode: "exact-free"; modelId: string; providerId: string } {
  return selection.mode === "exact-free";
}

export function isExactPremium(
  selection: ExecutionModelSelection,
): selection is {
  mode: "exact-premium";
  family: PremiumFamily;
  modelId: string;
  providerId: string;
} {
  return selection.mode === "exact-premium";
}

export function isGems(
  selection: ExecutionModelSelection,
): selection is { mode: "gems"; modelId?: string } {
  return selection.mode === "gems";
}

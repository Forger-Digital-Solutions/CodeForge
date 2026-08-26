import { err, ok, type Result } from "@codeforge/core";
import { CodeForgeError } from "@codeforge/core";
import type { ForgeZero } from "@codeforge/forge-zero";
import type { ProviderCatalog, ProviderAdapter } from "@codeforge/providers";
import {
  type ExecutionModelSelection,
  type ResolvedModel,
  type ProviderReadiness,
  type PremiumFamily,
  isForgeZeroAdaptive,
  isExactFree,
  isExactPremium,
  isGems,
} from "./selection.js";

export { 
  ExecutionModeSchema, 
  ExecutionModelSelectionSchema, 
  ProviderReadinessSchema,
  ResolvedModelSchema,
  PremiumFamilySchema,
  type ExecutionMode,
  type ExecutionModelSelection,
  type ProviderReadiness,
  type ResolvedModel,
  type PremiumFamily,
  isForgeZeroAdaptive,
  isExactFree,
  isExactPremium,
  isGems,
} from "./selection.js";

export interface DirectorOptions {
  firewall: ForgeZero;
  providerCatalog: ProviderCatalog;
  gemsReady?: boolean;
}

export interface TaskDefinition {
  id: string;
  title: string;
  modelSelection: ExecutionModelSelection;
}

export interface TaskResult {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  resolvedModel?: ResolvedModel;
  error?: string;
}

export class ForgeDirector {
  private readonly firewall: ForgeZero;
  private readonly providerCatalog: ProviderCatalog;
  private readonly gemsReady: boolean;

  constructor(options: DirectorOptions) {
    this.firewall = options.firewall;
    this.providerCatalog = options.providerCatalog;
    this.gemsReady = options.gemsReady ?? false;
  }

  async runTask(task: TaskDefinition): Promise<TaskResult> {
    const selection = task.modelSelection;

    const validation = this.validateSelection(selection);
    if (!validation.ok) {
      return {
        taskId: task.id,
        status: "failed",
        error: validation.error.message,
      };
    }

    const resolution = await this.resolveModel(selection);
    if (!resolution.ok) {
      return {
        taskId: task.id,
        status: "failed",
        error: resolution.error.message,
      };
    }

    const execution = await this.execute(task, resolution.value);
    if (!execution.ok) {
      return {
        taskId: task.id,
        status: "failed",
        resolvedModel: resolution.value,
        error: execution.error.message,
      };
    }

    return {
      taskId: task.id,
      status: "completed",
      resolvedModel: resolution.value,
    };
  }

  private validateSelection(
    selection: ExecutionModelSelection,
  ): Result<void, CodeForgeError> {
    if (isGems(selection)) {
      if (!this.gemsReady) {
        return err(
          new CodeForgeError(
            "FORGE_ZERO_VIOLATION",
            "GEMS runtime is not available yet. GEMS remains Coming Soon.",
          ),
        );
      }
    }

    if (isExactPremium(selection)) {
      const readiness = this.getProviderReadiness(selection.family);
      if (readiness !== "ready") {
        return err(
          new CodeForgeError(
            "FORGE_ZERO_VIOLATION",
            this.formatProviderNotReadyMessage(selection.family, readiness),
          ),
        );
      }
    }

    return ok(undefined);
  }

  private async resolveModel(
    selection: ExecutionModelSelection,
  ): Promise<Result<ResolvedModel, CodeForgeError>> {
    if (isForgeZeroAdaptive(selection)) {
      return this.resolveForgeZeroAdaptive();
    }

    if (isExactFree(selection)) {
      return this.resolveExactFree(selection);
    }

    if (isExactPremium(selection)) {
      return this.resolveExactPremium(selection);
    }

    if (isGems(selection)) {
      return this.resolveGems(selection);
    }

    return err(
      new CodeForgeError("INTERNAL_ERROR", "Unknown selection mode"),
    );
  }

  private resolveForgeZeroAdaptive(): Result<ResolvedModel, CodeForgeError> {
    const eligible = this.firewall.eligibleModels();
    if (eligible.length === 0) {
      return err(
        new CodeForgeError(
          "NO_FREE_PROVIDER",
          "ForgeZero could not find a healthy verified-free model for this request.",
        ),
      );
    }

    const best = eligible[0];
    if (!best) {
      return err(
        new CodeForgeError("NO_FREE_PROVIDER", "No eligible free models"),
      );
    }

    return ok({
      requestedMode: "forgezero-adaptive",
      resolvedModelId: best.modelId,
      resolvedProviderId: best.providerId,
      isAdaptiveResolution: true,
    });
  }

  private resolveExactFree(
    selection: { mode: "exact-free"; modelId: string; providerId: string },
  ): Result<ResolvedModel, CodeForgeError> {
    const result = this.firewall.verify(selection.providerId, selection.modelId);
    if (!result.ok) {
      return err(
        new CodeForgeError(
          result.error.code,
          `${selection.modelId} is currently unavailable. CodeForge did not substitute another model because Exact Free mode is enabled. Choose another verified-free model or switch to ForgeZero Adaptive.`,
        ),
      );
    }

    return ok({
      requestedMode: "exact-free",
      resolvedModelId: selection.modelId,
      resolvedProviderId: selection.providerId,
      isAdaptiveResolution: false,
    });
  }

  private resolveExactPremium(
    selection: {
      mode: "exact-premium";
      family: PremiumFamily;
      modelId: string;
      providerId: string;
    },
  ): Result<ResolvedModel, CodeForgeError> {
    const adapter = this.providerCatalog.get(selection.providerId);
    if (!adapter) {
      return err(
        new CodeForgeError(
          "FORGE_ZERO_VIOLATION",
          `Provider ${selection.providerId} is not registered.`,
        ),
      );
    }

    return ok({
      requestedMode: "exact-premium",
      resolvedModelId: selection.modelId,
      resolvedProviderId: selection.providerId,
      resolvedFamily: selection.family,
      isAdaptiveResolution: false,
    });
  }

  private resolveGems(
    selection: { mode: "gems"; modelId?: string },
  ): Result<ResolvedModel, CodeForgeError> {
    if (!this.gemsReady) {
      return err(
        new CodeForgeError(
          "FORGE_ZERO_VIOLATION",
          "GEMS runtime is not available yet.",
        ),
      );
    }

    return ok({
      requestedMode: "gems",
      resolvedModelId: selection.modelId ?? "gems-default",
      resolvedProviderId: "gems",
      isAdaptiveResolution: false,
    });
  }

  private async execute(
    task: TaskDefinition,
    resolved: ResolvedModel,
  ): Promise<Result<void, CodeForgeError>> {
    const adapter = this.providerCatalog.get(resolved.resolvedProviderId);
    if (!adapter) {
      return err(
        new CodeForgeError(
          "PROVIDER_UNAVAILABLE",
          `Provider ${resolved.resolvedProviderId} not available`,
        ),
      );
    }

    return ok(undefined);
  }

  getProviderReadiness(family: PremiumFamily): ProviderReadiness {
    const providerId = family;
    const adapter = this.providerCatalog.get(providerId);

    if (!adapter) {
      if (family === "gpt" || family === "anthropic" || family === "glm") {
        return "missing_credential";
      }
      return "unsupported";
    }

    return "ready";
  }

  private formatProviderNotReadyMessage(
    family: PremiumFamily,
    readiness: ProviderReadiness,
  ): string {
    switch (readiness) {
      case "missing_credential":
        return `${family.toUpperCase()} is not configured. Add your ${family.toUpperCase()} API credential in Provider Settings before using this model.`;
      case "invalid_configuration":
        return `${family.toUpperCase()} configuration is invalid. Check your API credential.`;
      case "unsupported":
        return `${family.toUpperCase()} is not supported on this system.`;
      case "coming_soon":
        return `${family.toUpperCase()} is Coming Soon.`;
      default:
        return `${family.toUpperCase()} is not ready.`;
    }
  }
}

export function createDirector(options: DirectorOptions): ForgeDirector {
  return new ForgeDirector(options);
}

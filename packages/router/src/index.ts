import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import type { ExecutionModelSelection, ResolvedModel, PremiumFamily } from "@codeforge/director";
import { err, ok, type Result } from "@codeforge/core";
import { CodeForgeError } from "@codeforge/core";

export interface RoutingRequest {
  taskType: string;
  estimatedContextTokens: number;
  requiredCapabilities: string[];
  preferredTraits?: Record<string, number>;
}

export interface RoutingDecision {
  model: FreeModelRecord;
  score: number;
  reasons: string[];
  alternatives: FreeModelRecord[];
}

export interface RouterOptions {
  firewall: ForgeZero;
}

export class ForgeRouter {
  private readonly firewall: ForgeZero;

  constructor(options: RouterOptions) {
    this.firewall = options.firewall;
  }

  route(req: RoutingRequest): RoutingDecision | null {
    const eligible = this.firewall.eligibleModels();
    if (eligible.length === 0) {
      return null;
    }

    const scored = eligible
      .map((model) => ({
        model,
        score: this.scoreModel(model, req),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best) {
      return null;
    }

    const alternatives = scored.slice(1, 4).map((s) => s.model);

    return {
      model: best.model,
      score: best.score,
      reasons: this.getReasons(best.model, req),
      alternatives,
    };
  }

  resolveSelection(selection: ExecutionModelSelection): Result<ResolvedModel, CodeForgeError> {
    if (selection.mode === "forgezero-adaptive") {
      const decision = this.route({
        taskType: "coding",
        estimatedContextTokens: 8000,
        requiredCapabilities: ["text", "coding"],
      });

      if (!decision) {
        return err(
          new CodeForgeError(
            "NO_FREE_PROVIDER",
            "No eligible free models available",
          ),
        );
      }

      return ok({
        requestedMode: "forgezero-adaptive",
        resolvedModelId: decision.model.modelId,
        resolvedProviderId: decision.model.providerId,
        isAdaptiveResolution: true,
      });
    }

    if (selection.mode === "exact-free") {
      const verifyResult = this.firewall.verify(
        selection.providerId,
        selection.modelId,
      );

      if (!verifyResult.ok) {
        return err(verifyResult.error);
      }

      return ok({
        requestedMode: "exact-free",
        resolvedModelId: selection.modelId,
        resolvedProviderId: selection.providerId,
        isAdaptiveResolution: false,
      });
    }

    if (selection.mode === "exact-premium") {
      return ok({
        requestedMode: "exact-premium",
        resolvedModelId: selection.modelId,
        resolvedProviderId: selection.providerId,
        resolvedFamily: selection.family,
        isAdaptiveResolution: false,
      });
    }

    if (selection.mode === "gems") {
      return ok({
        requestedMode: "gems",
        resolvedModelId: selection.modelId ?? "gems-default",
        resolvedProviderId: "gems",
        isAdaptiveResolution: false,
      });
    }

    return err(
      new CodeForgeError("INTERNAL_ERROR", "Unknown selection mode"),
    );
  }

  private scoreModel(model: FreeModelRecord, req: RoutingRequest): number {
    let score = 50;

    const caps = model.capabilities;
    if (req.requiredCapabilities.includes("coding") && caps.coding) score += 15;
    if (req.requiredCapabilities.includes("toolCalling") && caps.toolCalling) score += 10;
    if (req.estimatedContextTokens > 32000 && caps.longContext) score += 10;

    if (model.contextWindow) {
      if (model.contextWindow >= req.estimatedContextTokens * 2) score += 5;
    }

    return score;
  }

  private getReasons(model: FreeModelRecord, req: RoutingRequest): string[] {
    const reasons: string[] = [];

    if (model.capabilities.coding) reasons.push("coding_capable");
    if (model.capabilities.toolCalling) reasons.push("tool_calling");
    if (model.capabilities.longContext) reasons.push("long_context");
    if (model.contextWindow && model.contextWindow >= req.estimatedContextTokens * 2) {
      reasons.push("sufficient_context");
    }

    return reasons;
  }
}

export function createRouter(options: RouterOptions): ForgeRouter {
  return new ForgeRouter(options);
}

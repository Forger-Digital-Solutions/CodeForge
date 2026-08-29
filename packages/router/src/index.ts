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

/** A ranked verified-free candidate for the "Top Verified Free" list. */
export interface RankedModel {
  model: FreeModelRecord;
  score: number;
  reasons: string[];
}

export interface RouterOptions {
  firewall: ForgeZero;
}

export class ForgeRouter {
  private readonly firewall: ForgeZero;

  constructor(options: RouterOptions) {
    this.firewall = options.firewall;
  }

  /**
   * Deterministic capability-aware ranking of the currently eligible (verified-free) models.
   * Ordering is stable: score desc, then modelId asc as a tiebreak — same inputs → same order.
   */
  rank(req: RoutingRequest): RankedModel[] {
    const eligible = this.firewall.eligibleModels();
    return eligible
      .map((model) => ({ model, score: this.scoreModel(model, req), reasons: this.getReasons(model, req) }))
      .sort((a, b) => b.score - a.score || a.model.modelId.localeCompare(b.model.modelId));
  }

  /**
   * The at-most-N recommended verified-free models, live-derived from ForgeZero eligibility.
   * NEVER hardcoded — reflects whatever providers are connected and verified right now.
   */
  topVerifiedFree(req: RoutingRequest, limit = 5): RankedModel[] {
    return this.rank(req).slice(0, Math.max(0, limit));
  }

  route(req: RoutingRequest): RoutingDecision | null {
    const scored = this.rank(req);
    const best = scored[0];
    if (!best) {
      return null;
    }

    const alternatives = scored.slice(1, 4).map((s) => s.model);

    return {
      model: best.model,
      score: best.score,
      reasons: best.reasons,
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
    const bp = model.benchmarkProfile;
    const taskLower = req.taskType.toLowerCase();
    const isAgenticTask =
      taskLower.includes("agentic") ||
      taskLower.includes("autonomous") ||
      taskLower.includes("repository") ||
      taskLower.includes("repo") ||
      taskLower.includes("multi-file") ||
      taskLower.includes("multi_file") ||
      taskLower.includes("parallel") ||
      taskLower.includes("subtask") ||
      taskLower.includes("debugging") ||
      taskLower.includes("iterative") ||
      taskLower.includes("long-running") ||
      taskLower.includes("architecture") ||
      taskLower.includes("long_horizon") ||
      taskLower.includes("long-horizon");

    const isSimpleTask =
      taskLower === "simple" ||
      taskLower === "text" ||
      (req.estimatedContextTokens < 4000 &&
        req.requiredCapabilities.length === 1 &&
        req.requiredCapabilities[0] === "text");

    if (req.requiredCapabilities.includes("coding") && caps.coding) score += 15;
    if (req.requiredCapabilities.includes("toolCalling") && caps.toolCalling) score += 10;
    if (req.estimatedContextTokens > 32000 && caps.longContext) score += 10;

    if (model.contextWindow) {
      if (model.contextWindow >= req.estimatedContextTokens * 2) score += 5;
      if (model.contextWindow >= 200000 && req.estimatedContextTokens > 50000) score += 5;
    }

    if (bp) {
      if (req.requiredCapabilities.includes("coding") && bp.coding !== undefined) {
        score += Math.round(bp.coding * 0.2);
      }
      if (req.requiredCapabilities.includes("toolCalling") && bp.toolCalling !== undefined) {
        score += Math.round(bp.toolCalling * 0.15);
      }
      const needsLongContext =
        req.requiredCapabilities.includes("longContext") || req.estimatedContextTokens > 32000;
      if (needsLongContext && bp.longContext !== undefined) {
        score += Math.round(bp.longContext * 0.15);
      }
      if (isAgenticTask && bp.reasoning !== undefined) {
        score += Math.round(bp.reasoning * 0.15);
      }
      if (isAgenticTask && bp.coding !== undefined) {
        score += Math.round(bp.coding * 0.05);
      }
      if (isSimpleTask && bp.speed !== undefined) {
        score += Math.round(bp.speed * 0.2);
      }
      if (req.preferredTraits) {
        for (const [trait, weight] of Object.entries(req.preferredTraits)) {
          const val =
            trait === "coding"
              ? bp.coding
              : trait === "toolCalling"
                ? bp.toolCalling
                : trait === "reasoning"
                  ? bp.reasoning
                  : trait === "longContext"
                    ? bp.longContext
                    : trait === "speed"
                      ? bp.speed
                      : undefined;
          if (val !== undefined) {
            score += Math.round(val * 0.1 * weight);
          }
        }
      }
    }

    // Empirical CodeForge scores (from certification workloads) — additive, optional.
    // These make CodeForge routing more than Models.dev facts. Absent → no contribution.
    if (model.codingScore !== undefined && req.requiredCapabilities.includes("coding")) {
      score += Math.round(model.codingScore * 0.12);
    }
    if (model.agentScore !== undefined && isAgenticTask) {
      score += Math.round(model.agentScore * 0.1);
    }
    if (model.toolReliability !== undefined && req.requiredCapabilities.includes("toolCalling")) {
      score += Math.round(model.toolReliability * 15);
    }

    // Free-class stability: prefer stable native/routed $0 over quota/promo endpoints, all else equal.
    switch (model.accessClass) {
      case "FREE_NATIVE":
        score += 4;
        break;
      case "FREE_ROUTED":
        score += 2;
        break;
      case "FREE_PROMO":
        score -= 3;
        break;
      default:
        break;
    }

    // Health penalty: cooling-down / degraded providers rank lower even if still eligible.
    const failures = model.health?.recentFailureCount ?? 0;
    if (failures > 0) score -= Math.min(20, failures * 5);
    if (model.health?.status === "degraded") score -= 5;

    return score;
  }

  private getReasons(model: FreeModelRecord, req: RoutingRequest): string[] {
    const reasons: string[] = [];
    const bp = model.benchmarkProfile;
    const taskLower = req.taskType.toLowerCase();
    const isAgenticTask =
      taskLower.includes("agentic") ||
      taskLower.includes("autonomous") ||
      taskLower.includes("repository") ||
      taskLower.includes("repo");

    if (model.capabilities.coding) reasons.push("coding_capable");
    if (model.capabilities.toolCalling) reasons.push("tool_calling");
    if (model.capabilities.longContext) reasons.push("long_context");
    if (model.contextWindow && model.contextWindow >= req.estimatedContextTokens * 2) {
      reasons.push("sufficient_context");
    }
    if (bp?.coding !== undefined && bp.coding >= 85 && req.requiredCapabilities.includes("coding")) {
      reasons.push("high_coding_score");
    }
    if (bp?.toolCalling !== undefined && bp.toolCalling >= 85 && req.requiredCapabilities.includes("toolCalling")) {
      reasons.push("strong_tool_use");
    }
    if (bp?.longContext !== undefined && bp.longContext >= 85 && (req.estimatedContextTokens > 32000 || req.requiredCapabilities.includes("longContext"))) {
      reasons.push("long_context_optimized");
    }
    if (bp?.reasoning !== undefined && bp.reasoning >= 85 && isAgenticTask) {
      reasons.push("agentic_capable");
    }
    if (model.contextWindow && model.contextWindow >= 200000) {
      reasons.push("large_context_window");
    }
    if (model.accessClass) {
      reasons.push(`access_${model.accessClass.toLowerCase()}`);
    }
    if (model.toolReliability !== undefined && model.toolReliability >= 0.85) {
      reasons.push("empirically_reliable_tools");
    }

    return reasons;
  }
}

export function createRouter(options: RouterOptions): ForgeRouter {
  return new ForgeRouter(options);
}

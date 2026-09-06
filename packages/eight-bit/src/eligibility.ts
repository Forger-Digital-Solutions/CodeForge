import type { FreeModelRecord } from "@codeforge/forge-zero";
import { FREE_ACCESS_CLASSES } from "@codeforge/forge-zero";
import { ROLE_CONTRACTS, type EightBitRole, type ReliabilityScore } from "./types.js";

/**
 * Fail-closed policy mode for a routing request. `adaptive` may only ever resolve into the
 * free-default fleet; `byok`/`premium` require the caller to have already obtained explicit
 * user authorization elsewhere (8-Bit does not grant it) before requesting that mode.
 */
export type EightBitPolicyMode = "adaptive" | "byok" | "premium";

export interface EligibilityContext {
  role: EightBitRole;
  policyMode: EightBitPolicyMode;
  estimatedContextTokens?: number;
  reliability?: ReliabilityScore;
}

export type IneligibilityCode =
  | "PAID_NOT_AUTHORIZED"
  | "UNKNOWN_COST_NOT_AUTHORIZED"
  | "MISSING_CAPABILITY"
  | "INSUFFICIENT_CONTEXT"
  | "TOOL_RELIABILITY_BELOW_THRESHOLD"
  | "QUARANTINED"
  | "UNHEALTHY";

export type EligibilityVerdict =
  | { eligible: true }
  | { eligible: false; code: IneligibilityCode; reason: string };

/**
 * Hard role-capability + free-policy gate, evaluated BEFORE ranking. A route either satisfies
 * every requirement here or it is not a candidate at all — no ranking score can compensate.
 * This is intentionally separate from ForgeZero's own free/paid/privacy verification (still
 * enforced upstream by `ForgeRouter.resolveSelection`/`ForgeZero.verify`); this layer adds the
 * role-capability contract and live tool-reliability gate ForgeZero does not know about.
 */
export class EightBitEligibilityPolicy {
  evaluate(model: FreeModelRecord, ctx: EligibilityContext): EligibilityVerdict {
    const policyVerdict = this.evaluatePolicyBoundary(model, ctx);
    if (!policyVerdict.eligible) return policyVerdict;

    const contract = ROLE_CONTRACTS[ctx.role];
    if (contract.requiresTools && !model.capabilities.toolCalling) {
      return { eligible: false, code: "MISSING_CAPABILITY", reason: `Role ${ctx.role} requires tool calling` };
    }
    if (contract.requiresStructuredOutput && !model.capabilities.structuredOutput) {
      return { eligible: false, code: "MISSING_CAPABILITY", reason: `Role ${ctx.role} requires structured output` };
    }
    if (contract.requiresVision && !model.capabilities.vision) {
      return { eligible: false, code: "MISSING_CAPABILITY", reason: `Role ${ctx.role} requires vision` };
    }
    if (contract.requiresLongContext && !model.capabilities.longContext) {
      return { eligible: false, code: "MISSING_CAPABILITY", reason: `Role ${ctx.role} requires long context` };
    }

    const requiredContext = Math.max(contract.minContextTokens, ctx.estimatedContextTokens ?? 0);
    if (model.contextWindow !== undefined && model.contextWindow < requiredContext) {
      return {
        eligible: false,
        code: "INSUFFICIENT_CONTEXT",
        reason: `Context window ${model.contextWindow} below required ${requiredContext}`,
      };
    }

    if (contract.minToolReliability > 0 && ctx.reliability) {
      if (ctx.reliability.quarantined) {
        return { eligible: false, code: "QUARANTINED", reason: "Model quarantined after repeated malformed tool calls" };
      }
      if (ctx.reliability.score !== undefined && ctx.reliability.score < contract.minToolReliability) {
        return {
          eligible: false,
          code: "TOOL_RELIABILITY_BELOW_THRESHOLD",
          reason: `Observed tool reliability ${ctx.reliability.score.toFixed(2)} below required ${contract.minToolReliability}`,
        };
      }
    }

    const health = model.health?.status;
    if (health === "offline" || health === "auth_required") {
      return { eligible: false, code: "UNHEALTHY", reason: `Route health status is ${health}` };
    }

    return { eligible: true };
  }

  /**
   * `accessClass` (when present) is the trusted structured classification the audit confirmed
   * is derived from real pricing/policy data (`deriveAccessClass()`), never from model-name
   * strings. Per its own schema doc, an ABSENT `accessClass` means "legacy $0-unit record" —
   * so the fallback path trusts the legacy `freeStatus` enum (also structured, not a name
   * heuristic), where anything other than an explicit `verified_free` fails closed.
   */
  private evaluatePolicyBoundary(model: FreeModelRecord, ctx: EligibilityContext): EligibilityVerdict {
    const accessClass = model.accessClass;

    if (accessClass !== undefined) {
      const isFree = FREE_ACCESS_CLASSES.includes(accessClass);
      if (ctx.policyMode === "adaptive") {
        if (!isFree) {
          return {
            eligible: false,
            code: accessClass === "PAID" ? "PAID_NOT_AUTHORIZED" : "UNKNOWN_COST_NOT_AUTHORIZED",
            reason: `Access class ${accessClass} is not eligible for adaptive/free-default routing`,
          };
        }
        return { eligible: true };
      }
      // byok/premium already crossed the free boundary elsewhere; an UNAVAILABLE route is
      // still never eligible under any policy mode.
      if (accessClass === "UNAVAILABLE") {
        return { eligible: false, code: "UNKNOWN_COST_NOT_AUTHORIZED", reason: "Route is UNAVAILABLE" };
      }
      return { eligible: true };
    }

    const legacyVerifiedFree = model.freeStatus === "verified_free" && model.costProfile.isFree === true;
    if (ctx.policyMode === "adaptive") {
      if (!legacyVerifiedFree) {
        return {
          eligible: false,
          code: model.freeStatus === "paid" ? "PAID_NOT_AUTHORIZED" : "UNKNOWN_COST_NOT_AUTHORIZED",
          reason: `freeStatus=${model.freeStatus} is not eligible for adaptive/free-default routing (no structured accessClass)`,
        };
      }
      return { eligible: true };
    }

    if (model.freeStatus === "unknown") {
      return { eligible: false, code: "UNKNOWN_COST_NOT_AUTHORIZED", reason: "Unknown pricing is never eligible, even under BYOK/premium" };
    }
    return { eligible: true };
  }
}

export function createEightBitEligibilityPolicy(): EightBitEligibilityPolicy {
  return new EightBitEligibilityPolicy();
}

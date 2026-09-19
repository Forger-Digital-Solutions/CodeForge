import type { RunFailure, RunFailureCode, RunFailureOwnership } from "@codeforge/protocol";
import { classifyFailure, type FailureReason } from "@codeforge/eight-bit";

/** CodeForge's own hosted free routing. The user configured no credential for it and cannot fix one. */
export const MANAGED_FREE_PROVIDER_ID = "codeforge-cloud";

export interface RunFailureContext {
  providerId?: string;
  modelId?: string;
  /** Overrides the provider-id heuristic when the caller knows the route's supply class. */
  managed?: boolean;
  /** 8-Bit found no eligible replacement after this failure; the run is over for routing reasons. */
  routeExhausted?: boolean;
}

export function isManagedRoute(providerId: string | undefined): boolean {
  return providerId === MANAGED_FREE_PROVIDER_ID;
}

function ownershipFor(context: RunFailureContext): RunFailureOwnership {
  if (context.providerId === "paid-auto") return "paid";
  if (context.managed ?? isManagedRoute(context.providerId)) return "managed_free";
  return context.providerId ? "byok" : "runtime";
}

const REASON_TO_CODE: Record<FailureReason, RunFailureCode> = {
  AUTH_FAILURE: "provider_auth_failed",
  RATE_LIMITED: "provider_rate_limited",
  QUOTA_EXHAUSTED: "provider_quota_exhausted",
  TEMPORARY_CAPACITY: "provider_capacity",
  PROVIDER_OUTAGE: "provider_outage",
  TIMEOUT: "provider_timeout",
  TRANSIENT_NETWORK: "provider_network",
  MODEL_NOT_FOUND: "model_unavailable",
  MODEL_RETIRED: "model_unavailable",
  PAID_PLAN_REQUIRED: "paid_plan_required",
  FREE_TIER_NOT_AVAILABLE: "paid_plan_required",
  CONTEXT_LIMIT: "context_limit",
  SAFETY_REJECTION: "safety_rejection",
  INVALID_TOOL_OUTPUT: "invalid_model_output",
  STRUCTURED_OUTPUT_FAILURE: "invalid_model_output",
  BAD_REQUEST: "invalid_model_output",
  FREE_ELIGIBILITY_REMOVED: "model_unavailable",
  UNKNOWN: "unknown",
};

/**
 * CodeForge's own [CODE] envelopes (ForgeZero entitlement/eligibility denials, capability gates,
 * catalog misses). These are policy verdicts, not provider failures: ownership says who must act —
 * "paid" means the account, not a credential. The bracketed code stays in the message so the denial
 * reason is never flattened into something unrecognizable.
 */
const FORGE_CODE_FAILURES: Record<string, { code: RunFailureCode; ownership: RunFailureOwnership; retryable: boolean; message: string }> = {
  REQUIRES_SUBSCRIPTION: { code: "paid_plan_required", ownership: "paid", retryable: false, message: "This route requires a paid plan or entitlement this account does not have. CodeForge did not run it" },
  NOT_ENTITLED: { code: "paid_plan_required", ownership: "paid", retryable: false, message: "This route requires a paid plan or entitlement this account does not have. CodeForge did not run it" },
  FORGE_ZERO_VIOLATION: { code: "paid_plan_required", ownership: "paid", retryable: false, message: "The zero-cost policy refused this route. CodeForge did not run it" },
  UNKNOWN_COST_REJECTED: { code: "paid_plan_required", ownership: "paid", retryable: false, message: "This route could cost money, so CodeForge refused it" },
  PAID_FALLBACK_REJECTED: { code: "paid_plan_required", ownership: "paid", retryable: false, message: "This route can fall back to paid usage, so CodeForge refused it" },
  PROVIDER_UNAVAILABLE: { code: "provider_outage", ownership: "runtime", retryable: true, message: "Access to this route could not be confirmed right now, so the run was stopped safely" },
  PROVIDER_MODEL_UNAVAILABLE: { code: "model_unavailable", ownership: "runtime", retryable: true, message: "This route is not available from its provider right now" },
  NOT_FOUND: { code: "model_unavailable", ownership: "runtime", retryable: false, message: "This route is not registered in CodeForge's catalog" },
};

function routeLabel(context: RunFailureContext): string {
  if (!context.modelId) return context.providerId ? `the ${context.providerId} route` : "the selected route";
  const model = context.modelId.includes("::") ? context.modelId.split("::").pop()! : context.modelId;
  return `the ${model} route`;
}

/**
 * The sentence a human reads for a failure, written for whoever owns it. Managed-free wording
 * never mentions "your API key": there is none. BYOK wording says exactly that the configured
 * credential was rejected. Nothing here quotes a provider's raw error body.
 */
export function describeRunFailure(error: unknown, context: RunFailureContext = {}): RunFailure {
  const ownership = ownershipFor(context);
  const managed = ownership === "managed_free";
  const base = { ownership, ...(context.providerId ? { providerId: context.providerId } : {}), ...(context.modelId ? { modelId: context.modelId } : {}) };
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const route = routeLabel(context);
  const detail = raw.length > 0 ? { detail: clip(raw, 300) } : {};

  if (context.routeExhausted) {
    return {
      ...base,
      code: "route_exhausted",
      retryable: true,
      message: managed
        ? "No eligible verified-free route is currently available. CodeForge stopped safely without using a paid or unknown-cost route."
        : "No eligible route is available to continue this task. CodeForge stopped safely without switching to a paid or unknown-cost route.",
    };
  }
  if (/no eligible free route|no admitted, healthy route|no verified free|no free provider/i.test(raw)) {
    return {
      ...base,
      ownership: "managed_free",
      code: "route_exhausted",
      retryable: true,
      message: "No eligible verified-free route is currently available. CodeForge stopped safely without using a paid or unknown-cost route.",
    };
  }
  if (/stopped after \d+ iterations|working budget of/i.test(raw)) {
    return { ...base, ownership: "runtime", code: "budget_exhausted", retryable: true, message: "CodeForge stopped before finishing: the working budget for this run was used up. The task is incomplete and unverified." };
  }
  if (/workflow timed out/i.test(raw)) {
    return { ...base, ownership: "runtime", code: "workflow_timeout", retryable: true, message: "The task ran longer than the allowed time and was stopped. Try a narrower task." };
  }
  if (/user stopped|user cancelled|cancelled by user|stop requested|workflow cancelled/i.test(raw)) {
    return { ...base, ownership: "user", code: "cancelled", retryable: true, message: "Stopped by you." };
  }
  if (/no workspace/i.test(raw)) {
    return { ...base, ownership: "workspace", code: "workspace_error", retryable: false, message: "No workspace is open. Open a project folder first." };
  }

  // CodeForge-authored errors carry a stable [CODE] envelope or a curated sentence. They are not
  // provider output, so the curated text (and its code) is safe — and necessary — to surface: an
  // entitlement denial reported as "a route error we could not classify" would be a lie.
  const forgeCode = raw.match(/^\[([A-Z_]+)\]/)?.[1];
  if (forgeCode) {
    const forge = FORGE_CODE_FAILURES[forgeCode] ?? { code: "unknown" as const, ownership: "runtime" as const, retryable: true, message: "The run was stopped by a CodeForge policy check." };
    return {
      ...base,
      ...detail,
      ownership: forge.ownership,
      code: forge.code,
      retryable: forge.retryable,
      message: `${forge.message} (${forgeCode})`,
    };
  }
  if (/does not support tool calling|cannot run agent tasks/i.test(raw)) {
    return { ...base, ...detail, ownership: "user", code: "model_unavailable", retryable: false, message: clip(raw, 300) };
  }
  if (/^Exact model .+ is (?:temporarily ineligible|no longer registered)/i.test(raw)) {
    return { ...base, ...detail, ownership: "user", code: "model_unavailable", retryable: true, message: clip(raw, 300) };
  }

  const reason = classifyFailure(error);
  const code = REASON_TO_CODE[reason] ?? "unknown";
  switch (code) {
    case "provider_auth_failed":
      return {
        ...base,
        ...detail,
        code,
        retryable: managed,
        message: managed
          ? `A managed free route could not authenticate with its provider (${route}). This is on CodeForge's side, not a credential you configured.`
          : `This provider rejected the configured API credential (${route}). Update it in Settings → Providers.`,
      };
    case "provider_rate_limited":
      return { ...base, ...detail, code, retryable: true, message: managed ? `Free capacity on ${route} is exhausted for now (rate limited).` : `${capitalize(route)} is rate limited right now.` };
    case "provider_quota_exhausted":
      return { ...base, ...detail, code, retryable: true, message: managed ? `The free quota on ${route} is used up until the provider resets it.` : `The quota on ${route} is used up until the provider resets it.` };
    case "provider_capacity":
      return { ...base, ...detail, code, retryable: true, message: `${capitalize(route)} is at capacity right now.` };
    case "provider_outage":
      return { ...base, ...detail, code, retryable: true, message: `${capitalize(route)} returned a server error (provider outage).` };
    case "provider_timeout":
      return { ...base, ...detail, code, retryable: true, message: `${capitalize(route)} did not answer in time.` };
    case "provider_network":
      return { ...base, ...detail, code, retryable: true, message: "The provider could not be reached. Check the network connection." };
    case "model_unavailable":
      return { ...base, ...detail, code, retryable: true, message: `${capitalize(route)} is no longer available from its provider.` };
    case "paid_plan_required":
      return { ...base, ...detail, code, retryable: false, message: `${capitalize(route)} now requires a paid plan. CodeForge did not use it.` };
    case "context_limit":
      return { ...base, ...detail, code, retryable: true, message: "The task's context grew past what the model can hold. Try a narrower task." };
    case "safety_rejection":
      return { ...base, ...detail, code, retryable: false, message: "The provider's safety policy declined this request." };
    case "invalid_model_output":
      return { ...base, ...detail, code, retryable: true, message: "The model returned output CodeForge could not act on." };
    default:
      return { ...base, ...detail, code: "unknown", retryable: true, message: context.providerId ? `${capitalize(route)} returned an error CodeForge could not classify.` : "The run stopped because of an unexpected error." };
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clip(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

import type { AccessClass, AuthMode, PrivacyClass } from "@codeforge/forge-zero";
import type { NormalizedCapabilities, NormalizedPricing } from "./normalized-types.js";
import {
  PROVIDER_DEFINITIONS,
  environmentVariablesFor,
  type FreeAccessClass,
  type ProviderDefinition,
} from "./provider-definitions.js";

export type ProviderTransport = "openai-compatible" | "anthropic-messages" | "internal";
export type ProviderKind = "direct" | "gateway";

/**
 * Coarse CodeForge provider policy — the ForgeZero-facing view of a {@link ProviderDefinition}.
 * Derived, never hand-maintained in two places: the definition registry is the source of truth
 * and this projection keeps every existing consumer (discovery, cloud gateway, tests) working.
 */
export interface ProviderPolicy {
  providerId: string;
  displayName: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  authMode: AuthMode;
  /** Default privacy class of the provider's serving endpoints. */
  privacyClass: PrivacyClass;
  /** Privacy class of the provider's FREE tier specifically, if materially different. */
  freePrivacyClass?: PrivacyClass;
  /** Provider grants a recurring free quota/allowance (Gemini/Groq/Cloudflare/Mistral/SambaNova). */
  hasAllowanceFree?: boolean;
  /** Provider offers only trial credits for otherwise-paid models (Anthropic). */
  hasTrial?: boolean;
  /** Provider has no free access of any kind (OpenAI). */
  paidOnly?: boolean;
  /**
   * The authenticated `/models` endpoint establishes current account availability but does not
   * expose prices. A freshly fetched registry price may supply the zero-unit evidence only for
   * providers whose official pricing is published separately. This is deliberately opt-in:
   * ordinary OpenAI-compatible endpoints must never gain a free grant from an id or name.
   */
  allowLiveCatalogZeroUnitInference?: boolean;
  /** Base URL (may contain ${VAR} templates resolved at connect time). */
  baseUrl?: string;
  /** Env var(s) that carry the credential. */
  env?: string[];
  /** Fine-grained R1 free-access class (see provider-definitions). */
  freeAccessClass: FreeAccessClass;
  /** Allowance model scope copied from the provider definition. */
  allowanceScope?: "all_chat_models" | "allowlist";
  allowanceModels?: string[];
  paidPlanModels?: string[];
}

const ALLOWANCE_CLASSES: readonly FreeAccessClass[] = [
  "FREE_DAILY_ALLOCATION",
  "FREE_MONTHLY_ALLOWANCE",
  "FREE_ACCOUNT_ENTITLEMENT",
];

function authModeFor(def: ProviderDefinition): AuthMode {
  if (def.apiStyle === "hosted") return "HOSTED_RELAY";
  if (def.apiStyle === "internal") return "NONE";
  if (def.authClasses[0] === "OAUTH_PKCE") return "OAUTH_PKCE";
  if (def.connection.fields.some((f) => !f.secret)) return "ACCOUNT_CONNECT";
  return "API_KEY";
}

export function policyFromDefinition(def: ProviderDefinition): ProviderPolicy {
  const transport: ProviderTransport =
    def.apiStyle === "anthropic-messages" ? "anthropic-messages" : def.apiStyle === "hosted" || def.apiStyle === "internal" ? "internal" : "openai-compatible";
  const kind: ProviderKind = def.kind === "gateway" || def.kind === "fds-gateway" ? "gateway" : "direct";
  const env = environmentVariablesFor(def);
  return {
    providerId: def.id,
    displayName: def.displayName,
    kind,
    transport,
    authMode: authModeFor(def),
    privacyClass: def.privacy.class,
    ...(def.privacy.freeTierClass ? { freePrivacyClass: def.privacy.freeTierClass } : {}),
    ...(ALLOWANCE_CLASSES.includes(def.freeAccess.class) && def.kind === "direct" ? { hasAllowanceFree: true } : {}),
    ...(def.hasTrial ? { hasTrial: true } : {}),
    ...(def.paidOnly ? { paidOnly: true } : {}),
    ...(def.allowLiveCatalogZeroUnitInference ? { allowLiveCatalogZeroUnitInference: true } : {}),
    ...(def.baseUrl ? { baseUrl: def.baseUrl } : {}),
    ...(env.length > 0 ? { env } : {}),
    freeAccessClass: def.freeAccess.class,
    ...(def.freeAccess.allowanceScope ? { allowanceScope: def.freeAccess.allowanceScope } : {}),
    ...(def.freeAccess.allowanceModels ? { allowanceModels: [...def.freeAccess.allowanceModels] } : {}),
    ...(def.freeAccess.paidPlanModels ? { paidPlanModels: [...def.freeAccess.paidPlanModels] } : {}),
  };
}

/**
 * Coarse policies for every curated provider definition. Kept as a plain record so existing
 * consumers that iterate it (cloud gateway credential resolution, tests) are unchanged.
 */
export const PROVIDER_POLICIES: Record<string, ProviderPolicy> = Object.fromEntries(
  Object.values(PROVIDER_DEFINITIONS)
    .filter((def) => def.apiStyle !== "internal" && def.apiStyle !== "hosted")
    .map((def) => [def.id, policyFromDefinition(def)]),
);

export function getProviderPolicy(providerId: string): ProviderPolicy | undefined {
  return PROVIDER_POLICIES[providerId];
}

const isZeroUnit = (p: NormalizedPricing): boolean =>
  p.inputPerMillion === 0 && p.outputPerMillion === 0;

/**
 * Derive a CANDIDATE access classification from upstream facts + provider policy.
 * This is not trust: a candidate free class still requires independent CodeForge
 * verification (the overlay) before it can enter Auto free routing.
 *
 * R1: a $0 unit price on a provider whose free access is promotional, development-only, or
 * legally unreviewed is a TRIAL candidate, never FREE_* — NVIDIA's 99 "$0" catalog entries are
 * evaluation credits, not a free tier.
 */
export function deriveAccessClass(
  providerId: string,
  pricing: NormalizedPricing,
  capabilities: NormalizedCapabilities,
  policy: ProviderPolicy | undefined,
): AccessClass {
  // A provider policy is an explicit financial boundary. Even an accidental or stale upstream
  // $0 entry cannot make OpenAI's paid API eligible for ForgeAuto/Free.
  if (policy?.paidOnly) return "PAID";
  if (pricing.inputPerMillion === null || pricing.outputPerMillion === null) {
    // Unknown pricing → never assume free.
    return "PAID";
  }
  if (isZeroUnit(pricing)) {
    const cls = policy?.freeAccessClass;
    if (cls === "PROMOTIONAL_CREDIT" || cls === "FREE_DEV_ENDPOINT" || cls === "LEGAL_REVIEW_REQUIRED" || cls === "FREE_PRODUCT_ONLY") {
      return "TRIAL";
    }
    return policy?.kind === "gateway" ? "FREE_ROUTED" : "FREE_NATIVE";
  }
  // Non-zero unit price. Allowance providers expose a recurring free quota despite the
  // listed paid unit price; mark text chat models as allowance candidates (verified later).
  if (policy?.hasAllowanceFree && capabilities.text && !policy.paidOnly) {
    return "FREE_ALLOWANCE";
  }
  return "PAID";
}

/** Derive the effective privacy class for a model given its access class. */
export function derivePrivacyClass(policy: ProviderPolicy | undefined, accessClass: AccessClass): PrivacyClass {
  if (!policy) return "standard";
  const isAllowanceOrPromo = accessClass === "FREE_ALLOWANCE" || accessClass === "FREE_PROMO";
  if (isAllowanceOrPromo && policy.freePrivacyClass) return policy.freePrivacyClass;
  return policy.privacyClass;
}

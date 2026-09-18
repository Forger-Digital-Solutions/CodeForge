/**
 * Shared, provider-neutral intelligence records. These are observations and policy inputs; they
 * never grant a model route permission or Completion Gate authority on their own.
 */
export interface ModelIdentity {
  /** Stable CodeForge name used for policy, history, and cross-provider comparisons. */
  canonicalModelId: string;
  providerId: string;
  providerModelId: string;
  /** Gateway alias, if the provider is reached through a gateway. */
  gatewayModelId?: string;
  /** Provider-reported served identity, which may expose an unexpected substitution. */
  servedModelId?: string;
  revision?: string;
  region?: string;
  endpoint?: string;
  serviceTier?: string;
}

export interface ProviderIdentity {
  providerId: string;
  endpoint?: string;
  region?: string;
  accountTier?: string;
  serviceTier?: string;
}

export interface CapabilityProfile {
  model: ModelIdentity;
  observedAt: string;
  source: string;
  roleScores: Partial<Record<"EXPLORER" | "PLANNER" | "CODER" | "REVIEWER", number>>;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  contextWindow?: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface HealthProfile {
  provider: ProviderIdentity;
  state: "HEALTHY" | "DEGRADED" | "PROBATION" | "SATURATED" | "QUARANTINED" | "UNAVAILABLE";
  observedAt: string;
  retryAfter?: string;
  recent429Rate?: number;
}

export interface PolicyProfile {
  routeClass: "MANAGED_FREE" | "PAID_AUTO" | "BYOK" | "EXTERNAL_AGENT";
  authorized: boolean;
  reasonCodes: string[];
  observedAt: string;
}

export interface RoleProfile {
  role: "EXPLORER" | "PLANNER" | "CODER" | "REVIEWER";
  capability: CapabilityProfile;
  verifiedSuccessRate?: number;
  firstPassSuccessRate?: number;
}

export interface ProviderIncident {
  incidentId: string;
  provider: ProviderIdentity;
  model?: ModelIdentity;
  category: "RATE_LIMIT" | "OUTAGE" | "AUTH" | "MALFORMED_RESPONSE" | "IDENTITY_SUBSTITUTION" | "UNKNOWN";
  observedAt: string;
  retryAfter?: string;
  evidenceRef: string;
}

export interface DriftEvent {
  eventId: string;
  model: ModelIdentity;
  category: "PRICE" | "CAPABILITY" | "HEALTH" | "IDENTITY" | "AVAILABILITY";
  observedAt: string;
  evidenceRef: string;
}

export interface VerificationOutcome {
  outcomeId: string;
  model: ModelIdentity;
  role: RoleProfile["role"];
  verified: boolean;
  falseCompletion: boolean;
  observedAt: string;
  evidenceRef: string;
}

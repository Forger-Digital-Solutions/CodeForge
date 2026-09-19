import type { FreeModelRecord, ForgeZero, PrivacyClass, AccessClass, SupplyClass } from "@codeforge/forge-zero";
import type { ModelIdentity, ProviderIdentity } from "@codeforge/core";
import { verifyModelEligibility, FREE_ACCESS_CLASSES } from "@codeforge/forge-zero";
import type { ModelQualificationReceipt } from "@codeforge/eight-bit";
import { canonicalIdentityFor, type CanonicalIdentity } from "./canonical.js";
import {
  PROVIDER_DEFINITIONS,
  AUTH_CLASS_FRICTION,
  isZeroCashFreeAccess,
  type AuthClass,
  type FreeAccessClass,
  type ProviderDefinition,
  type TermsStatus,
} from "./provider-definitions.js";
import type { NormalizedModelRegistry } from "./registry.js";

/**
 * 8-Bit Free Cloud Registry (R1 §7-§9, §128-§130).
 *
 * A PROJECTION over the authorities CodeForge already has — ForgeZero (free verification +
 * eligibility), the normalized Models.dev/live catalog (discovery facts), provider connection
 * state (trusted process), 8-Bit health/cooldowns and qualification receipts — that answers the
 * product questions the picker, Settings and ForgeAuto ask:
 *
 *   canonical model → which provider routes exist → which are verified free → which are healthy
 *   → which are qualified → is the model FREE_AVAILABLE / FREE_CONNECT_REQUIRED / … right now.
 *
 * It grants nothing by itself. Every gate here is explained (`admission.failedGate` + `reason`)
 * so diagnostics can show exactly why a route is not in ForgeAuto/Free.
 */

export type CredentialSource = "OAUTH" | "DEVICE_CODE" | "USER_CONNECTED_FREE_API_KEY" | "ENVIRONMENT" | "SECURE_STORAGE" | "MANUAL_BYOK" | "FDS_GATEWAY" | "NONE";
export type FreePolicyState = "ALLOW" | "DENY" | "UNKNOWN";

export interface ProviderConnectionState {
  providerId: string;
  /** Adapter registered with a usable credential. */
  connected: boolean;
  credentialSource: CredentialSource;
  /**
   * Economic source of this connection's capacity. A dev-machine environment key is
   * OWNER_DEV_FREE supply even when the provider's product class is free — connection
   * state must not present it as managed product capacity.
   */
  supplyClass?: SupplyClass;
  /** When `credentialSource === "ENVIRONMENT"`: the variable name (never the value). */
  environmentVariable?: string;
  authState: "ok" | "auth_required" | "rate_limited" | "unknown";
  /** Allowance providers with ACCOUNT_DEPENDENT spillover: user attested the account is on the free plan. */
  planAttested?: boolean;
  /** Provider-specific policy gate for a zero-cash route. Missing state is fail-closed. */
  freePolicyState?: FreePolicyState;
  /** Safe reason code for a denied/unknown free-policy decision; never a credential or payload. */
  freePolicyReason?: string;
  /** Live catalog discovery in flight. */
  discovering?: boolean;
  lastCatalogRefreshAt?: string;
  /** For not-connected providers: the lowest-friction way CodeForge can connect it right now. */
  connectOffer?: { authClass: AuthClass; label: string; environmentVariable?: string; planAttestation?: boolean };
  /** Sanitized metadata for a user-owned Free Cloud connection; never a credential. */
  userConnectedFree?: {
    featureFlag: string;
    supplyClass: "USER_CONNECTED_FREE";
    status: "DISCONNECTED" | "VALIDATING" | "CONNECTED" | "REAUTH_REQUIRED" | "AT_RISK" | "EXHAUSTED";
    capacityScope: "USER_ACCOUNT";
    capacityPoolId?: string;
    capacityIdentity?: string;
    freeOnly: true;
    concurrencyLimit: 1;
    starterModelCount: number;
    includedUsageRemainingUsd?: number;
    includedUsageResetAt?: string;
    capacityConfidence: "HIGH" | "LIMITED" | "UNKNOWN";
    termsStatus: "USER_CONNECTED_FREE_ALLOWED" | "USER_CONNECTED_FREE_PERMISSION_REQUIRED" | "USER_CONNECTED_FREE_TERMS_BLOCKED";
  };
}

export type AdmissionGate =
  | "DISCOVERED"
  | "TERMS_ALLOWED"
  | "AUTH_SUPPORTED"
  | "CONNECTED"
  | "FREE_VERIFIED"
  | "CAPABILITY_VERIFIED"
  | "CODEFORGE_QUALIFIED"
  | "HEALTHY"
  | "FORGEAUTO_ELIGIBLE";

export const ADMISSION_GATES: readonly AdmissionGate[] = [
  "DISCOVERED",
  "TERMS_ALLOWED",
  "AUTH_SUPPORTED",
  "CONNECTED",
  "FREE_VERIFIED",
  "CAPABILITY_VERIFIED",
  "CODEFORGE_QUALIFIED",
  "HEALTHY",
  "FORGEAUTO_ELIGIBLE",
];

export interface AdmissionResult {
  /** Highest gate reached. */
  state: AdmissionGate;
  passed: AdmissionGate[];
  failedGate?: AdmissionGate;
  reason?: string;
}

export type RouteHealth = "HEALTHY" | "DEGRADED" | "COOLDOWN" | "UNAVAILABLE" | "INELIGIBLE" | "AUTH_REQUIRED" | "QUOTA_EXHAUSTED" | "UNKNOWN";

/** Stable product state for capacity-aware routing and UI. It maps detailed internal health
 * evidence into the R13 lifecycle without weakening the underlying admission gates. */
export type FreeRouteOperationalState = "HEALTHY" | "DEGRADED" | "PROBATION" | "SATURATED" | "QUARANTINED" | "UNAVAILABLE";

export type QualificationState = "QUALIFIED" | "PROBATION" | "NOT_QUALIFIED" | "HARD_FAILURE" | "NOT_TESTED" | "STALE";

/** Product-facing model roles (R1 §11). Mapped from 8-Bit's internal role contracts. */
export type ModelRole =
  | "PRIMARY_CODING_AGENT"
  | "PLANNER"
  | "REVIEWER"
  | "FAST_REASONER"
  | "SEARCH_ASSIST"
  | "SUBAGENT"
  | "VERIFIER_ASSIST"
  | "VISION"
  | "SUMMARIZER";

export interface RouteQuota {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  resetAt?: string;
  retryAfterMs?: number;
  observedAt: string;
}

export interface ProviderRouteView {
  routeId: string;
  /** Canonical CodeForge and provider identities are both retained; aliases never replace either. */
  modelIdentity: ModelIdentity;
  providerIdentity: ProviderIdentity;
  canonicalModelId: string;
  providerId: string;
  providerDisplayName: string;
  providerModelId: string;
  displayName: string;
  accessClass?: AccessClass;
  freeAccessClass: FreeAccessClass;
  /** Economic source of this route's capacity (RC-5): managed product supply, the user's own account, dev-owner keys, trial credit, or paid. */
  supplyClass?: SupplyClass;
  authClass: AuthClass;
  credentialSource: CredentialSource;
  connected: boolean;
  priceEvidence?: string;
  priceEvidenceAt?: string;
  verifiedFree: boolean;
  quota?: RouteQuota;
  toolSupport: boolean;
  structuredOutput: boolean;
  vision: boolean;
  contextWindow?: number;
  privacyClass?: PrivacyClass;
  termsStatus: TermsStatus;
  health: RouteHealth;
  capacityState: FreeRouteOperationalState;
  cooldownUntil?: number;
  qualificationState: QualificationState;
  roles: ModelRole[];
  qualificationVersion?: string;
  roleSuitability?: Record<string, QualificationState>;
  capacityEvidence?: FreeModelRecord["capacityEvidence"];
  lifecycle?: FreeModelRecord["lifecycle"];
  replacementCandidate?: FreeModelRecord["replacementCandidate"];
  lastSuccessfulRuntimeProof?: FreeModelRecord["lastSuccessfulRuntimeProof"];
  admission: AdmissionResult;
  forgeAutoEligible: boolean;
  /** True when the route can execute right now for an explicit (non-Auto) selection. */
  executable: boolean;
  deprecated: boolean;
}

export type ModelReadiness =
  | "FREE_AVAILABLE"
  | "FREE_CONNECT_REQUIRED"
  | "FREE_TEMPORARILY_UNAVAILABLE"
  | "PAID_BYOK"
  | "UNSUPPORTED";

export type ModelCategory = "Recommended" | "Strong" | "Fast" | "Experimental" | "Unrated" | "Paid";

export interface CanonicalModelView {
  canonicalId: string;
  displayName: string;
  family: string;
  lab: string;
  routes: ProviderRouteView[];
  readiness: ModelReadiness;
  freeRouteCount: number;
  healthyFreeRouteCount: number;
  connectedFreeRouteCount: number;
  /** Best connection offer when readiness is FREE_CONNECT_REQUIRED. */
  connectOffer?: { providerId: string; providerDisplayName: string; authClass: AuthClass; label: string; environmentVariable?: string; planAttestation?: boolean };
  capabilities: { toolCalling: boolean; structuredOutput: boolean; vision: boolean; reasoning: boolean };
  contextWindow?: number;
  qualificationState: QualificationState;
  roles: ModelRole[];
  recommendedRole?: ModelRole;
  category: ModelCategory;
  forgeAutoEligible: boolean;
  /** Free-badge text that is truthful for the current state (R1 §125). */
  freeBadge: string;
}

export interface FreeCandidate {
  canonicalModel: CanonicalModelView;
  healthyRoutes: ProviderRouteView[];
  forgeAutoEligible: boolean;
  recommendedRole?: ModelRole;
  reason: string;
}

export interface FreeCloudSummary {
  canonicalModels: number;
  /** Catalog records verified free — verification evidence, NOT a runnable guarantee. */
  verifiedFreeModels: number;
  verifiedFreeRoutes: number;
  /** Routes that survived the full admission pipeline — the honest "healthy" count. */
  healthyFreeRoutes: number;
  connectedProviders: number;
  coolingDown: number;
  primaryCodingModels: number;
  paidRoutesExcluded: number;
  sameModelMultiProviderModels: number;
  /** Models runnable right now on free supply (readiness FREE_AVAILABLE). */
  runnableFreeModels: number;
  /** Capability verdict only: QUALIFIED for PRIMARY_CODING_AGENT, runnable or not (RC-6). */
  qualifiedPrimaryCodingModels: number;
  /** Qualified AND runnable — the honest "Recommended" count a user can act on. */
  recommendedModels: number;
  /** Free routes by economic supply source (RC-5). */
  managedFreeRoutes: number;
  userOwnedFreeRoutes: number;
  ownerDevFreeRoutes: number;
}

export interface FreeCloudSnapshot {
  generatedAt: string;
  summary: FreeCloudSummary;
  models: CanonicalModelView[];
  providers: ProviderConnectionState[];
}

export interface FreeCloudInputs {
  firewall: ForgeZero;
  /** Discovery candidates that are not (yet) in ForgeZero (e.g. Models.dev routes for unconnected providers). */
  registry?: NormalizedModelRegistry;
  connections: ProviderConnectionState[];
  definitions?: Record<string, ProviderDefinition>;
  qualification?: Map<string, ModelQualificationReceipt>;
  /** 8-Bit route cooldown/health lookup. */
  routeHealth?: (providerId: string, modelId: string) => { status: RouteHealth; cooldownUntil?: number } | undefined;
  quota?: (providerId: string, modelId: string) => RouteQuota | undefined;
  now?: () => Date;
}

const NON_CHAT_RE = /whisper|embed|tts|\bstt\b|lyria|guard|safety|moderation|rerank|orpheus|prompt-guard|content-safety|image|veo|imagen/i;

function routeKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function bestAuthClass(def: ProviderDefinition | undefined, conn: ProviderConnectionState | undefined): AuthClass {
  if (conn?.connected) {
    if (conn.credentialSource === "OAUTH") return "OAUTH_PKCE";
    if (conn.credentialSource === "USER_CONNECTED_FREE_API_KEY") return "ASSISTED_KEY";
    if (conn.credentialSource === "FDS_GATEWAY") return "ZERO_TOUCH";
    if (conn.credentialSource === "ENVIRONMENT") return "ENVIRONMENT_CREDENTIAL";
    return "ASSISTED_KEY";
  }
  if (conn?.connectOffer) return conn.connectOffer.authClass;
  return def?.authClasses[0] ?? "UNSUPPORTED";
}

function qualificationFor(receipt: ModelQualificationReceipt | undefined, now: Date): { state: QualificationState; roles: ModelRole[]; version?: string; roleSuitability?: Record<string, QualificationState> } {
  if (!receipt) return { state: "NOT_TESTED", roles: [] };
  const ageMs = now.getTime() - new Date(receipt.completedAt).getTime();
  if (!(ageMs < 30 * 24 * 60 * 60 * 1000)) return { state: "STALE", roles: [], version: receipt.suiteVersion };
  const qualified = new Set(Object.entries(receipt.roleResults).filter(([, r]) => r.status === "QUALIFIED").map(([role]) => role));
  const roleSuitability = Object.fromEntries(
    Object.entries(receipt.roleResults).map(([role, result]) => [role, result.status as QualificationState]),
  );
  const roles: ModelRole[] = [];
  if (qualified.has("CODER") || qualified.has("TOOL_AGENT")) roles.push("PRIMARY_CODING_AGENT");
  if (qualified.has("PLANNER")) roles.push("PLANNER");
  if (qualified.has("REVIEWER")) roles.push("REVIEWER", "VERIFIER_ASSIST");
  if (qualified.has("FAST_WORKER") || qualified.has("REASONER")) roles.push("FAST_REASONER");
  if (qualified.has("TOOL_AGENT")) roles.push("SUBAGENT");
  if (qualified.has("VISION")) roles.push("VISION");
  if (qualified.has("ANALYST")) roles.push("SEARCH_ASSIST", "SUMMARIZER");
  const state: QualificationState =
    receipt.qualificationState === "QUALIFIED" ? "QUALIFIED"
      : receipt.qualificationState === "PROBATION" ? "PROBATION"
        : receipt.qualificationState === "HARD_FAILURE" ? "HARD_FAILURE"
          : "NOT_QUALIFIED";
  return { state, roles: [...new Set(roles)], version: receipt.suiteVersion, roleSuitability };
}

function healthFrom(model: FreeModelRecord | undefined, live: { status: RouteHealth; cooldownUntil?: number } | undefined, conn: ProviderConnectionState | undefined, now: Date): { health: RouteHealth; cooldownUntil?: number } {
  if (conn && conn.authState === "auth_required") return { health: "AUTH_REQUIRED" };
  if (live) {
    if (live.status === "COOLDOWN" && live.cooldownUntil !== undefined && live.cooldownUntil <= now.getTime()) {
      return { health: "HEALTHY" };
    }
    return { health: live.status, cooldownUntil: live.cooldownUntil };
  }
  const s = model?.health?.status;
  if (!s || s === "unknown" || s === "configured") return { health: "UNKNOWN" };
  if (s === "auth_required") return { health: "AUTH_REQUIRED" };
  if (s === "quota_exhausted") return { health: "QUOTA_EXHAUSTED" };
  if (s === "rate_limited") {
    const until = model?.health?.retryAfter;
    if (until !== undefined && until > now.getTime()) return { health: "COOLDOWN", cooldownUntil: until };
    return { health: "DEGRADED" };
  }
  if (s === "offline") return { health: "UNAVAILABLE" };
  if (s === "degraded") return { health: "DEGRADED" };
  return { health: "HEALTHY" };
}

/**
 * A successful response can expose an exhausted allowance before a 429 is issued.  Treat that
 * provider-provided observation as a temporary hard admission fact, but only while its explicit
 * reset horizon is still in the future.  This deliberately never manufactures a quota or reset.
 */
function healthWithObservedQuota(
  health: { health: RouteHealth; cooldownUntil?: number },
  quota: RouteQuota | undefined,
  now: Date,
): { health: RouteHealth; cooldownUntil?: number } {
  if (health.health !== "HEALTHY" && health.health !== "DEGRADED" && health.health !== "UNKNOWN") return health;
  const resetAt = quota?.resetAt === undefined ? Number.NaN : Date.parse(quota.resetAt);
  const exhausted = quota?.remainingRequests === 0 || quota?.remainingTokens === 0;
  if (exhausted && Number.isFinite(resetAt) && resetAt > now.getTime()) {
    return { health: "QUOTA_EXHAUSTED", cooldownUntil: resetAt };
  }
  return health;
}

function operationalStateFor(health: RouteHealth, qualification: QualificationState): FreeRouteOperationalState {
  if (health === "COOLDOWN" || health === "QUOTA_EXHAUSTED") return "SATURATED";
  if (health === "UNAVAILABLE" || health === "AUTH_REQUIRED") return "UNAVAILABLE";
  if (health === "INELIGIBLE" || qualification === "HARD_FAILURE") return "QUARANTINED";
  if (health === "DEGRADED") return "DEGRADED";
  if (health === "UNKNOWN" || qualification === "PROBATION" || qualification === "NOT_TESTED" || qualification === "STALE") return "PROBATION";
  return "HEALTHY";
}

/**
 * Evaluate the admission pipeline for one route. Deterministic and side-effect free.
 */
export function evaluateAdmission(input: {
  def: ProviderDefinition | undefined;
  conn: ProviderConnectionState | undefined;
  model: FreeModelRecord | undefined;
  firewall: ForgeZero;
  toolSupport: boolean;
  qualification: QualificationState;
  health: RouteHealth;
  roles: ModelRole[];
}): AdmissionResult {
  const passed: AdmissionGate[] = ["DISCOVERED"];
  const fail = (gate: AdmissionGate, reason: string): AdmissionResult => ({ state: passed[passed.length - 1]!, passed, failedGate: gate, reason });
  const { def, conn, model } = input;

  if (!def) return fail("TERMS_ALLOWED", "No CodeForge provider definition — unreviewed provider");
  if (def.terms.status === "NOT_ALLOWED") return fail("TERMS_ALLOWED", "Provider terms do not allow third-party client use");
  if (def.terms.status === "LEGAL_REVIEW_REQUIRED") return fail("TERMS_ALLOWED", "Provider terms require legal review before default routing");
  if (def.terms.status === "DEVELOPMENT_ONLY") return fail("TERMS_ALLOWED", "Development/evaluation endpoint — not production free routing");
  if (!isZeroCashFreeAccess(def.freeAccess.class)) {
    return fail("TERMS_ALLOWED", `Free-access class ${def.freeAccess.class} is not zero-cash`);
  }
  passed.push("TERMS_ALLOWED");

  if (!def.implemented || def.authClasses[0] === "UNSUPPORTED") return fail("AUTH_SUPPORTED", "No supported connection method");
  passed.push("AUTH_SUPPORTED");

  if (!conn?.connected) return fail("CONNECTED", conn?.connectOffer ? `Not connected — ${conn.connectOffer.label}` : "Not connected");
  if (conn.authState === "auth_required") return fail("CONNECTED", "Credential rejected by provider");
  passed.push("CONNECTED");

  if (def.id === "google" && conn.freePolicyState !== "ALLOW") {
    return fail("FREE_VERIFIED", `Gemini free policy gate ${conn.freePolicyReason ?? "not accepted"}`);
  }

  if (def.freeAccess.spillover === "ACCOUNT_DEPENDENT" && !conn.planAttested) {
    return fail("FREE_VERIFIED", "Free plan not confirmed for this account — exhausting the allowance could bill a paid plan");
  }
  if (!model) return fail("FREE_VERIFIED", "Not yet listed by the connected provider's live catalog");
  const verification = verifyModelEligibility(model, {
    now: () => new Date(),
    providerOracle: { isActive: () => true },
    requireOngoingFree: true,
  });
  if (!verification.eligible) return fail("FREE_VERIFIED", verification.reason);
  passed.push("FREE_VERIFIED");

  if (!input.toolSupport) return fail("CAPABILITY_VERIFIED", "No native tool calling — cannot drive the agent loop");
  passed.push("CAPABILITY_VERIFIED");

  if (input.qualification === "HARD_FAILURE" || input.qualification === "NOT_QUALIFIED") {
    return fail("CODEFORGE_QUALIFIED", `CodeForge qualification: ${input.qualification}`);
  }
  if (input.qualification === "STALE") return fail("CODEFORGE_QUALIFIED", "Qualification receipt is stale");
  if (input.qualification === "NOT_TESTED") return fail("CODEFORGE_QUALIFIED", "Not yet qualified by 8-Bit");
  passed.push("CODEFORGE_QUALIFIED");

  if (input.health === "COOLDOWN") return fail("HEALTHY", "Route is cooling down after provider failures");
  if (input.health === "UNAVAILABLE" || input.health === "AUTH_REQUIRED" || input.health === "QUOTA_EXHAUSTED" || input.health === "INELIGIBLE") {
    return fail("HEALTHY", `Route health is ${input.health}`);
  }
  passed.push("HEALTHY");

  if (!input.firewall.canRouteTo(model.providerId, model.modelId)) {
    return fail("FORGEAUTO_ELIGIBLE", "ForgeZero eligibility failed (privacy mode, provider oracle, or freshness)");
  }
  passed.push("FORGEAUTO_ELIGIBLE");
  return { state: "FORGEAUTO_ELIGIBLE", passed };
}

interface RouteSeed {
  providerId: string;
  modelId: string;
  displayName: string;
  model?: FreeModelRecord;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  reasoning: boolean;
  contextWindow?: number;
  accessClass?: AccessClass;
  privacyClass?: PrivacyClass;
  deprecated: boolean;
}

/**
 * Build the registry snapshot. Routes come from ForgeZero (connected/verified state) and,
 * for discovery, from the normalized registry's free candidates for providers CodeForge
 * knows how to connect — so a fresh install can still show "GPT-OSS 120B · Free · Connect".
 */
export function buildFreeCloudSnapshot(inputs: FreeCloudInputs): FreeCloudSnapshot {
  const now = (inputs.now ?? (() => new Date()))();
  const definitions = inputs.definitions ?? PROVIDER_DEFINITIONS;
  const connections = new Map(inputs.connections.map((c) => [c.providerId, c] as const));
  const seeds = new Map<string, RouteSeed>();

  for (const m of inputs.firewall.allModels()) {
    if (m.tier === "gems_paid") continue;
    if (NON_CHAT_RE.test(m.modelId)) continue;
    seeds.set(routeKey(m.providerId, m.modelId), {
      providerId: m.providerId,
      modelId: m.modelId,
      displayName: m.displayName,
      model: m,
      toolCalling: m.capabilities.toolCalling,
      structuredOutput: m.capabilities.structuredOutput,
      vision: m.capabilities.vision,
      reasoning: false,
      contextWindow: m.contextWindow,
      accessClass: m.accessClass,
      privacyClass: m.privacyClass,
      deprecated: m.deprecated === true,
    });
  }
  if (inputs.registry) {
    for (const r of inputs.registry.freeCandidates()) {
      const key = routeKey(r.providerId, r.modelId);
      if (seeds.has(key)) continue;
      const def = definitions[r.providerId];
      if (!def || !def.implemented) continue;
      if (NON_CHAT_RE.test(r.modelId)) continue;
      if (!r.capabilities.toolCalling) continue;
      seeds.set(key, {
        providerId: r.providerId,
        modelId: r.modelId,
        displayName: r.displayName,
        toolCalling: r.capabilities.toolCalling,
        structuredOutput: r.capabilities.structuredOutput,
        vision: r.capabilities.vision,
        reasoning: r.capabilities.reasoning,
        contextWindow: r.contextWindow,
        accessClass: r.accessClass,
        privacyClass: r.privacyClass,
        deprecated: r.deprecated,
      });
    }
  }

  const routes: ProviderRouteView[] = [];
  const identities = new Map<string, CanonicalIdentity>();
  for (const seed of seeds.values()) {
    const def = definitions[seed.providerId];
    const conn = connections.get(seed.providerId);
    const identity = canonicalIdentityFor(seed.providerId, seed.modelId, seed.displayName);
    if (!identities.has(identity.canonicalId)) identities.set(identity.canonicalId, identity);
    const receipt = inputs.qualification?.get(routeKey(seed.providerId, seed.modelId));
    const q = qualificationFor(receipt, now);
    const live = inputs.routeHealth?.(seed.providerId, seed.modelId);
    const quota = inputs.quota?.(seed.providerId, seed.modelId);
    const h = healthWithObservedQuota(healthFrom(seed.model, live, conn, now), quota, now);
    const admission = evaluateAdmission({
      def,
      conn,
      model: seed.model,
      firewall: inputs.firewall,
      toolSupport: seed.toolCalling,
      qualification: q.state,
      health: h.health,
      roles: q.roles,
    });
    const verifiedFree = seed.model?.freeStatus === "verified_free";
    const executionBlockedHealth: readonly RouteHealth[] = ["COOLDOWN", "UNAVAILABLE", "AUTH_REQUIRED", "QUOTA_EXHAUSTED", "INELIGIBLE"];
    const freePolicyBlocked = def?.id === "google" && conn?.freePolicyState !== "ALLOW";
    const executable = !!seed.model && !!conn?.connected && conn.authState !== "auth_required" && !freePolicyBlocked && inputs.firewall.canRouteTo(seed.providerId, seed.modelId) && !executionBlockedHealth.includes(h.health);
    routes.push({
      routeId: routeKey(seed.providerId, seed.modelId),
      modelIdentity: {
        canonicalModelId: identity.canonicalId,
        providerId: seed.providerId,
        providerModelId: seed.modelId,
        ...(seed.providerId === "openrouter" ? { gatewayModelId: seed.modelId } : {}),
      },
      providerIdentity: {
        providerId: seed.providerId,
        ...(conn?.planAttested === undefined ? {} : { accountTier: conn.planAttested ? "free-attested" : "unattested" }),
      },
      canonicalModelId: identity.canonicalId,
      providerId: seed.providerId,
      providerDisplayName: def?.displayName ?? seed.providerId,
      providerModelId: seed.modelId,
      displayName: identity.displayName,
      accessClass: seed.accessClass,
      freeAccessClass: def?.freeAccess.class ?? "LEGAL_REVIEW_REQUIRED",
      supplyClass: supplyClassFor(def, conn),
      authClass: bestAuthClass(def, conn),
      credentialSource: conn?.credentialSource ?? "NONE",
      connected: conn?.connected === true,
      priceEvidence: seed.model?.verificationSource ?? seed.model?.costProfile.source,
      priceEvidenceAt: seed.model?.freeStatusVerifiedAt ?? seed.model?.lastVerified,
      verifiedFree,
      quota,
      toolSupport: seed.toolCalling,
      structuredOutput: seed.structuredOutput,
      vision: seed.vision,
      contextWindow: seed.contextWindow,
      privacyClass: seed.privacyClass,
      termsStatus: def?.terms.status ?? "LEGAL_REVIEW_REQUIRED",
      health: h.health,
      capacityState: operationalStateFor(h.health, q.state),
      cooldownUntil: h.cooldownUntil,
      qualificationState: q.state,
      roles: q.roles,
      qualificationVersion: q.version,
      roleSuitability: q.roleSuitability,
      capacityEvidence: seed.model?.capacityEvidence,
      lifecycle: seed.model?.lifecycle,
      replacementCandidate: seed.model?.replacementCandidate,
      lastSuccessfulRuntimeProof: seed.model?.lastSuccessfulRuntimeProof,
      admission,
      forgeAutoEligible: admission.state === "FORGEAUTO_ELIGIBLE",
      executable,
      deprecated: seed.deprecated,
    });
  }

  const models = buildCanonicalViews(routes, identities, definitions, connections);
  const summary = summarize(models, routes, inputs.connections);
  return { generatedAt: now.toISOString(), summary, models, providers: inputs.connections };
}

/**
 * The economic source of a route's capacity (RC-5). More precise than "connected" or
 * `freeAccess.class`: an OpenRouter key sitting in a dev's environment is OWNER_DEV_FREE supply
 * even though the provider product legitimately offers $0 routes, and the hosted first-party
 * gateway is PURE_MANAGED_FREE regardless of what credential shape its session uses.
 */
export function supplyClassFor(
  def: ProviderDefinition | undefined,
  conn: Pick<ProviderConnectionState, "credentialSource" | "connected"> | undefined,
): SupplyClass | undefined {
  if (def?.userConnectedFree) return def.userConnectedFree.supplyClass;
  if (conn?.credentialSource === "FDS_GATEWAY" || def?.apiStyle === "hosted" || def?.kind === "fds-gateway") {
    return "PURE_MANAGED_FREE";
  }
  if (conn?.credentialSource === "ENVIRONMENT") return "OWNER_DEV_FREE";
  if (conn?.connected && conn.credentialSource !== "NONE") return "USER_CONNECTED_FREE";
  switch (def?.freeAccess.class) {
    case "PAID_API": return "PAID";
    case "PROMOTIONAL_CREDIT": return "PROMOTIONAL_FREE";
    case "FREE_DEV_ENDPOINT": return "OWNER_DEV_FREE";
    case "FREE_PRODUCT_ONLY": return "PURE_MANAGED_FREE";
    case "UNAVAILABLE":
    case "LEGAL_REVIEW_REQUIRED":
    case undefined: return undefined;
    default: return "USER_CONNECTED_FREE";
  }
}

/**
 * A route counts as free only when BOTH the provider's access class is zero-cash AND the route's
 * own ForgeZero access class is free (a paid model on a free-capable gateway is still paid).
 */
function isFreeRoute(r: ProviderRouteView): boolean {
  if (!isZeroCashFreeAccess(r.freeAccessClass) || r.termsStatus !== "CLEARED") return false;
  if (r.accessClass === undefined) return true;
  return FREE_ACCESS_CLASSES.includes(r.accessClass);
}

/**
 * User-facing category derived ONLY from CodeForge qualification evidence (R1 §166): no numeric
 * marketing scores, and no verdict at all before 8-Bit has tested the model. RC-6: qualification
 * is a capability verdict, not a runnable verdict — "Recommended" additionally requires the model
 * to be runnable right now, or a user sees "Recommended" on a model that cannot execute.
 */
function categoryFor(view: Omit<CanonicalModelView, "category" | "freeBadge">): ModelCategory {
  if (view.readiness === "PAID_BYOK") return "Paid";
  const runnable = view.readiness === "FREE_AVAILABLE";
  if (view.qualificationState === "QUALIFIED" && view.roles.includes("PRIMARY_CODING_AGENT")) {
    return runnable ? "Recommended" : "Strong";
  }
  if (view.qualificationState === "QUALIFIED") return "Strong";
  if (view.qualificationState === "PROBATION") return (view.contextWindow ?? 0) < 64_000 ? "Fast" : "Strong";
  if (view.qualificationState === "NOT_QUALIFIED" || view.qualificationState === "HARD_FAILURE") return "Experimental";
  return "Unrated";
}

function freeBadgeFor(view: Omit<CanonicalModelView, "category" | "freeBadge">): string {
  switch (view.readiness) {
    case "FREE_AVAILABLE": {
      const executable = view.routes.filter((r) => r.executable && isFreeRoute(r)).length;
      return executable > 1 ? `Free · ${executable} routes` : "Free · Ready";
    }
    case "FREE_CONNECT_REQUIRED":
      return "Free · Connect";
    case "FREE_TEMPORARILY_UNAVAILABLE":
      return "Free · Temporarily unavailable";
    case "PAID_BYOK":
      return "Paid · BYOK";
    default:
      return "Unsupported";
  }
}

function buildCanonicalViews(
  routes: ProviderRouteView[],
  identities: Map<string, CanonicalIdentity>,
  definitions: Record<string, ProviderDefinition>,
  connections: Map<string, ProviderConnectionState>,
): CanonicalModelView[] {
  const byCanonical = new Map<string, ProviderRouteView[]>();
  for (const r of routes) {
    const list = byCanonical.get(r.canonicalModelId) ?? [];
    list.push(r);
    byCanonical.set(r.canonicalModelId, list);
  }
  const views: CanonicalModelView[] = [];
  for (const [canonicalId, list] of byCanonical) {
    const identity = identities.get(canonicalId)!;
    const free = list.filter(isFreeRoute);
    const healthyFree = free.filter((r) => r.forgeAutoEligible);
    const connectedFree = free.filter((r) => r.connected);
    const executableFree = free.filter((r) => r.executable);
    let readiness: ModelReadiness;
    let connectOffer: CanonicalModelView["connectOffer"];
    if (free.length === 0) {
      readiness = list.some((r) => r.connected && r.executable) ? "PAID_BYOK" : list.some((r) => definitions[r.providerId]?.implemented) ? "PAID_BYOK" : "UNSUPPORTED";
    } else if (executableFree.length > 0) {
      readiness = "FREE_AVAILABLE";
    } else if (connectedFree.some((r) => /free plan not confirmed/i.test(r.admission.reason ?? ""))) {
      // Connected, but the account's free plan is unconfirmed: one click away, not "unavailable".
      const r = connectedFree.find((x) => /free plan not confirmed/i.test(x.admission.reason ?? ""))!;
      readiness = "FREE_CONNECT_REQUIRED";
      connectOffer = {
        providerId: r.providerId,
        providerDisplayName: r.providerDisplayName,
        authClass: r.authClass,
        label: `Confirm ${r.providerDisplayName} account is on the free plan`,
        planAttestation: true,
      };
    } else if (connectedFree.some((r) => /Gemini free policy gate/i.test(r.admission.reason ?? ""))) {
      const r = connectedFree.find((x) => /Gemini free policy gate/i.test(x.admission.reason ?? ""))!;
      readiness = "FREE_CONNECT_REQUIRED";
      connectOffer = {
        providerId: r.providerId,
        providerDisplayName: r.providerDisplayName,
        authClass: r.authClass,
        label: "Accept the Gemini Free Tier policy notice",
      };
    } else if (connectedFree.length > 0) {
      readiness = "FREE_TEMPORARILY_UNAVAILABLE";
    } else {
      readiness = "FREE_CONNECT_REQUIRED";
      const offers = free
        .map((r) => {
          const conn = connections.get(r.providerId);
          const def = definitions[r.providerId];
          const authClass = conn?.connectOffer?.authClass ?? def?.authClasses[0] ?? "UNSUPPORTED";
          const label = conn?.connectOffer?.label ?? defaultOfferLabel(def, authClass);
          return { providerId: r.providerId, providerDisplayName: r.providerDisplayName, authClass, label, environmentVariable: conn?.connectOffer?.environmentVariable };
        })
        .filter((o) => o.authClass !== "UNSUPPORTED")
        .sort((a, b) => AUTH_CLASS_FRICTION[a.authClass] - AUTH_CLASS_FRICTION[b.authClass]);
      connectOffer = offers[0];
      if (!connectOffer) readiness = "UNSUPPORTED";
    }
    const qualStates = list.map((r) => r.qualificationState);
    const qualificationState: QualificationState = qualStates.includes("QUALIFIED")
      ? "QUALIFIED"
      : qualStates.includes("PROBATION")
        ? "PROBATION"
        : qualStates.includes("HARD_FAILURE")
          ? "HARD_FAILURE"
          : qualStates.includes("NOT_QUALIFIED")
            ? "NOT_QUALIFIED"
            : qualStates.includes("STALE")
              ? "STALE"
              : "NOT_TESTED";
    const roles = [...new Set(list.flatMap((r) => r.roles))];
    const recommendedRole = roles.includes("PRIMARY_CODING_AGENT") ? "PRIMARY_CODING_AGENT" : roles[0];
    const base = {
      canonicalId,
      displayName: identity.displayName,
      family: identity.family,
      lab: identity.lab,
      routes: list,
      readiness,
      freeRouteCount: free.length,
      healthyFreeRouteCount: healthyFree.length,
      connectedFreeRouteCount: connectedFree.length,
      connectOffer,
      capabilities: {
        toolCalling: list.some((r) => r.toolSupport),
        structuredOutput: list.some((r) => r.structuredOutput),
        vision: list.some((r) => r.vision),
        reasoning: false,
      },
      contextWindow: list.reduce<number | undefined>((max, r) => (r.contextWindow !== undefined && (max === undefined || r.contextWindow > max) ? r.contextWindow : max), undefined),
      qualificationState,
      roles,
      recommendedRole,
      forgeAutoEligible: healthyFree.length > 0,
    };
    views.push({ ...base, category: categoryFor(base), freeBadge: freeBadgeFor(base) });
  }
  return views.sort(compareModels);
}

function defaultOfferLabel(def: ProviderDefinition | undefined, authClass: AuthClass): string {
  const name = def?.displayName ?? "provider";
  switch (authClass) {
    case "ZERO_TOUCH":
      return `Available through ${name}`;
    case "OAUTH_PKCE":
    case "OAUTH_NATIVE":
      return `${name} · one-click account connection`;
    case "DEVICE_CODE":
      return `${name} · device login`;
    case "ENVIRONMENT_CREDENTIAL":
      return `${name} · use detected environment credential`;
    case "ASSISTED_KEY":
      return `${name} · provider key required`;
    default:
      return `${name} · unsupported`;
  }
}

const READINESS_ORDER: Record<ModelReadiness, number> = {
  FREE_AVAILABLE: 0,
  FREE_TEMPORARILY_UNAVAILABLE: 1,
  FREE_CONNECT_REQUIRED: 2,
  PAID_BYOK: 3,
  UNSUPPORTED: 4,
};
const CATEGORY_ORDER: Record<ModelCategory, number> = { Recommended: 0, Strong: 1, Fast: 2, Unrated: 3, Experimental: 4, Paid: 5 };

function compareModels(a: CanonicalModelView, b: CanonicalModelView): number {
  const r = READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness];
  if (r !== 0) return r;
  const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (c !== 0) return c;
  const routes = b.healthyFreeRouteCount - a.healthyFreeRouteCount;
  if (routes !== 0) return routes;
  return a.displayName.localeCompare(b.displayName);
}

function summarize(models: CanonicalModelView[], routes: ProviderRouteView[], connections: ProviderConnectionState[]): FreeCloudSummary {
  const freeRoutes = routes.filter(isFreeRoute);
  const qualifiedPrimary = (m: CanonicalModelView) => m.qualificationState === "QUALIFIED" && m.roles.includes("PRIMARY_CODING_AGENT");
  return {
    canonicalModels: models.length,
    verifiedFreeModels: models.filter((m) => m.routes.some((r) => isFreeRoute(r) && r.verifiedFree)).length,
    verifiedFreeRoutes: freeRoutes.filter((r) => r.verifiedFree).length,
    healthyFreeRoutes: freeRoutes.filter((r) => r.forgeAutoEligible).length,
    connectedProviders: connections.filter((c) => c.connected).length,
    coolingDown: routes.filter((r) => r.health === "COOLDOWN").length,
    primaryCodingModels: models.filter((m) => m.forgeAutoEligible && m.roles.includes("PRIMARY_CODING_AGENT")).length,
    paidRoutesExcluded: routes.filter((r) => !isFreeRoute(r)).length,
    sameModelMultiProviderModels: models.filter((m) => new Set(m.routes.filter(isFreeRoute).map((r) => r.providerId)).size > 1).length,
    runnableFreeModels: models.filter((m) => m.readiness === "FREE_AVAILABLE").length,
    qualifiedPrimaryCodingModels: models.filter(qualifiedPrimary).length,
    recommendedModels: models.filter((m) => qualifiedPrimary(m) && m.readiness === "FREE_AVAILABLE").length,
    managedFreeRoutes: freeRoutes.filter((r) => r.supplyClass === "PURE_MANAGED_FREE").length,
    userOwnedFreeRoutes: freeRoutes.filter((r) => r.supplyClass === "USER_CONNECTED_FREE" || r.supplyClass === "DISTRIBUTED_USER_FREE").length,
    ownerDevFreeRoutes: freeRoutes.filter((r) => r.supplyClass === "OWNER_DEV_FREE").length,
  };
}

/** ForgeAuto's candidate pool: canonical models with ≥1 FORGEAUTO_ELIGIBLE route. */
export function freeCandidates(snapshot: FreeCloudSnapshot): FreeCandidate[] {
  return snapshot.models
    .filter((m) => m.forgeAutoEligible)
    .map((m) => ({
      canonicalModel: m,
      healthyRoutes: m.routes.filter((r) => r.forgeAutoEligible),
      forgeAutoEligible: true,
      recommendedRole: m.recommendedRole,
      reason: `${m.healthyFreeRouteCount} healthy free route(s); qualification ${m.qualificationState}`,
    }));
}

/** Diagnostics: one line per route explaining its pipeline position (R1 §129, §184). */
export function explainRoute(route: ProviderRouteView): string {
  const stage = route.admission.failedGate ? `${route.admission.state} → blocked at ${route.admission.failedGate}: ${route.admission.reason}` : "FORGEAUTO_ELIGIBLE";
  return `${route.providerDisplayName} · ${route.freeAccessClass} · ${route.connected ? "Connected" : "Not connected"} · ${route.toolSupport ? "Tool capable" : "No tools"} · ${route.qualificationState} · ${route.health} · ${stage}`;
}

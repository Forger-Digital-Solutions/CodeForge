import {
  DEFAULT_FREE_CAPACITY_POLICY,
  freeRouteExclusionReason,
  type CapacityPoolScope,
  type CapacityRoute,
  type CapacityScope,
  type CapacityWindow,
  type FreeCapacityPolicy,
  type FreeProviderLifecycle,
  type ProviderCapacityPool,
  type QuotaPeriod,
  type RouteDataContext,
  type SupplyClass,
} from "@codeforge/forge-zero";
import type { EightBitMeasuredHealthRecord, EightBitMeasuredHealthState } from "./measured-health.js";

/**
 * The 8-Bit route ledger is a read projection over ForgeZero's authoritative capacity model:
 * every row joins a route's declared windows, its physical capacity pool, measured health, and
 * provider terms into one flat evidence row. Ownership domains are part of the schema, not a
 * convention — a PER_USER_POOL row can never be summed into shared CodeForge supply.
 */

export type LedgerFieldProvenance = "OBSERVED" | "DERIVED" | "UNKNOWN";

/** Who the quota physically belongs to. USER_ENTITLEMENT rows are never pooled into shared supply. */
export type QuotaOwnerKind = "SHARED_CODEFORGE_POOL" | "USER_ENTITLEMENT" | "OWNER_DEV" | "SPONSORED" | "UNKNOWN";

export type RouteExhaustionBehavior =
  /** Shared $0 supply: rotate to another eligible route, otherwise wait for the window reset. */
  | "ROTATE_THEN_AWAIT_RESET"
  /** Capacity with a hard expiry (promotion, trial): rotate, then retire the route for good. */
  | "ROTATE_THEN_RETIRE"
  /** User-owned entitlement: rotate only within that user's own routes, then yield to them. */
  | "ROTATE_OWNED_THEN_YIELD"
  /** The route is not part of the Free product and must never serve ForgeAuto/Free. */
  | "NOT_FREE_ELIGIBLE";

export type LedgerTermsStatus = "CLEARED" | "RESTRICTED" | "DEVELOPMENT_ONLY" | "LEGAL_REVIEW_REQUIRED" | "NOT_ALLOWED";

export type LedgerProductionStatus = "PRODUCTION_ALLOWED" | "DEVELOPMENT_ONLY" | "BLOCKED" | "UNKNOWN";
export type LedgerMultiTenantStatus = "CLEARED" | "NOT_CLEARED" | "UNKNOWN";

/** Terms/policy facts the ledger cannot derive itself; supplied per providerId by the caller. */
export interface RouteLedgerPolicyFacts {
  termsStatus?: LedgerTermsStatus;
  commercialPackagingEligible?: boolean;
  officialTermsUrl?: string;
}

export interface RouteLedgerEntry {
  routeId: string;
  providerId: string;
  modelId: string;
  canonicalModelId: string;
  supplyClass: SupplyClass;
  capacityPoolId: string;
  quotaScope: CapacityScope;
  quotaPoolScope: CapacityPoolScope;
  quotaOwner: QuotaOwnerKind;
  /** Stable non-secret hash identifying the physical account behind a per-user pool. */
  quotaOwnerIdentity?: string;
  quotaPeriod: QuotaPeriod;
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  creditsRemaining: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerDay: number | null;
  monthlyLimit: number | null;
  concurrency: number | null;
  burstCapacity: number | null;
  resetAt?: string;
  expiresAt?: string;
  health: EightBitMeasuredHealthState | "HEALTHY" | "UNAVAILABLE";
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  rateLimitRate: number | null;
  failureRate: number | null;
  measuredSampleSize: number;
  lifecycle: FreeProviderLifecycle;
  commercialStatus: LedgerTermsStatus | "UNKNOWN";
  multiTenantStatus: LedgerMultiTenantStatus;
  productionStatus: LedgerProductionStatus;
  roleSuitability: readonly string[];
  /** Probation-tier roles — eligible only as degraded fallback behind qualified peers. */
  fallbackRoles?: readonly string[];
  qualityScore: number;
  /** Model context window — right-fit signal for capacity preservation (R37 Mission AH). */
  contextWindow?: number;
  freeEligible: boolean;
  exclusionReason?: string;
  onExhaustion: RouteExhaustionBehavior;
  fieldProvenance: Readonly<Record<string, LedgerFieldProvenance>>;
}

export interface SupplyDomainTotals {
  routes: number;
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  creditsRemaining: number | null;
}

export interface SupplyDomains {
  /** CodeForge-managed or sponsor-funded shared capacity. */
  shared: SupplyDomainTotals;
  /** Per-user entitlement totals keyed by non-secret capacity identity. Never merged into `shared`. */
  perUser: Readonly<Record<string, SupplyDomainTotals>>;
  ownerDev: SupplyDomainTotals;
}

export interface RouteLedger {
  generatedAt: string;
  entries: readonly RouteLedgerEntry[];
  summary: {
    totalRoutes: number;
    freeEligibleRoutes: number;
    byOwner: Readonly<Record<QuotaOwnerKind, number>>;
    bySupplyClass: Readonly<Record<string, number>>;
    isolationViolations: readonly string[];
  };
  domains: SupplyDomains;
}

export interface RouteLedgerInput {
  routes: readonly CapacityRoute[];
  pools?: readonly ProviderCapacityPool[];
  measuredHealth?: readonly EightBitMeasuredHealthRecord[];
  policyFacts?: Readonly<Record<string, RouteLedgerPolicyFacts>>;
  policy?: FreeCapacityPolicy;
  dataContext?: RouteDataContext;
  now?: number;
}

// CONTINUOUS is deliberately absent: it marks standing capacity (concurrency caps, always-on
// allowances) that never resets — a budget fact, not a rate bucket.
const RATE_PERIODS: ReadonlySet<QuotaPeriod> = new Set(["MINUTE_RESET", "HOURLY_RESET"]);

function isRateWindow(window: CapacityWindow): boolean {
  return window.period !== undefined && RATE_PERIODS.has(window.period);
}

function isTokenUnit(unit: CapacityWindow["unit"]): boolean {
  return unit === "input_tokens" || unit === "output_tokens";
}

function minNullable(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function ownerKindFor(route: CapacityRoute): QuotaOwnerKind {
  if (route.capacityPoolScope === "PER_USER_POOL") return "USER_ENTITLEMENT";
  if (route.supplyClass === "OWNER_DEV_FREE" || route.supplyClass === "OWNER_CREDIT_RESERVE") return "OWNER_DEV";
  if (route.supplyClass === "SPONSORED_FREE") return "SPONSORED";
  if (route.capacityPoolScope === "SHARED_OWNER_POOL") return "SHARED_CODEFORGE_POOL";
  return "UNKNOWN";
}

function exhaustionBehavior(route: CapacityRoute, expiresAt: string | undefined, now: number): RouteExhaustionBehavior {
  if (route.supplyClass === "PAID" || route.supplyClass === "TRIAL_CREDIT"
    || route.supplyClass === "OWNER_CREDIT_RESERVE" || route.supplyClass === "OWNER_DEV_FREE") {
    return "NOT_FREE_ELIGIBLE";
  }
  if (route.supplyClass === "USER_CONNECTED_FREE" || route.supplyClass === "DISTRIBUTED_USER_FREE") {
    return "ROTATE_OWNED_THEN_YIELD";
  }
  const expired = expiresAt !== undefined && Date.parse(expiresAt) <= now;
  if (route.supplyClass === "PROMOTIONAL_FREE" || expired) return "ROTATE_THEN_RETIRE";
  return "ROTATE_THEN_AWAIT_RESET";
}

interface WindowFacts {
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  creditsRemaining: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerDay: number | null;
  monthlyLimit: number | null;
  concurrency: number | null;
  burstCapacity: number | null;
  resetAt?: string;
  expiresAt?: string;
  quotaPeriod: QuotaPeriod;
  authoritativeQuota: boolean;
}

function reduceWindows(windows: readonly CapacityWindow[], now: number): WindowFacts {
  const quota = windows.filter((w) => !isRateWindow(w));
  const rate = windows.filter(isRateWindow);
  const live = quota.filter((w) => w.expiresAt === undefined || Date.parse(w.expiresAt) > now);

  const requestQuota = live.filter((w) => w.unit === "requests");
  const tokenQuota = live.filter((w) => isTokenUnit(w.unit));
  const creditQuota = live.filter((w) => w.unit === "credits");
  const concurrency = live.filter((w) => w.unit === "concurrency");

  const perMinute = rate.filter((w) => w.period === "MINUTE_RESET");
  const perDay = quota.filter((w) => w.period === "DAILY_RESET");
  const perMonth = quota.filter((w) => w.period === "MONTHLY_RESET");

  const dominant = [...requestQuota, ...creditQuota].sort((a, b) => a.remaining - b.remaining)[0];
  const resets = live.map((w) => Date.parse(w.resetAt)).filter((t) => Number.isFinite(t) && t > now);
  const expiries = windows.map((w) => w.expiresAt).filter((t): t is string => t !== undefined);

  return {
    requestsRemaining: minNullable(requestQuota.map((w) => w.remaining)),
    tokensRemaining: minNullable(tokenQuota.map((w) => w.remaining)),
    creditsRemaining: minNullable(creditQuota.map((w) => w.remaining)),
    requestsPerMinute: minNullable(perMinute.filter((w) => w.unit === "requests").map((w) => w.limit)),
    tokensPerMinute: minNullable(perMinute.filter((w) => isTokenUnit(w.unit)).map((w) => w.limit)),
    requestsPerDay: minNullable(perDay.filter((w) => w.unit === "requests").map((w) => w.limit)),
    tokensPerDay: minNullable(perDay.filter((w) => isTokenUnit(w.unit)).map((w) => w.limit)),
    monthlyLimit: minNullable(perMonth.map((w) => w.limit)),
    concurrency: minNullable(concurrency.map((w) => w.limit)),
    burstCapacity: concurrency.length === 0 ? null : Math.max(...concurrency.map((w) => w.limit)),
    resetAt: resets.length === 0 ? undefined : new Date(Math.min(...resets)).toISOString(),
    expiresAt: expiries.length === 0 ? undefined : expiries.sort()[0],
    quotaPeriod: dominant?.period ?? quota[0]?.period ?? "UNKNOWN",
    authoritativeQuota: quota.length === 0 ? false : quota.every((w) => w.authoritative),
  };
}

function productionStatus(route: CapacityRoute, terms: LedgerTermsStatus | "UNKNOWN", freeEligible: boolean): LedgerProductionStatus {
  if (terms === "DEVELOPMENT_ONLY") return "DEVELOPMENT_ONLY";
  if (terms === "UNKNOWN") return "UNKNOWN";
  return freeEligible && route.managedMultiUserAllowed && route.lifecycle === "APPROVED" ? "PRODUCTION_ALLOWED" : "BLOCKED";
}

function buildEntry(
  route: CapacityRoute,
  windows: readonly CapacityWindow[],
  health: EightBitMeasuredHealthRecord | undefined,
  facts: RouteLedgerPolicyFacts | undefined,
  policy: FreeCapacityPolicy,
  dataContext: RouteDataContext | undefined,
  now: number,
): RouteLedgerEntry {
  const wf = reduceWindows(windows, now);
  const exclusionReason = freeRouteExclusionReason(route, policy, dataContext);
  const terms = facts?.termsStatus ?? "UNKNOWN";
  const provenance: Record<string, LedgerFieldProvenance> = {
    requestsRemaining: wf.requestsRemaining === null ? "UNKNOWN" : wf.authoritativeQuota ? "OBSERVED" : "DERIVED",
    tokensRemaining: wf.tokensRemaining === null ? "UNKNOWN" : wf.authoritativeQuota ? "OBSERVED" : "DERIVED",
    creditsRemaining: wf.creditsRemaining === null ? "UNKNOWN" : wf.authoritativeQuota ? "OBSERVED" : "DERIVED",
    latency: health === undefined ? "UNKNOWN" : "OBSERVED",
    rateLimitRate: health === undefined ? "UNKNOWN" : "OBSERVED",
    onExhaustion: "DERIVED",
  };
  return {
    routeId: route.routeId,
    providerId: route.providerId,
    modelId: route.modelId,
    canonicalModelId: route.canonicalModelId,
    supplyClass: route.supplyClass,
    capacityPoolId: route.capacityPoolId,
    quotaScope: route.capacityScope,
    quotaPoolScope: route.capacityPoolScope,
    quotaOwner: ownerKindFor(route),
    quotaOwnerIdentity: route.capacityIdentity,
    quotaPeriod: wf.quotaPeriod,
    requestsRemaining: wf.requestsRemaining,
    tokensRemaining: wf.tokensRemaining,
    creditsRemaining: wf.creditsRemaining,
    requestsPerMinute: wf.requestsPerMinute,
    tokensPerMinute: wf.tokensPerMinute,
    requestsPerDay: wf.requestsPerDay,
    tokensPerDay: wf.tokensPerDay,
    monthlyLimit: wf.monthlyLimit,
    concurrency: wf.concurrency,
    burstCapacity: wf.burstCapacity,
    resetAt: wf.resetAt,
    expiresAt: wf.expiresAt,
    health: health?.state ?? (route.healthy ? "HEALTHY" : "UNAVAILABLE"),
    latencyP50Ms: health?.latencyP50Ms ?? null,
    latencyP95Ms: health?.latencyP95Ms ?? null,
    rateLimitRate: health?.recentRateLimitRate ?? null,
    failureRate: health?.recentFailureRate ?? null,
    measuredSampleSize: health?.sampleSize ?? 0,
    lifecycle: route.lifecycle,
    commercialStatus: terms === "UNKNOWN" ? "UNKNOWN" : terms,
    multiTenantStatus: route.managedMultiUserAllowed ? "CLEARED" : "NOT_CLEARED",
    productionStatus: productionStatus(route, terms, exclusionReason === undefined),
    roleSuitability: route.roles,
    ...(route.fallbackRoles !== undefined ? { fallbackRoles: route.fallbackRoles } : {}),
    qualityScore: route.qualityScore,
    ...(route.contextWindow !== undefined ? { contextWindow: route.contextWindow } : {}),
    freeEligible: exclusionReason === undefined,
    exclusionReason,
    onExhaustion: exhaustionBehavior(route, wf.expiresAt, now),
    fieldProvenance: provenance,
  };
}

function emptyTotals(): SupplyDomainTotals {
  return { routes: 0, requestsRemaining: null, tokensRemaining: null, creditsRemaining: null };
}

function accumulate(totals: SupplyDomainTotals, entry: RouteLedgerEntry): void {
  totals.routes += 1;
  for (const key of ["requestsRemaining", "tokensRemaining", "creditsRemaining"] as const) {
    const value = entry[key];
    if (value !== null) totals[key] = (totals[key] ?? 0) + value;
  }
}

/**
 * Structural proof that ownership domains cannot mix. Returns human-readable violation strings;
 * an empty list means user entitlements and shared supply are provably separate in this ledger.
 */
export function findOwnershipViolations(entries: readonly RouteLedgerEntry[]): string[] {
  const violations: string[] = [];
  const poolScopes = new Map<string, CapacityPoolScope>();
  const identityDomains = new Map<string, QuotaOwnerKind>();
  for (const entry of entries) {
    if (entry.quotaPoolScope === "PER_USER_POOL" && entry.quotaOwnerIdentity === undefined) {
      violations.push(`PER_USER_POOL_WITHOUT_OWNER_IDENTITY:${entry.routeId}`);
    }
    const priorScope = poolScopes.get(entry.capacityPoolId);
    if (priorScope !== undefined && priorScope !== entry.quotaPoolScope) {
      violations.push(`POOL_SCOPE_CONFLICT:${entry.capacityPoolId}`);
    }
    poolScopes.set(entry.capacityPoolId, entry.quotaPoolScope);
    if (entry.quotaOwnerIdentity !== undefined) {
      const priorOwner = identityDomains.get(entry.quotaOwnerIdentity);
      if (priorOwner !== undefined && priorOwner !== entry.quotaOwner) {
        violations.push(`IDENTITY_DOMAIN_CROSSOVER:${entry.quotaOwnerIdentity}`);
      }
      identityDomains.set(entry.quotaOwnerIdentity, entry.quotaOwner);
    }
  }
  return violations;
}

/** ForgeAuto's aggregation view: shared totals and per-user totals are separate by construction. */
export function aggregateSupplyDomains(entries: readonly RouteLedgerEntry[]): SupplyDomains {
  const shared = emptyTotals();
  const ownerDev = emptyTotals();
  const perUser: Record<string, SupplyDomainTotals> = {};
  for (const entry of entries) {
    if (entry.quotaOwner === "USER_ENTITLEMENT") {
      const identity = entry.quotaOwnerIdentity ?? "unknown";
      accumulate(perUser[identity] ??= emptyTotals(), entry);
    } else if (entry.quotaOwner === "OWNER_DEV") {
      accumulate(ownerDev, entry);
    } else {
      accumulate(shared, entry);
    }
  }
  return { shared, perUser, ownerDev };
}

// --- ForgeAuto — Free aggregation (M14D) -------------------------------------------------------

/**
 * The order ForgeAuto/Free may draw supply from, cheapest-to-conserve first. Shared managed
 * capacity absorbs cheap roles so a user's own entitlement is preserved for work where it
 * matters; sponsored supply (when authorized) sits between shared and personal.
 */
export const FORGEAUTO_DOMAIN_ORDER: readonly QuotaOwnerKind[] = [
  "SHARED_CODEFORGE_POOL",
  "SPONSORED",
  "USER_ENTITLEMENT",
];

export interface ForgeAutoSupplyPlan {
  /** The user this plan was built for (non-secret identity), or undefined for anonymous. */
  userIdentity?: string;
  generatedAt: string;
  /** Ordered eligible routes, first choice first. Empty means ForgeAuto/Free has no supply. */
  routes: readonly RouteLedgerEntry[];
  /** Per-domain eligible counts after filtering — the user's effective fabric. */
  domains: Readonly<Record<QuotaOwnerKind, number>>;
  /** True when at least one eligible route exists. */
  hasSupply: boolean;
}

/**
 * Builds the per-user ForgeAuto/Free supply plan. Only free-eligible rows participate; the
 * user's own entitlement routes are selected by `quotaOwnerIdentity` — another user's pool is
 * never even considered. Domain order conserves personal quota behind shared supply.
 */
export function forgeAutoSupplyPlan(
  entries: readonly RouteLedgerEntry[],
  role: string,
  userIdentity?: string | readonly string[],
): ForgeAutoSupplyPlan {
  // R37 Mission G/H: probation-tier roles count as eligible supply — a measured "close
  // enough" route is a legitimate degraded fallback. Ranking (not this eligibility filter)
  // keeps it behind every qualified peer, so the plan can never prefer it outright.
  const eligible = entries.filter((e) => e.freeEligible && (e.roleSuitability.includes(role) || e.fallbackRoles?.includes(role) === true));
  // A user may hold several connected accounts (Copilot + Ollama …): every capacity identity
  // they own is theirs to schedule on, and every identity they do not own is unreachable.
  const owned = new Set(typeof userIdentity === "string" ? [userIdentity] : userIdentity ?? []);
  const domainRank = (e: RouteLedgerEntry): number => {
    const owner = e.quotaOwner === "USER_ENTITLEMENT" && !(e.quotaOwnerIdentity !== undefined && owned.has(e.quotaOwnerIdentity))
      ? "UNKNOWN" // never schedulable: someone else's entitlement
      : e.quotaOwner;
    return FORGEAUTO_DOMAIN_ORDER.indexOf(owner as QuotaOwnerKind);
  };
  const usable = eligible.filter((e) => domainRank(e) !== -1);
  const routes = [...usable].sort((a, b) =>
    domainRank(a) - domainRank(b)
    || b.qualityScore - a.qualityScore
    || a.routeId.localeCompare(b.routeId));
  const domains: Record<QuotaOwnerKind, number> = {
    SHARED_CODEFORGE_POOL: 0,
    USER_ENTITLEMENT: 0,
    OWNER_DEV: 0,
    SPONSORED: 0,
    UNKNOWN: 0,
  };
  for (const r of routes) domains[r.quotaOwner] += 1;
  const primary = typeof userIdentity === "string" ? userIdentity : userIdentity?.[0];
  return { userIdentity: primary, generatedAt: new Date().toISOString(), routes, domains, hasSupply: routes.length > 0 };
}

export function buildRouteLedger(input: RouteLedgerInput): RouteLedger {
  const now = input.now ?? Date.now();
  const policy = input.policy ?? DEFAULT_FREE_CAPACITY_POLICY;
  const poolsById = new Map((input.pools ?? []).map((pool) => [pool.poolId, pool]));
  const healthByRoute = new Map((input.measuredHealth ?? []).map((h) => [`${h.providerId}::${h.modelId}`, h]));

  const entries = input.routes.map((route) => {
    const pool = poolsById.get(route.capacityPoolId);
    const windows = pool && pool.windows.length > 0 ? pool.windows : route.windows;
    return buildEntry(
      route,
      windows,
      healthByRoute.get(`${route.providerId}::${route.modelId}`),
      input.policyFacts?.[route.providerId],
      policy,
      input.dataContext,
      now,
    );
  });

  const byOwner: Record<QuotaOwnerKind, number> = {
    SHARED_CODEFORGE_POOL: 0,
    USER_ENTITLEMENT: 0,
    OWNER_DEV: 0,
    SPONSORED: 0,
    UNKNOWN: 0,
  };
  const bySupplyClass: Record<string, number> = {};
  for (const entry of entries) {
    byOwner[entry.quotaOwner] += 1;
    bySupplyClass[entry.supplyClass] = (bySupplyClass[entry.supplyClass] ?? 0) + 1;
  }

  return {
    generatedAt: new Date(now).toISOString(),
    entries,
    summary: {
      totalRoutes: entries.length,
      freeEligibleRoutes: entries.filter((e) => e.freeEligible).length,
      byOwner,
      bySupplyClass,
      isolationViolations: findOwnershipViolations(entries),
    },
    domains: aggregateSupplyDomains(entries),
  };
}

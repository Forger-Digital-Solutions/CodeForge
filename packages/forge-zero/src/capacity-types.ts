import type { PrivacyClass } from "./types.js";

/**
 * The economic source of a route.  This is intentionally more precise than a `free` boolean:
 * it prevents credits, time-boxed promotions, and paid fallback from being represented as the
 * same product capacity as a recurring $0 provider allowance.
 */
export type SupplyClass =
  | "PURE_MANAGED_FREE"
  | "DISTRIBUTED_USER_FREE"
  | "DEPOSIT_UNLOCKED_FREE"
  | "PROMOTIONAL_FREE"
  | "TRIAL_CREDIT"
  | "OWNER_CREDIT_RESERVE"
  | "PAID";

/** Who naturally owns an independently consumable capacity pool. */
export type CapacityPoolScope = "SHARED_OWNER_POOL" | "PER_USER_POOL";

/** The strongest data class a route may receive without an additional user decision. */
export type DataPolicyProfile =
  | "PRIVATE_CODE_ALLOWED"
  | "PUBLIC_CODE_ONLY"
  | "USER_CONSENT_REQUIRED"
  | "DISALLOWED";

export type RouteDataClass = "PRIVATE_CODE" | "PUBLIC_CODE" | "SYNTHETIC";

export interface RouteDataContext {
  dataClass: RouteDataClass;
  /** A disclosure-specific acknowledgement; never inferred from selecting ForgeAuto/Free. */
  userConsented?: boolean;
}

/** A candidate must finish this lifecycle before it may enter managed Free routing. */
export type FreeProviderLifecycle =
  | "DISCOVERED"
  | "POLICY_REVIEW"
  | "COMPATIBILITY_TEST"
  | "CAPACITY_PROBE"
  | "ROLE_QUALIFICATION"
  | "SHADOW"
  | "APPROVED"
  | "QUARANTINED"
  | "REJECTED";

export type CapacityScope =
  | "GLOBAL"
  | "ORG"
  | "PROJECT"
  | "API_KEY"
  | "ACCOUNT"
  | "END_USER"
  | "SOURCE_IP"
  | "INSTALLATION"
  | "DEVICE"
  | "PROMO_ACCOUNT"
  | "SPONSORED"
  | "UNKNOWN";

export type CapacityUnit = "requests" | "input_tokens" | "output_tokens" | "neurons";

export interface CapacityWindow {
  unit: CapacityUnit;
  limit: number;
  remaining: number;
  resetAt: string;
  scope: CapacityScope;
  observedAt: string;
  authoritative: boolean;
}

/**
 * One real quota bucket. Multiple model routes may point at this same pool, but its capacity may
 * only be counted once. PER_USER_POOL capacity is scaled only for an explicit user population.
 */
export interface ProviderCapacityPool {
  poolId: string;
  providerId: string;
  scope: CapacityPoolScope;
  supplyClass: SupplyClass;
  windows: readonly CapacityWindow[];
  observedAt: string;
  authoritative: boolean;
}

export interface CapacityRoute {
  routeId: string;
  providerId: string;
  modelId: string;
  canonicalModelId: string;
  family: string;
  gateway: string;
  upstreamProvider?: string;
  supplyClass: SupplyClass;
  capacityPoolId: string;
  capacityPoolScope: CapacityPoolScope;
  capacityScope: CapacityScope;
  dataPolicyProfile: DataPolicyProfile;
  lifecycle: FreeProviderLifecycle;
  explicitZeroPrice: boolean;
  /** ForgeAuto/Free must never turn a failed $0 call into a billable request. */
  paidFallbackDisabled: boolean;
  /** Managed use must be contractually cleared; owner-only routes leave this false. */
  managedMultiUserAllowed: boolean;
  privacyClass: PrivacyClass;
  roles: readonly string[];
  qualityScore: number;
  healthy: boolean;
  enabled: boolean;
  windows: readonly CapacityWindow[];
}

export interface TaskDemandProfile {
  taskKind: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  roleRequests: Readonly<Record<string, number>>;
}

/** A bounded estimate made before an autonomous task consumes scarce Free capacity. */
export interface TaskCapacityEstimate {
  taskKind: string;
  topology: string;
  expectedModelTurns: number;
  expectedRetryCalls: number;
  expectedVerificationCalls: number;
  expectedToolCalls: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  roleRequests: Readonly<Record<string, number>>;
}

export interface CapacityReservationRequest {
  reservationId: string;
  userId: string;
  routeIds: readonly string[];
  role: string;
  taskKind: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  isNewUser: boolean;
  priority: "first_run" | "normal" | "recovery";
  createdAt: string;
  leaseUntil: string;
}

export interface CapacityReservationDecision {
  admitted: boolean;
  reservationId: string;
  routeId?: string;
  reason:
    | "ADMITTED"
    | "NO_ELIGIBLE_ROUTE"
    | "CAPACITY_EXHAUSTED"
    | "FIRST_RUN_RESERVE_PROTECTED"
    | "USER_CONCURRENCY_LIMIT"
    | "CAPACITY_POOL_IDENTITY_MISMATCH"
    | "INVALID_REQUEST";
  nextAvailableAt?: string;
}

export interface CapacityReservation {
  request: CapacityReservationRequest;
  routeId: string;
  admittedAt: string;
}

export interface CapacityLedgerOptions {
  routes: readonly CapacityRoute[];
  pools?: readonly ProviderCapacityPool[];
  dataContext?: RouteDataContext;
  firstRunReserveRequests?: number;
  firstRunReserveTokens?: number;
  maxActiveReservationsPerUser?: number;
  now?: () => number;
}

export interface CapacityLedgerSnapshot {
  generatedAt: string;
  activeReservations: number;
  byUser: Readonly<Record<string, number>>;
  byRoute: Readonly<Record<string, number>>;
  byPool: Readonly<Record<string, number>>;
  protectedFirstRunRequests: number;
  protectedFirstRunTokens: number;
}

export interface CapacityForecastRoute {
  routeId: string;
  eligible: boolean;
  exclusionReason?: string;
  availableRequests: number;
  availableTokens: number;
  estimatedTaskUnits: number;
  capacityPoolId?: string;
  capacityPoolScope?: CapacityPoolScope;
  countedInPool?: boolean;
  resetAt?: string;
  concentrationShare: number;
}

export interface CapacityForecast {
  generatedAt: string;
  policy: "DETERMINISTIC_HARD_ACCOUNTING";
  routes: readonly CapacityForecastRoute[];
  estimatedTaskUnits: number;
  firstRunTaskUnits: number;
  normalTaskUnits: number;
  roleScarcity: Readonly<Record<string, number>>;
  providerConcentration: Readonly<Record<string, number>>;
  gatewayConcentration: Readonly<Record<string, number>>;
  familyConcentration: Readonly<Record<string, number>>;
  poolConcentration: Readonly<Record<string, number>>;
  alerts: readonly string[];
}

export interface CapacityForecastInput {
  routes: readonly CapacityRoute[];
  pools?: readonly ProviderCapacityPool[];
  /** Required to project distributed, per-user pools into aggregate product capacity. */
  activeUsers?: number;
  taskDemand: TaskDemandProfile;
  firstRunReserveRequests?: number;
  firstRunReserveTokens?: number;
  now?: number;
}

export type CapacityPreflightStatus = "READY" | "AT_RISK" | "INSUFFICIENT_CAPACITY";

export interface CapacityPreflightInput {
  routes: readonly CapacityRoute[];
  pools?: readonly ProviderCapacityPool[];
  estimate: TaskCapacityEstimate;
  plannedTasks: number;
  activeUsers?: number;
  firstRunReserveRequests?: number;
  firstRunReserveTokens?: number;
  minimumIndependentProviders?: number;
  maximumProviderConcentration?: number;
  now?: number;
}

/** A capacity forecast is evidence, not an execution authorization. */
export interface CapacityPreflight {
  status: CapacityPreflightStatus;
  plannedTasks: number;
  safeTaskUnits: number;
  eligiblePoolCount: number;
  independentProviderCount: number;
  nextResetAt?: string;
  reasons: readonly string[];
  forecast: CapacityForecast;
}

export interface CapacityEvent {
  id: string;
  source: Exclude<SupplyClass, "PAID">;
  startsAt: string;
  endsAt: string;
  routeIds: readonly string[];
  eligibleRoles: readonly string[];
  eligiblePrivacy: readonly PrivacyClass[];
  maxRequestsPerUser?: number;
  fallbackRouteIds: readonly string[];
}

export interface ScaleScenario {
  id: string;
  registeredUsers: number;
  dailyActiveUsers: number;
  newUsers: number;
  tasksPerActiveUser: number;
  taskDemand: TaskDemandProfile;
  failedProviders?: readonly string[];
  failedGateways?: readonly string[];
  endedPromotions?: readonly string[];
  heavyUsers?: number;
  hugeTaskMultiplier?: number;
  now?: number;
}

export interface ScaleSimulationResult {
  scenarioId: string;
  registeredUsers: number;
  dailyActiveUsers: number;
  demand: { totalTasks: number; firstRunTasks: number; normalTasks: number };
  capacity: { totalTasks: number; firstRunTasks: number; normalTasks: number };
  outcomes: {
    firstRunSuccessRate: number;
    normalSuccessRate: number;
    capacityBlocks: number;
    failoverCoverage: number;
    p95WaitMinutes: number;
    qualityFloorPass: boolean;
  };
  forecast: CapacityForecast;
  alerts: readonly string[];
}

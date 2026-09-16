import type { PrivacyClass } from "./types.js";

export type CapacityClass =
  | "RECURRING_SHARED_FREE"
  | "USER_SCALED_FREE"
  | "ROTATING_FREE_MODEL"
  | "PROMOTIONAL_FREE"
  | "SPONSORED_FREE"
  | "CLOUD_CREDIT"
  | "PAID";

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
export type EconomicSource = "RETAIL_FREE" | "USER_SCALED_FREE" | "PROMOTIONAL_FREE" | "SPONSORED" | "CLOUD_CREDIT" | "PAID";

export interface CapacityWindow {
  unit: CapacityUnit;
  limit: number;
  remaining: number;
  resetAt: string;
  scope: CapacityScope;
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
  capacityClass: CapacityClass;
  capacityScope: CapacityScope;
  economicSource: EconomicSource;
  explicitZeroPrice: boolean;
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
  alerts: readonly string[];
}

export interface CapacityForecastInput {
  routes: readonly CapacityRoute[];
  taskDemand: TaskDemandProfile;
  firstRunReserveRequests?: number;
  firstRunReserveTokens?: number;
  now?: number;
}

export interface CapacityEvent {
  id: string;
  source: Exclude<CapacityClass, "PAID">;
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

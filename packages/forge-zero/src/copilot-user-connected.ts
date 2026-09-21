import type {
  CapacityRoute,
  CapacityScope,
  CapacityWindow,
  ProviderCapacityPool,
} from "./capacity-types.js";
import {
  hashUserAccountIdentity,
  type CapacityConfidence,
  type ProviderConnectionAuthType,
  type UserConnectedFreeStatus,
  type UserConnectedFreeTermsStatus,
} from "./user-connected-free.js";

/**
 * GitHub Copilot as a user-connected entitlement (R23 M14A-2). The supply class is
 * USER_CONNECTED_FREE: each user brings their own Copilot subscription (Free/Pro/Business),
 * CodeForge operates no quota here and pays nothing. Admission is fail-closed on two facts the
 * official SDK exposes through account.getQuota: the account's hard-stop flags and the live
 * bucket remainder. No inference path exists in this module — this file is the supply ledger,
 * admission math and fleet projection only.
 */
export const COPILOT_PROVIDER_ID = "github-copilot" as const;

/** One quotaSnapshots bucket from account.getQuota (field names mirror the SDK payload). */
export interface CopilotQuotaBucket {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage?: number;
  overage?: number;
  /** true = the plan may spill into paid overage after the included quota is spent. */
  overageAllowedWithExhaustedQuota?: boolean;
  /** true = requests keep being served after the included quota is spent (billable). */
  usageAllowedWithExhaustedQuota?: boolean;
  resetDate?: string;
}

export interface CopilotQuotaObservation {
  chat?: CopilotQuotaBucket;
  completions?: CopilotQuotaBucket;
  premiumInteractions?: CopilotQuotaBucket;
  observedAt: string;
  capacityConfidence: CapacityConfidence;
}

export interface CopilotModelObservation {
  modelId: string;
  canonicalModelId: string;
  family: string;
  roles: readonly string[];
  /** ModelInfo.policy.state === "enabled" from the official SDK. */
  policyEnabled: boolean;
  /** ModelInfo.capabilities.supports.tool_calls from the official SDK. */
  supportsToolCalls: boolean;
}

export interface CopilotFreeConnection {
  providerId: typeof COPILOT_PROVIDER_ID;
  userId: string;
  authType: ProviderConnectionAuthType;
  encryptedCredentialRef: string;
  supplyClass: "USER_CONNECTED_FREE";
  capacityScope: "USER_ACCOUNT";
  capacityPoolId: string;
  capacityIdentity: string;
  freeOnly: true;
  paidFallbackDisabled: true;
  status: UserConnectedFreeStatus;
  termsStatus: UserConnectedFreeTermsStatus;
  connectedAt?: string;
}

export type CopilotAdmissionState = "READY" | "EXHAUSTED" | "PAID_CROSSOVER_BLOCKED" | "UNKNOWN_BALANCE" | "STALE_QUOTA";

export interface CopilotFreeOnlyAdmission {
  allowed: boolean;
  state: CopilotAdmissionState;
  reason: string;
  remainingRequests?: number;
  resetAt?: string;
}

export function copilotPoolId(userId: string, accountIdentity = ""): string {
  return `${COPILOT_PROVIDER_ID}:user:${hashUserAccountIdentity(userId, accountIdentity)}`;
}

const NEVER_RESET = "9999-12-31T23:59:59.999Z";

/**
 * The account proves it cannot spend money only when every observed bucket reports both
 * post-quota flags false. A missing flag is not evidence of a hard stop — fail closed.
 */
export function copilotHardStopProven(usage: CopilotQuotaObservation): boolean {
  const buckets = [usage.chat, usage.completions, usage.premiumInteractions].filter((b): b is CopilotQuotaBucket => b !== undefined);
  return buckets.length > 0 && buckets.every((b) => b.overageAllowedWithExhaustedQuota === false && b.usageAllowedWithExhaustedQuota === false);
}

/**
 * The financial boundary for Copilot user-connected Free. A bucket that can continue past its
 * entitlement is a billable path and is refused by default; a stale or absent quota observation
 * is never treated as remaining capacity.
 */
export function evaluateCopilotFreeOnlyAdmission(input: {
  bucket?: CopilotQuotaBucket;
  estimatedRequests: number;
  observedAt: string;
  maxObservationAgeMs?: number;
  now?: number;
}): CopilotFreeOnlyAdmission {
  const { bucket } = input;
  if (!bucket) {
    return { allowed: false, state: "UNKNOWN_BALANCE", reason: "No Copilot quota bucket observed; Free routing is fail-closed." };
  }
  const maxAge = input.maxObservationAgeMs ?? 15 * 60_000;
  const now = input.now ?? Date.now();
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs) || now - observedAtMs > maxAge) {
    return { allowed: false, state: "STALE_QUOTA", reason: "Copilot quota observation is stale; re-read account.getQuota before routing." };
  }
  const remaining = Math.max(0, bucket.entitlementRequests - bucket.usedRequests);
  const base = { remainingRequests: remaining, ...(bucket.resetDate ? { resetAt: bucket.resetDate } : {}) };
  if (bucket.overageAllowedWithExhaustedQuota === true || bucket.usageAllowedWithExhaustedQuota === true) {
    return { ...base, allowed: false, state: "PAID_CROSSOVER_BLOCKED", reason: "This Copilot plan may continue past the included quota as billable usage; Free-only routing is refused." };
  }
  if (remaining <= 0 || remaining < Math.max(0, input.estimatedRequests)) {
    return { ...base, allowed: false, state: "EXHAUSTED", reason: remaining <= 0 ? "Copilot included quota exhausted." : "The estimated request count exceeds the remaining Copilot quota." };
  }
  return { ...base, allowed: true, state: "READY", reason: "Copilot included quota is available with a proven hard stop." };
}

function window(unit: CapacityWindow["unit"], limit: number, remaining: number, resetAt: string, scope: CapacityScope, observedAt: string, authoritative: boolean): CapacityWindow {
  return { unit, limit: Math.max(0, limit), remaining: Math.max(0, remaining), resetAt, scope, observedAt, authoritative, period: "MONTHLY_RESET" };
}

/**
 * The chat bucket is the serving quota for agentic work and is projected as the pool's
 * `requests` window. premiumInteractions is a separate budget (premium-billed models) and is
 * projected as `provider_units` so a zero there cannot starve chat requests — model billing is
 * only enumerable with the Copilot-Requests permission, so premium gating lands with the
 * adapter, not here. The completions bucket serves the inline-completion product surface and
 * is deliberately not agentic capacity. Copilot quotas reset with the billing cycle.
 */
export function buildCopilotUserCapacityPool(
  connection: Pick<CopilotFreeConnection, "userId" | "capacityIdentity" | "capacityPoolId" | "supplyClass">,
  usage: CopilotQuotaObservation,
): ProviderCapacityPool {
  const windows: CapacityWindow[] = [];
  const authoritative = usage.capacityConfidence === "HIGH";
  if (usage.chat) {
    windows.push(window("requests", usage.chat.entitlementRequests, usage.chat.entitlementRequests - usage.chat.usedRequests, usage.chat.resetDate ?? NEVER_RESET, "USER_ACCOUNT", usage.observedAt, authoritative));
  }
  if (usage.premiumInteractions) {
    windows.push(window("provider_units", usage.premiumInteractions.entitlementRequests, usage.premiumInteractions.entitlementRequests - usage.premiumInteractions.usedRequests, usage.premiumInteractions.resetDate ?? NEVER_RESET, "USER_ACCOUNT", usage.observedAt, authoritative));
  }
  return {
    poolId: connection.capacityPoolId || copilotPoolId(connection.userId, connection.capacityIdentity),
    providerId: COPILOT_PROVIDER_ID,
    scope: "PER_USER_POOL",
    supplyClass: connection.supplyClass,
    windows,
    observedAt: usage.observedAt,
    authoritative,
    capacityIdentity: connection.capacityIdentity,
  };
}

export interface CopilotUserRouteInput {
  userId: string;
  accountIdentity?: string;
  capacityPoolId?: string;
  capacityIdentity?: string;
  model: CopilotModelObservation;
  windows: readonly CapacityWindow[];
  lifecycle?: CapacityRoute["lifecycle"];
  healthy?: boolean;
  enabled?: boolean;
  freeOnlyAdmissionProven?: boolean;
  termsAllowed?: boolean;
}

/**
 * A Copilot entitlement route is constructed ineligible by default: lifecycle POLICY_REVIEW and
 * managedMultiUserAllowed false until legal/terms clearance lands — entitlement discovery is
 * proven (M14A-2), product sign-off is not. explicitZeroPrice stays false: Copilot capacity is
 * metered subscription entitlement, not a provider-published $0 price.
 */
export function buildCopilotUserRoute(input: CopilotUserRouteInput): CapacityRoute {
  const capacityIdentity = input.capacityIdentity ?? hashUserAccountIdentity(input.userId, input.accountIdentity);
  const capacityPoolId = input.capacityPoolId ?? copilotPoolId(input.userId, input.accountIdentity);
  return {
    routeId: `${capacityPoolId}:${input.model.modelId}`,
    providerId: COPILOT_PROVIDER_ID,
    modelId: input.model.modelId,
    canonicalModelId: input.model.canonicalModelId,
    family: input.model.family,
    gateway: COPILOT_PROVIDER_ID,
    supplyClass: "USER_CONNECTED_FREE",
    capacityPoolId,
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "USER_ACCOUNT",
    capacityIdentity,
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: input.lifecycle ?? "POLICY_REVIEW",
    explicitZeroPrice: false,
    freeOnlyAdmissionProven: input.freeOnlyAdmissionProven ?? false,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: input.termsAllowed ?? false,
    privacyClass: "strict",
    roles: input.model.roles,
    qualityScore: 50,
    healthy: input.healthy ?? true,
    enabled: input.enabled ?? true,
    windows: input.windows,
  };
}

interface CopilotFleetEntry {
  connection: CopilotFreeConnection;
  pool: ProviderCapacityPool;
  routes: readonly CapacityRoute[];
}

/**
 * User-specific 8-Bit fleet projection for Copilot entitlement. It never returns credentials —
 * callers receive only the account's own routes and pool observation — and it only projects
 * models the account's policy enables that can actually serve agentic work (tool calls).
 */
export class CopilotUserConnectedFreeFleet {
  private readonly entries = new Map<string, CopilotFleetEntry>();

  connect(connection: CopilotFreeConnection, usage: CopilotQuotaObservation, models: readonly CopilotModelObservation[]): void {
    const pool = buildCopilotUserCapacityPool(connection, usage);
    const freeOnlyAdmissionProven = copilotHardStopProven(usage)
      && usage.capacityConfidence === "HIGH"
      && usage.chat !== undefined;
    const termsAllowed = connection.termsStatus === "USER_CONNECTED_FREE_ALLOWED";
    const routes = models
      .filter((model) => model.policyEnabled && model.supportsToolCalls)
      .map((model) => buildCopilotUserRoute({
        userId: connection.userId,
        capacityPoolId: connection.capacityPoolId,
        capacityIdentity: connection.capacityIdentity,
        model,
        windows: pool.windows,
        freeOnlyAdmissionProven,
        termsAllowed,
      }));
    this.entries.set(connection.userId, { connection, pool, routes });
  }

  disconnect(userId: string): boolean {
    return this.entries.delete(userId);
  }

  routesForUser(userId: string): readonly CapacityRoute[] {
    return this.entries.get(userId)?.routes ?? [];
  }

  poolsForUser(userId: string): readonly ProviderCapacityPool[] {
    const entry = this.entries.get(userId);
    return entry ? [entry.pool] : [];
  }

  connectedUsers(): readonly string[] {
    return [...this.entries.keys()];
  }
}

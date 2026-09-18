import { createHash } from "node:crypto";
import type {
  CapacityRoute,
  CapacityScope,
  CapacityWindow,
  ProviderCapacityPool,
  SupplyClass,
} from "./capacity-types.js";

export const OLLAMA_USER_CONNECTED_FREE_FLAG = "ollamaUserConnectedFree" as const;
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud" as const;
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1" as const;
export const OLLAMA_SIGNUP_URL = "https://ollama.com/signup" as const;
export const OLLAMA_API_KEYS_URL = "https://ollama.com/settings/keys" as const;
export const OLLAMA_USAGE_URL = "https://ollama.com/settings/usage" as const;

export type ProviderConnectionAuthType = "API_KEY" | "OAUTH" | "DEVICE_AUTH";
export type UserConnectedFreeStatus = "DISCONNECTED" | "VALIDATING" | "CONNECTED" | "REAUTH_REQUIRED" | "AT_RISK" | "EXHAUSTED";
export type CapacityConfidence = "HIGH" | "LIMITED" | "UNKNOWN";
export type UserConnectedFreeTermsStatus = "USER_CONNECTED_FREE_ALLOWED" | "USER_CONNECTED_FREE_PERMISSION_REQUIRED" | "USER_CONNECTED_FREE_TERMS_BLOCKED";

export interface OllamaTokenRates {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  outputPerMillionUsd: number;
}

export interface OllamaFreeUsageObservation {
  includedLimitUsd?: number;
  includedRemainingUsd?: number;
  includedResetAt?: string;
  purchasedUsageCreditsUsd?: number;
  paidSubscription?: boolean;
  autoReloadEnabled?: boolean;
  starterModels: readonly string[];
  concurrencyLimit: number;
  observedAt: string;
  capacityConfidence: CapacityConfidence;
  includedUsageDistinguishable: boolean;
  hardStopProven: boolean;
}

export interface UserConnectedFreeConnection {
  providerId: typeof OLLAMA_CLOUD_PROVIDER_ID;
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
  usage?: OllamaFreeUsageObservation;
  connectedAt?: string;
}

export interface OllamaFreeOnlyAdmissionInput {
  usage: OllamaFreeUsageObservation;
  estimatedUsageUsd: number;
  allowAtRisk?: boolean;
}

export interface OllamaFreeOnlyAdmission {
  allowed: boolean;
  state: "READY" | "AT_RISK" | "EXHAUSTED" | "PAID_CROSSOVER_BLOCKED" | "UNKNOWN_BALANCE";
  reason: string;
  remainingUsd?: number;
  resetAt?: string;
}

export function hashUserAccountIdentity(userId: string, accountIdentity = ""): string {
  return createHash("sha256").update(`${userId}\u0000${accountIdentity}`, "utf8").digest("hex").slice(0, 24);
}

export function userConnectedPoolId(userId: string, accountIdentity = ""): string {
  return `${OLLAMA_CLOUD_PROVIDER_ID}:user:${hashUserAccountIdentity(userId, accountIdentity)}`;
}

export function estimateOllamaUsageUsd(inputTokens: number, outputTokens: number, rates: OllamaTokenRates): number {
  const input = Math.max(0, inputTokens) / 1_000_000 * Math.max(0, rates.inputPerMillionUsd);
  const output = Math.max(0, outputTokens) / 1_000_000 * Math.max(0, rates.outputPerMillionUsd);
  return Number((input + output).toFixed(8));
}

/**
 * This is the financial boundary for ForgeAuto/Free. Purchased credits are never a fallback,
 * and an unknown included balance is never treated as remaining capacity.
 */
export function evaluateOllamaFreeOnlyAdmission(input: OllamaFreeOnlyAdmissionInput): OllamaFreeOnlyAdmission {
  const usage = input.usage;
  const estimated = Math.max(0, input.estimatedUsageUsd);
  const resetAt = usage.includedResetAt;
  const purchased = Math.max(0, usage.purchasedUsageCreditsUsd ?? 0);
  const remaining = usage.includedRemainingUsd;
  const base = { ...(resetAt ? { resetAt } : {}), ...(remaining !== undefined ? { remainingUsd: remaining } : {}) };

  if (usage.paidSubscription === true || usage.autoReloadEnabled === true) {
    return { ...base, allowed: false, state: "PAID_CROSSOVER_BLOCKED", reason: "A paid subscription or auto-reload is enabled; Free-only routing is disabled." };
  }
  if (!usage.includedUsageDistinguishable) {
    return { ...base, allowed: false, state: "PAID_CROSSOVER_BLOCKED", reason: "Included Ollama usage cannot be separated from purchased credits." };
  }
  if (remaining === undefined || !Number.isFinite(remaining)) {
    return { ...base, allowed: false, state: "UNKNOWN_BALANCE", reason: "Included Ollama balance is unknown; automatic Free routing is fail-closed." };
  }
  if (remaining <= 0 || remaining < estimated) {
    return { ...base, allowed: false, state: "EXHAUSTED", reason: remaining <= 0 ? "Ollama Free allowance exhausted." : "The estimated request exceeds the remaining Ollama Free allowance." };
  }
  if (purchased > 0 && !usage.hardStopProven) {
    return { ...base, allowed: false, state: "PAID_CROSSOVER_BLOCKED", reason: "Purchased Ollama credits exist and a Free-only hard stop is not proven." };
  }
  if (!usage.hardStopProven && input.allowAtRisk !== true) {
    return { ...base, allowed: false, state: "AT_RISK", reason: "Ollama Free-only transport hard stop is not proven." };
  }
  return { ...base, allowed: true, state: usage.hardStopProven ? "READY" : "AT_RISK", reason: usage.hardStopProven ? "Included Ollama Free usage is available." : "Included usage is available with limited financial certainty." };
}

function window(unit: CapacityWindow["unit"], limit: number, remaining: number, resetAt: string, scope: CapacityScope, observedAt: string, authoritative: boolean): CapacityWindow {
  return { unit, limit: Math.max(0, limit), remaining: Math.max(0, remaining), resetAt, scope, observedAt, authoritative };
}

export function buildOllamaUserCapacityPool(connection: Pick<UserConnectedFreeConnection, "userId" | "capacityIdentity" | "capacityPoolId" | "supplyClass">, usage: OllamaFreeUsageObservation): ProviderCapacityPool {
  const windows: CapacityWindow[] = [];
  if (usage.includedLimitUsd !== undefined && usage.includedRemainingUsd !== undefined && usage.includedResetAt) {
    windows.push(window("credits", usage.includedLimitUsd, usage.includedRemainingUsd, usage.includedResetAt, "USER_ACCOUNT", usage.observedAt, usage.capacityConfidence === "HIGH" && usage.includedUsageDistinguishable));
  }
  windows.push(window("concurrency", usage.concurrencyLimit, usage.concurrencyLimit, usage.includedResetAt ?? "9999-12-31T23:59:59.999Z", "USER_ACCOUNT", usage.observedAt, true));
  return {
    poolId: connection.capacityPoolId || userConnectedPoolId(connection.userId, connection.capacityIdentity),
    providerId: OLLAMA_CLOUD_PROVIDER_ID,
    scope: "PER_USER_POOL",
    supplyClass: connection.supplyClass,
    windows,
    observedAt: usage.observedAt,
    authoritative: usage.capacityConfidence === "HIGH" && usage.includedUsageDistinguishable,
    capacityIdentity: connection.capacityIdentity,
  };
}

export interface OllamaUserRouteInput {
  userId: string;
  accountIdentity?: string;
  capacityPoolId?: string;
  capacityIdentity?: string;
  modelId: string;
  canonicalModelId: string;
  family: string;
  roles: readonly string[];
  dataPolicyProfile?: CapacityRoute["dataPolicyProfile"];
  windows: readonly CapacityWindow[];
  healthy?: boolean;
  enabled?: boolean;
  lifecycle?: CapacityRoute["lifecycle"];
  freeOnlyAdmissionProven?: boolean;
  termsAllowed?: boolean;
}

export function buildOllamaUserRoute(input: OllamaUserRouteInput): CapacityRoute {
  const capacityIdentity = input.capacityIdentity ?? hashUserAccountIdentity(input.userId, input.accountIdentity);
  const capacityPoolId = input.capacityPoolId ?? userConnectedPoolId(input.userId, input.accountIdentity);
  return {
    routeId: `${capacityPoolId}:${input.modelId}`,
    providerId: OLLAMA_CLOUD_PROVIDER_ID,
    modelId: input.modelId,
    canonicalModelId: input.canonicalModelId,
    family: input.family,
    gateway: "ollama-cloud",
    supplyClass: "USER_CONNECTED_FREE",
    capacityPoolId,
    capacityPoolScope: "PER_USER_POOL",
    capacityScope: "USER_ACCOUNT",
    capacityIdentity,
    dataPolicyProfile: input.dataPolicyProfile ?? "PRIVATE_CODE_ALLOWED",
    lifecycle: input.lifecycle ?? "APPROVED",
    explicitZeroPrice: false,
    freeOnlyAdmissionProven: input.freeOnlyAdmissionProven ?? false,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: input.termsAllowed ?? false,
    privacyClass: "strict",
    roles: input.roles,
    qualityScore: 50,
    healthy: input.healthy ?? true,
    enabled: input.enabled ?? true,
    windows: input.windows,
  };
}

export interface OllamaUserConnectedModel {
  modelId: string;
  canonicalModelId: string;
  family: string;
  roles: readonly string[];
  windows?: readonly CapacityWindow[];
}

interface UserConnectedFleetEntry {
  connection: UserConnectedFreeConnection;
  pool: ProviderCapacityPool;
  routes: readonly CapacityRoute[];
}

/**
 * User-specific 8-Bit fleet projection. It intentionally has no method that returns credentials;
 * callers receive only the account's own routes and physical pool observation.
 */
export class OllamaUserConnectedFreeFleet {
  private readonly entries = new Map<string, UserConnectedFleetEntry>();

  connect(connection: UserConnectedFreeConnection, usage: OllamaFreeUsageObservation, models: readonly OllamaUserConnectedModel[]): void {
    const pool = buildOllamaUserCapacityPool(connection, usage);
    const freeOnlyAdmissionProven = usage.hardStopProven
      && usage.includedUsageDistinguishable
      && usage.capacityConfidence === "HIGH"
      && usage.includedRemainingUsd !== undefined;
    const termsAllowed = connection.termsStatus === "USER_CONNECTED_FREE_ALLOWED";
    const routes = models
      .filter((model) => usage.starterModels.includes(model.modelId))
      .map((model) => buildOllamaUserRoute({
        userId: connection.userId,
        capacityPoolId: connection.capacityPoolId,
        capacityIdentity: connection.capacityIdentity,
        modelId: model.modelId,
        canonicalModelId: model.canonicalModelId,
        family: model.family,
        roles: model.roles,
        windows: model.windows ?? pool.windows,
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

export interface OllamaAdoptionScenario {
  adoptionRate: number;
  dailyActiveUsers: number;
  connectedUsers: number;
  perUserTaskCapacity: number;
  additionalFreeTasks: number;
  sharedProviderPressureOffloaded: number;
  capacityBlocks: number;
}

export function simulateOllamaAdoption(input: {
  dailyActiveUsers?: number;
  adoptionRates?: readonly number[];
  includedUsageUsdPerUser: number;
  taskUsageUsd: number;
  sharedTasksPerDay: number;
}): OllamaAdoptionScenario[] {
  const dau = Math.max(0, Math.floor(input.dailyActiveUsers ?? 373));
  const taskUsage = Math.max(Number.EPSILON, input.taskUsageUsd);
  const perUser = Math.max(0, Math.floor(Math.max(0, input.includedUsageUsdPerUser) / taskUsage));
  return (input.adoptionRates ?? [0, 0.1, 0.25, 0.5, 0.75]).map((rate) => {
    const adoption = Math.min(1, Math.max(0, rate));
    const connected = Math.floor(dau * adoption);
    const added = connected * perUser;
    return {
      adoptionRate: adoption,
      dailyActiveUsers: dau,
      connectedUsers: connected,
      perUserTaskCapacity: perUser,
      additionalFreeTasks: added,
      sharedProviderPressureOffloaded: Math.min(Math.max(0, input.sharedTasksPerDay), added),
      capacityBlocks: Math.max(0, Math.max(0, input.sharedTasksPerDay) - added),
    };
  });
}

export function isUserConnectedFreeSupply(source: SupplyClass): boolean {
  return source === "USER_CONNECTED_FREE";
}

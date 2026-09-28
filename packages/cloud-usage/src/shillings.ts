import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";

export type ShillingConfidence = "AUTHORITATIVE" | "OBSERVED" | "ESTIMATED" | "UNKNOWN";
export type ShillingRawUnit = "TOKENS" | "REQUESTS" | "DOLLARS" | "CREDITS" | "NEURONS" | "COMPUTE_UNITS" | "MONTHLY_ALLOWANCE" | "UNKNOWN";
export type ShillingSourceClass = "MANAGED_FREE" | "MANAGED_PAID" | "USER_API" | "USER_HOSTED" | "LOCAL" | "UNKNOWN";

export interface ShillingConversion {
  rawUnit: ShillingRawUnit;
  /** Normalized text-token-equivalent per raw unit. Absent for UNKNOWN. */
  shPerRawUnit?: number;
  confidence: ShillingConfidence;
  evidenceSource?: string;
  observedAt?: string;
}

export interface ShillingEntry {
  id: string;
  userId: string;
  taskId: string;
  role: string;
  requestId: string;
  providerId: string;
  modelId: string;
  sourceClass: ShillingSourceClass;
  frontier?: boolean;
  rawInputUsage?: number | null;
  rawOutputUsage?: number | null;
  rawUsage: number | null;
  rawAllowance?: number;
  rawRemaining?: number;
  conversion: ShillingConversion;
  shConsumed: number | null;
  grossSh: number | null;
  usableSh: number | null;
  availableNowSh: number | null;
  managedSpendUsd: number | null;
  userProviderSpendUsd: number | null;
  costConfidence: ShillingConfidence;
  recordedAt: string;
}

function nonnegative(value: number | null | undefined, field: string): void {
  if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`SHILLING_${field}_INVALID`);
}

function normalize(raw: number | null | undefined, conversion: ShillingConversion): number | null {
  if (raw === undefined || raw === null || conversion.confidence === "UNKNOWN" || conversion.shPerRawUnit === undefined) return null;
  return raw * conversion.shPerRawUnit;
}

export function createShillingEntry(input: Omit<ShillingEntry, "shConsumed" | "grossSh" | "usableSh" | "availableNowSh"> & {
  usableRaw?: number;
  availableNowRaw?: number;
}): ShillingEntry {
  for (const [field, value] of Object.entries({ INPUT_USAGE: input.rawInputUsage, OUTPUT_USAGE: input.rawOutputUsage, USAGE: input.rawUsage, ALLOWANCE: input.rawAllowance, REMAINING: input.rawRemaining, USABLE: input.usableRaw, AVAILABLE: input.availableNowRaw, MANAGED_SPEND: input.managedSpendUsd ?? undefined, USER_SPEND: input.userProviderSpendUsd ?? undefined })) nonnegative(value, field);
  if (input.rawInputUsage !== undefined && input.rawInputUsage !== null && input.rawOutputUsage !== undefined && input.rawOutputUsage !== null && input.rawUsage !== input.rawInputUsage + input.rawOutputUsage) throw new Error("SHILLING_RAW_USAGE_MISMATCH");
  if (!input.id || !input.userId || !input.taskId || !input.requestId || !input.providerId || !input.modelId || !input.role) throw new Error("SHILLING_IDENTITY_REQUIRED");
  const factor = input.conversion.shPerRawUnit;
  if (input.conversion.confidence === "UNKNOWN") {
    if (factor !== undefined) throw new Error("SHILLING_UNKNOWN_HAS_FACTOR");
  } else if (factor === undefined || !Number.isFinite(factor) || factor <= 0 || !input.conversion.evidenceSource) {
    throw new Error("SHILLING_CONVERSION_EVIDENCE_REQUIRED");
  }
  if (input.sourceClass !== "MANAGED_PAID" && input.managedSpendUsd !== null) throw new Error("SHILLING_MANAGED_SPEND_WRONG_SOURCE");
  if ((input.sourceClass === "MANAGED_FREE" || input.sourceClass === "MANAGED_PAID") && input.userProviderSpendUsd !== null) throw new Error("SHILLING_USER_SPEND_WRONG_SOURCE");
  if (input.sourceClass !== "USER_API" && input.sourceClass !== "USER_HOSTED" && input.sourceClass !== "LOCAL" && input.costConfidence !== "UNKNOWN" && input.managedSpendUsd === null) throw new Error("SHILLING_COST_CONFIDENCE_INVALID");
  if (input.usableRaw !== undefined && input.rawAllowance !== undefined && input.usableRaw > input.rawAllowance) throw new Error("SHILLING_CAPACITY_ORDER_INVALID");
  if (input.availableNowRaw !== undefined && input.usableRaw !== undefined && input.availableNowRaw > input.usableRaw) throw new Error("SHILLING_CAPACITY_ORDER_INVALID");
  const { usableRaw, availableNowRaw, ...rest } = input;
  return {
    ...rest,
    shConsumed: normalize(input.rawUsage, input.conversion),
    grossSh: normalize(input.rawAllowance, input.conversion),
    usableSh: normalize(usableRaw, input.conversion),
    availableNowSh: normalize(availableNowRaw, input.conversion),
  };
}

export interface ShillingSummary {
  taskId: string;
  requestCount: number;
  shConsumed: number | null;
  byRole: Record<string, number | null>;
  bySourceClass: Record<ShillingSourceClass, number | null>;
  managedSpendUsd: number | null;
  userProviderSpendUsd: number | null;
  verifiedCompletion: boolean;
  shillingsToVerifiedCompletion: number | null;
  verifiedWorkPerMillionSh: number | null;
  frontierInferenceShare: number | null;
  freeOffloadRatio: number | null;
  managedPaidShare: number | null;
  userOwnedShare: number | null;
  frontierCostPerVerifiedTaskUsd: number | null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function summarizeShillings(taskId: string, entries: readonly ShillingEntry[], completion?: { authority: "FORGEVERIFY"; outcome: "completed" | "blocked"; evidenceId: string }): ShillingSummary {
  const matching = entries.filter((entry) => entry.taskId === taskId);
  const byRole: Record<string, number | null> = {};
  const bySourceClass = Object.fromEntries((["MANAGED_FREE", "MANAGED_PAID", "USER_API", "USER_HOSTED", "LOCAL", "UNKNOWN"] as const).map((source) => [source, sumKnown(matching.filter((entry) => entry.sourceClass === source).map((entry) => entry.shConsumed))])) as Record<ShillingSourceClass, number | null>;
  for (const role of new Set(matching.map((entry) => entry.role))) byRole[role] = sumKnown(matching.filter((entry) => entry.role === role).map((entry) => entry.shConsumed));
  const totalSh = sumKnown(matching.map((entry) => entry.shConsumed));
  const verifiedCompletion = matching.length > 0 && completion?.authority === "FORGEVERIFY" && completion.outcome === "completed" && completion.evidenceId.length > 0;
  const share = (numerator: number | null): number | null => totalSh === null || numerator === null || totalSh <= 0 ? null : numerator / totalSh;
  const paidSh = bySourceClass.MANAGED_PAID;
  const userSh = sumKnown([bySourceClass.USER_API, bySourceClass.USER_HOSTED, bySourceClass.LOCAL]);
  const managedSpend = sumKnown(matching.filter((entry) => entry.sourceClass === "MANAGED_PAID").map((entry) => entry.managedSpendUsd));
  const frontierKnown = matching.length > 0 && matching.every((entry) => typeof entry.frontier === "boolean");
  const frontierSh = frontierKnown ? sumKnown(matching.filter((entry) => entry.frontier).map((entry) => entry.shConsumed)) : null;
  const frontierSpend = frontierKnown ? sumKnown(matching.filter((entry) => entry.frontier && entry.sourceClass === "MANAGED_PAID").map((entry) => entry.managedSpendUsd)) : null;
  return {
    taskId,
    requestCount: matching.length,
    shConsumed: totalSh,
    byRole,
    bySourceClass,
    managedSpendUsd: managedSpend,
    userProviderSpendUsd: sumKnown(matching.filter((entry) => entry.sourceClass === "USER_API" || entry.sourceClass === "USER_HOSTED" || entry.sourceClass === "LOCAL").map((entry) => entry.userProviderSpendUsd)),
    verifiedCompletion,
    shillingsToVerifiedCompletion: verifiedCompletion ? totalSh : null,
    verifiedWorkPerMillionSh: verifiedCompletion && totalSh !== null && totalSh > 0 ? 1_000_000 / totalSh : null,
    frontierInferenceShare: share(frontierSh),
    freeOffloadRatio: share(bySourceClass.MANAGED_FREE),
    managedPaidShare: share(paidSh),
    userOwnedShare: share(userSh),
    frontierCostPerVerifiedTaskUsd: verifiedCompletion ? frontierSpend : null,
  };
}

export class ShillingLedger {
  constructor(private readonly persistence: ISessionPersistence) {}

  async record(entry: ShillingEntry): Promise<boolean> {
    const existing = await this.persistence.getWorkItem(`shilling:${entry.id}`);
    if (existing) {
      if (JSON.stringify((existing as unknown as { entry: ShillingEntry }).entry) !== JSON.stringify(entry)) throw new Error("SHILLING_ENTRY_CONFLICT");
      return false;
    }
    return this.persistence.insertIfAbsent({ id: `shilling:${entry.id}`, kind: "shilling_entry", entry } as unknown as WorkItem);
  }

  async forTask(userId: string, taskId: string): Promise<ShillingEntry[]> {
    const items = await this.persistence.getWorkItemsByKind("shilling_entry");
    return items.map((item) => (item as unknown as { entry: ShillingEntry }).entry)
      .filter((entry) => entry.userId === userId && entry.taskId === taskId);
  }
}

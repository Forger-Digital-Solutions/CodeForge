import { createHash } from "node:crypto";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";

/**
 * R55 wave 2 — product managed-paid allowance and accounting.
 *
 * This ledger is the *product* money authority for managed-paid routes: an owner-scoped
 * monthly-style allowance plus a hard maximum, with reserve/settle/release semantics per
 * physical provider attempt. It is deliberately separate from the paid-evaluation
 * campaign ledger (budget-gated-adapter/evaluation-budget) and from the Shilling meter —
 * user-owned (USER_API) spend never enters this ledger.
 *
 * All money is tracked internally as integer USD micros; work items persist micros and
 * the public surface reports USD. Unknowns fail closed: a null included allowance or a
 * null hard maximum is MANAGED_PAID_ALLOWANCE_UNKNOWN, never an unlimited ceiling, and a
 * missing observed actual settles the reserved estimate — never zero.
 */

export type PaidCostMode = "CHEAPEST" | "BALANCED" | "MAXIMUM_INTELLIGENCE" | "CUSTOM";

export interface ManagedPaidPolicy {
  ownerUserId: string;
  entitlement: "FREE" | "PAID";
  costMode: PaidCostMode;
  includedAllowanceUsd: number | null;
  overageEnabled: boolean;
  hardMaximumUsd: number | null;
  userOwnedAllowed: boolean;
  paidLeadAllowed: boolean;
  updatedAt: string;
}

export interface ManagedPaidReservationInput {
  requestId: string;
  taskId: string;
  role: string;
  providerId: string;
  modelId: string;
  estimatedUsd: number;
  priceSource: string;
}

export interface ManagedPaidReceipt {
  ownerUserId: string;
  requestId: string;
  taskId: string;
  role: string;
  providerId: string;
  modelId: string;
  estimatedUsd: number;
  actualUsd: number | null;
  chargedUsd: number;
  confidence: "OBSERVED" | "ESTIMATED";
  priceSource: string;
  recordedAt: string;
}

export interface ManagedPaidReservation {
  ownerUserId: string;
  requestId: string;
  taskId: string;
  role: string;
  providerId: string;
  modelId: string;
  estimatedUsd: number;
  status: "OPEN" | "SETTLED" | "RELEASED";
  chargedUsd: number | null;
  actualUsd: number | null;
  priceSource: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedPaidSnapshot {
  ownerUserId: string;
  entitlement: ManagedPaidPolicy["entitlement"];
  /** null only when the policy itself is unpriceable (reserve already rejected it). */
  ceilingUsd: number;
  consumedUsd: number;
  reservedUsd: number;
  availableUsd: number;
}

const USD_MICROS = 1_000_000;
const MAX_FIELD_LENGTH = 512;
const COST_MODES = new Set<PaidCostMode>(["CHEAPEST", "BALANCED", "MAXIMUM_INTELLIGENCE", "CUSTOM"]);

export class ManagedPaidAllowanceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ManagedPaidAllowanceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ManagedPaidAllowanceError(code, message);
}

function ownerDigest(ownerUserId: string): string {
  return createHash("sha256").update(ownerUserId).digest("hex");
}

function accountKey(ownerUserId: string): string {
  return `managed-paid-account:${ownerDigest(ownerUserId)}`;
}

function reservationKey(ownerUserId: string, requestId: string): string {
  return `managed-paid-reservation:${createHash("sha256").update(`${ownerUserId}\0${requestId}`).digest("hex")}`;
}

function receiptKey(ownerUserId: string, requestId: string): string {
  return `managed-paid-receipt:${createHash("sha256").update(`${ownerUserId}\0${requestId}`).digest("hex")}`;
}

/** USD → integer micros; every money field must be finite and nonnegative. */
function toMicros(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("MANAGED_PAID_AMOUNT_INVALID", `${field} must be a finite nonnegative USD amount`);
  const micros = Math.round(value * USD_MICROS);
  if (!Number.isSafeInteger(micros)) fail("MANAGED_PAID_AMOUNT_INVALID", `${field} exceeds representable range`);
  return micros;
}

function toUsd(micros: number): number {
  return micros / USD_MICROS;
}

function requireBounded(value: unknown, field: string, max = MAX_FIELD_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) fail("MANAGED_PAID_FIELD_INVALID", `${field} must be a nonempty bounded string`);
  return value;
}

function assertPolicy(policy: ManagedPaidPolicy): { ownerUserId: string; ceilingMicros: number } {
  if (!policy || typeof policy !== "object") fail("MANAGED_PAID_POLICY_INVALID", "policy is required");
  requireBounded(policy.ownerUserId, "ownerUserId");
  if (policy.entitlement !== "PAID") fail("MANAGED_PAID_ENTITLEMENT_REQUIRED", "managed paid allowance requires a PAID entitlement");
  if (!COST_MODES.has(policy.costMode)) fail("MANAGED_PAID_POLICY_INVALID", "costMode is not a known value");
  if (policy.includedAllowanceUsd === null || policy.hardMaximumUsd === null) {
    fail("MANAGED_PAID_ALLOWANCE_UNKNOWN", "included allowance and hard maximum must both be known — never unlimited");
  }
  const included = toMicros(policy.includedAllowanceUsd, "includedAllowanceUsd");
  const hardMax = toMicros(policy.hardMaximumUsd, "hardMaximumUsd");
  if (typeof policy.overageEnabled !== "boolean" || typeof policy.userOwnedAllowed !== "boolean" || typeof policy.paidLeadAllowed !== "boolean") fail("MANAGED_PAID_POLICY_INVALID", "policy flags must be boolean");
  if (Number.isNaN(Date.parse(policy.updatedAt))) fail("MANAGED_PAID_POLICY_INVALID", "updatedAt is not a valid timestamp");
  // Without overage the effective ceiling is the tighter of included and hard max; with
  // overage the hard max is the only line. A hard maximum of zero is a valid "no spend".
  const ceilingMicros = policy.overageEnabled ? hardMax : Math.min(included, hardMax);
  return { ownerUserId: policy.ownerUserId, ceilingMicros };
}

interface StoredReservation {
  ownerUserId: string;
  requestId: string;
  taskId: string;
  role: string;
  providerId: string;
  modelId: string;
  estimatedUsdMicros: number;
  chargedUsdMicros: number | null;
  actualUsdMicros: number | null;
  status: "OPEN" | "SETTLED" | "RELEASED";
  priceSource: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredReceipt {
  ownerUserId: string;
  requestId: string;
  taskId: string;
  role: string;
  providerId: string;
  modelId: string;
  estimatedUsdMicros: number;
  actualUsdMicros: number | null;
  chargedUsdMicros: number;
  confidence: "OBSERVED" | "ESTIMATED";
  priceSource: string;
  recordedAt: string;
}

interface StoredAccount {
  ownerUserId: string;
  consumedUsdMicros: number;
  reservedUsdMicros: number;
  updatedAt: string;
}

function toReservation(record: StoredReservation): ManagedPaidReservation {
  return {
    ownerUserId: record.ownerUserId,
    requestId: record.requestId,
    taskId: record.taskId,
    role: record.role,
    providerId: record.providerId,
    modelId: record.modelId,
    estimatedUsd: toUsd(record.estimatedUsdMicros),
    status: record.status,
    chargedUsd: record.chargedUsdMicros === null ? null : toUsd(record.chargedUsdMicros),
    actualUsd: record.actualUsdMicros === null ? null : toUsd(record.actualUsdMicros),
    priceSource: record.priceSource,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toReceipt(record: StoredReceipt): ManagedPaidReceipt {
  return {
    ownerUserId: record.ownerUserId,
    requestId: record.requestId,
    taskId: record.taskId,
    role: record.role,
    providerId: record.providerId,
    modelId: record.modelId,
    estimatedUsd: toUsd(record.estimatedUsdMicros),
    actualUsd: record.actualUsdMicros === null ? null : toUsd(record.actualUsdMicros),
    chargedUsd: toUsd(record.chargedUsdMicros),
    confidence: record.confidence,
    priceSource: record.priceSource,
    recordedAt: record.recordedAt,
  };
}

function sameReservationInput(record: StoredReservation, input: ManagedPaidReservationInput): boolean {
  const estimatedUsdMicros = toMicros(input.estimatedUsd, "estimatedUsd");
  return record.requestId === input.requestId
    && record.taskId === input.taskId
    && record.role === input.role
    && record.providerId === input.providerId
    && record.modelId === input.modelId
    && record.priceSource === input.priceSource
    && record.estimatedUsdMicros === estimatedUsdMicros;
}

export class ManagedPaidAllowanceLedger {
  constructor(private readonly persistence: ISessionPersistence) {}

  /**
   * Atomically hold `estimatedUsd` against the owner's effective ceiling inside the
   * work-item transaction seam. Same (owner, requestId) with identical input is
   * idempotent — recovery replays re-reserve without double counting; a conflicting
   * duplicate is rejected.
   */
  async reserve(policy: ManagedPaidPolicy, input: ManagedPaidReservationInput): Promise<ManagedPaidReservation> {
    const { ownerUserId, ceilingMicros } = assertPolicy(policy);
    requireBounded(input.requestId, "requestId", 256);
    requireBounded(input.taskId, "taskId", 256);
    requireBounded(input.role, "role", 64);
    requireBounded(input.providerId, "providerId", 128);
    requireBounded(input.modelId, "modelId", 256);
    requireBounded(input.priceSource, "priceSource");
    const estimatedUsdMicros = toMicros(input.estimatedUsd, "estimatedUsd");
    const now = new Date().toISOString();

    return this.persistence.withTransaction(async (tx) => {
      // The account row exists before it is locked so PostgreSQL's SELECT FOR UPDATE
      // serializes concurrent reserves; SQLite's single connection serializes anyway.
      const aKey = accountKey(ownerUserId);
      await tx.insertIfAbsent({ id: aKey, kind: "managed_paid_account", ownerUserId, consumedUsdMicros: 0, reservedUsdMicros: 0, updatedAt: now } as unknown as WorkItem);
      await tx.lockWorkItem(aKey);

      const rKey = reservationKey(ownerUserId, input.requestId);
      const existing = await tx.getWorkItem(rKey) as unknown as { reservation?: StoredReservation } | undefined;
      if (existing) {
        const record = existing.reservation!;
        if (record.ownerUserId !== ownerUserId) fail("MANAGED_PAID_OWNER_MISMATCH", "reservation belongs to a different owner");
        if (!sameReservationInput(record, input)) fail("MANAGED_PAID_RESERVATION_CONFLICT", "requestId already reserved with different terms");
        return toReservation(record);
      }

      const totals = await this.ownerTotals(tx, ownerUserId);
      if (totals.consumedUsdMicros + totals.reservedUsdMicros + estimatedUsdMicros > ceilingMicros) {
        fail("MANAGED_PAID_ALLOWANCE_EXHAUSTED", "reserved estimate would exceed the managed paid ceiling");
      }
      const record: StoredReservation = {
        ownerUserId,
        requestId: input.requestId,
        taskId: input.taskId,
        role: input.role,
        providerId: input.providerId,
        modelId: input.modelId,
        estimatedUsdMicros,
        chargedUsdMicros: null,
        actualUsdMicros: null,
        status: "OPEN",
        priceSource: input.priceSource,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insertIfAbsent({ id: rKey, kind: "managed_paid_reservation", reservation: record } as unknown as WorkItem);
      await this.writeAccount(tx, ownerUserId, now);
      return toReservation(record);
    });
  }

  /**
   * Close an open reservation. A null actual means the provider never reported usage —
   * the reserved estimate is charged honestly as ESTIMATED, never zeroed. An observed
   * actual charges exactly that, OBSERVED.
   */
  async settle(ownerUserId: string, requestId: string, actualUsd: number | null, confidence: "OBSERVED" | "ESTIMATED"): Promise<ManagedPaidReceipt> {
    requireBounded(ownerUserId, "ownerUserId");
    requireBounded(requestId, "requestId", 256);
    const expectedConfidence = actualUsd === null ? "ESTIMATED" : "OBSERVED";
    if (confidence !== expectedConfidence) fail("MANAGED_PAID_CONFIDENCE_INVALID", "confidence must be OBSERVED with an actual and ESTIMATED without one");
    const actualUsdMicros = actualUsd === null ? null : toMicros(actualUsd, "actualUsd");
    const now = new Date().toISOString();

    return this.persistence.withTransaction(async (tx) => {
      const rKey = reservationKey(ownerUserId, requestId);
      await tx.lockWorkItem(rKey);
      const item = await tx.getWorkItem(rKey) as unknown as { reservation?: StoredReservation } | undefined;
      if (!item?.reservation) fail("MANAGED_PAID_RESERVATION_UNKNOWN", "no reservation exists for this requestId");
      const record = item.reservation;
      if (record.ownerUserId !== ownerUserId) fail("MANAGED_PAID_OWNER_MISMATCH", "reservation belongs to a different owner");
      // An OBSERVED actual above the conservative reservation is an accounting invariant
      // breach: record no false lower charge and never silently exceed the hard maximum.
      // The reservation stays OPEN for recovery/reconciliation — the caller must not
      // re-invoke the provider because of this post-response failure.
      if (record.status === "OPEN" && actualUsdMicros !== null && actualUsdMicros > record.estimatedUsdMicros) {
        fail("MANAGED_PAID_ACTUAL_EXCEEDS_RESERVATION", "provider-reported cost exceeds the reserved estimate");
      }
      const chargedUsdMicros = actualUsdMicros ?? record.estimatedUsdMicros;
      if (record.status === "SETTLED") {
        if (record.chargedUsdMicros !== chargedUsdMicros || record.actualUsdMicros !== actualUsdMicros) fail("MANAGED_PAID_RESERVATION_CONFLICT", "reservation already settled with a different amount");
        const existingReceipt = await tx.getWorkItem(receiptKey(ownerUserId, requestId)) as unknown as { receipt?: StoredReceipt } | undefined;
        if (existingReceipt?.receipt) {
          const receipt = existingReceipt.receipt;
          // Idempotent replay returns the stored receipt only when it names this exact
          // settlement — a foreign or mutated record at the key is a conflict, not a
          // receipt.
          if (receipt.ownerUserId !== ownerUserId || receipt.requestId !== requestId || receipt.taskId !== record.taskId || receipt.chargedUsdMicros !== chargedUsdMicros || receipt.confidence !== expectedConfidence) {
            fail("MANAGED_PAID_RESERVATION_CONFLICT", "existing receipt does not match this settlement");
          }
          return toReceipt(receipt);
        }
        // A settled reservation without its receipt is torn state — repair deterministically
        // by writing the receipt the settlement should have produced.
      }
      if (record.status === "RELEASED") fail("MANAGED_PAID_RESERVATION_CONFLICT", "a released reservation cannot be settled");

      const settled: StoredReservation = { ...record, status: "SETTLED", chargedUsdMicros, actualUsdMicros, updatedAt: now };
      await tx.upsertWorkItem({ id: rKey, kind: "managed_paid_reservation", reservation: settled } as unknown as WorkItem);
      const receipt: StoredReceipt = {
        ownerUserId,
        requestId,
        taskId: record.taskId,
        role: record.role,
        providerId: record.providerId,
        modelId: record.modelId,
        estimatedUsdMicros: record.estimatedUsdMicros,
        actualUsdMicros,
        chargedUsdMicros,
        confidence: expectedConfidence,
        priceSource: record.priceSource,
        recordedAt: now,
      };
      await tx.insertIfAbsent({ id: receiptKey(ownerUserId, requestId), kind: "managed_paid_receipt", receipt } as unknown as WorkItem);
      await this.writeAccount(tx, ownerUserId, now);
      return toReceipt(receipt);
    });
  }

  /** Give back an open reservation — for rejections proven to precede provider dispatch. */
  async release(ownerUserId: string, requestId: string): Promise<void> {
    requireBounded(ownerUserId, "ownerUserId");
    requireBounded(requestId, "requestId", 256);
    const now = new Date().toISOString();
    await this.persistence.withTransaction(async (tx) => {
      const rKey = reservationKey(ownerUserId, requestId);
      await tx.lockWorkItem(rKey);
      const item = await tx.getWorkItem(rKey) as unknown as { reservation?: StoredReservation } | undefined;
      if (!item?.reservation) fail("MANAGED_PAID_RESERVATION_UNKNOWN", "no reservation exists for this requestId");
      const record = item.reservation;
      if (record.ownerUserId !== ownerUserId) fail("MANAGED_PAID_OWNER_MISMATCH", "reservation belongs to a different owner");
      if (record.status === "SETTLED") fail("MANAGED_PAID_RESERVATION_CONFLICT", "a settled reservation cannot be released");
      if (record.status === "RELEASED") return;
      await tx.upsertWorkItem({ id: rKey, kind: "managed_paid_reservation", reservation: { ...record, status: "RELEASED", updatedAt: now } } as unknown as WorkItem);
      await this.writeAccount(tx, ownerUserId, now);
    });
  }

  /** Live allowance view for one owner under a given policy. */
  async snapshot(policy: ManagedPaidPolicy): Promise<ManagedPaidSnapshot> {
    const { ownerUserId, ceilingMicros } = assertPolicy(policy);
    const totals = await this.ownerTotals(this.persistence, ownerUserId);
    return {
      ownerUserId,
      entitlement: policy.entitlement,
      ceilingUsd: toUsd(ceilingMicros),
      consumedUsd: toUsd(totals.consumedUsdMicros),
      reservedUsd: toUsd(totals.reservedUsdMicros),
      availableUsd: toUsd(Math.max(0, ceilingMicros - totals.consumedUsdMicros - totals.reservedUsdMicros)),
    };
  }

  /** Owner-scoped receipts — other owners' records are never returned. */
  async receipts(ownerUserId: string, taskId?: string): Promise<ManagedPaidReceipt[]> {
    requireBounded(ownerUserId, "ownerUserId");
    const items = await this.persistence.getWorkItemsByKind("managed_paid_receipt");
    const out: ManagedPaidReceipt[] = [];
    for (const item of items) {
      const record = (item as unknown as { receipt?: StoredReceipt }).receipt;
      if (!record || record.ownerUserId !== ownerUserId) continue;
      if (taskId !== undefined && record.taskId !== taskId) continue;
      out.push(toReceipt(record));
    }
    return out;
  }

  private async ownerTotals(tx: { getWorkItemsByKind(kind: string): Promise<WorkItem[]> }, ownerUserId: string): Promise<{ consumedUsdMicros: number; reservedUsdMicros: number }> {
    const items = await tx.getWorkItemsByKind("managed_paid_reservation");
    let consumedUsdMicros = 0;
    let reservedUsdMicros = 0;
    for (const item of items) {
      const record = (item as unknown as { reservation?: StoredReservation }).reservation;
      if (!record || record.ownerUserId !== ownerUserId) continue;
      if (record.status === "OPEN") reservedUsdMicros += record.estimatedUsdMicros;
      if (record.status === "SETTLED") consumedUsdMicros += record.chargedUsdMicros ?? record.estimatedUsdMicros;
    }
    return { consumedUsdMicros, reservedUsdMicros };
  }

  private async writeAccount(tx: { getWorkItemsByKind(kind: string): Promise<WorkItem[]>; upsertWorkItem(item: WorkItem): Promise<void> }, ownerUserId: string, now: string): Promise<void> {
    const totals = await this.ownerTotals(tx, ownerUserId);
    const account: StoredAccount = { ownerUserId, consumedUsdMicros: totals.consumedUsdMicros, reservedUsdMicros: totals.reservedUsdMicros, updatedAt: now };
    await tx.upsertWorkItem({ id: accountKey(ownerUserId), kind: "managed_paid_account", ...account } as unknown as WorkItem);
  }
}

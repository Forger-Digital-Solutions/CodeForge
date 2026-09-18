import { randomUUID } from "node:crypto";
import type { ModelIdentity, ProviderIdentity } from "@codeforge/core";
import type { ChatRequest, ChatResponse, ProviderAdapter, Usage } from "@codeforge/providers";
import type { ISessionPersistence, SessionPersistenceTx, WorkItem } from "@codeforge/sessions";
import { paidAutoModel, paidAutoRoute, type PaidAutoCanonicalModelId, type PaidAutoRoute } from "./registry.js";

/** Decimal-safe USD accounting: one unit is one millionth of a US dollar. */
export type UsdMicros = bigint;

export interface PriceCard {
  modelIdentity: ModelIdentity;
  providerIdentity: ProviderIdentity;
  canonicalModelId: PaidAutoCanonicalModelId;
  providerId: string;
  providerModelId: string;
  uncachedInputUsdPerMillion: string;
  cachedInputUsdPerMillion?: string;
  outputUsdPerMillion: string;
  cacheWriteUsdPerMillion?: string;
  /** Pricing that supersedes the base token rates once conservative input reaches the threshold. */
  contextTiers?: Array<{
    minInputTokens: number;
    uncachedInputUsdPerMillion: string;
    cachedInputUsdPerMillion?: string;
    outputUsdPerMillion: string;
    cacheWriteUsdPerMillion?: string;
  }>;
  /** Retained for routes that price hidden reasoning separately when usage telemetry exposes it. */
  reasoningUsdPerMillion?: string;
  /** Retained for routes that price tool, image, audio, video, or gateway use separately. */
  toolUsdPerCall?: string;
  imageUsdPerUnit?: string;
  audioUsdPerMinute?: string;
  videoUsdPerSecond?: string;
  gatewayFeeUsdPerRequest?: string;
  region?: string;
  serviceTier?: string;
  currency: "USD";
  status: "CURRENT" | "STALE" | "UNKNOWN";
  source: string;
  effectiveAt: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface PaidEvaluationBudgetSnapshot {
  campaignId: string;
  authorizedUsd: string;
  committedUsd: string;
  reservedUsd: string;
  availableUsd: string;
  reservations: Array<{
    reservationId: string;
    routeId: string;
    estimatedUsd: string;
    status: "RESERVED" | "RECONCILED" | "RELEASED";
    actualUsd?: string;
  }>;
}

/** Exact route identity evidence. A gateway alias never replaces the CodeForge canonical ID. */
export interface PaidRouteReceipt {
  canonicalModelId: PaidAutoCanonicalModelId;
  routeId: string;
  providerId: string;
  requestedProviderModelId: string;
  servedModelId?: string;
}

/** Money evidence stays distinct from the route decision so later analysis never infers price
 * from a model alias or a changing live catalog. */
export interface PaidFinancialReceipt {
  currency: "USD";
  priceCardSource: string;
  priceEffectiveAt: string;
  estimatedUsd: string;
  actualUsd?: string;
  reconciliation: "ACTUAL" | "ESTIMATED_ONLY" | "RELEASED";
}

export interface PaidEvaluationReceipt {
  receiptId: string;
  campaignId: string;
  reservationId: string;
  requestId: string;
  canonicalModelId: PaidAutoCanonicalModelId;
  routeId: string;
  providerId: string;
  requestedProviderModelId: string;
  servedModelId?: string;
  priceCardSource: string;
  estimatedUsd: string;
  actualUsd?: string;
  usage?: Usage;
  reconciliation: "ACTUAL" | "ESTIMATED_ONLY" | "RELEASED";
  routeReceipt: PaidRouteReceipt;
  financialReceipt: PaidFinancialReceipt;
  createdAt: string;
}

export class PaidEvaluationBudgetError extends Error {
  constructor(
    public readonly code:
      | "PAID_EVALUATION_PRICE_UNKNOWN"
      | "PAID_EVALUATION_OUTPUT_BOUND_REQUIRED"
      | "PAID_EVALUATION_BUDGET_EXHAUSTED"
      | "PAID_EVALUATION_RESERVATION_UNKNOWN"
      | "PAID_EVALUATION_RESERVATION_SETTLED"
      | "PAID_EVALUATION_SETTLEMENT_EXCEEDS_RESERVATION"
      | "PAID_EVALUATION_MODEL_IDENTITY_MISMATCH"
      | "PAID_EVALUATION_LEDGER_STATE_INVALID",
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PaidEvaluationBudgetError";
  }
}

interface ReservationState {
  reservationId: string;
  route: PaidAutoRoute;
  estimated: UsdMicros;
  status: "RESERVED" | "RECONCILED" | "RELEASED";
  actual?: UsdMicros;
}

export interface PaidEvaluationReservation {
  readonly reservationId: string;
  readonly estimatedUsd: string;
  reconcile(usage?: Usage, servedModelId?: string): PaidEvaluationReceipt | Promise<PaidEvaluationReceipt>;
  release(servedModelId?: string): PaidEvaluationReceipt | Promise<PaidEvaluationReceipt>;
}

/** A financial gate may be in-process for unit tests or backed by the shared session database in
 * production. Both must reserve before dispatch and reconcile exactly once afterwards. */
export interface PaidEvaluationBudgetGate {
  reserve(requestId: string, route: PaidAutoRoute, price: PriceCard, req: ChatRequest): PaidEvaluationReservation | Promise<PaidEvaluationReservation>;
  snapshot(): PaidEvaluationBudgetSnapshot | Promise<PaidEvaluationBudgetSnapshot>;
}

/**
 * In-memory, deterministic campaign ledger. Its synchronous mutation is atomic within the
 * Node event loop, so simultaneous callers cannot reserve beyond the configured campaign cap.
 * A durable store can be added later without changing the gate's request/receipt contract.
 */
export class PaidEvaluationBudgetLedger implements PaidEvaluationBudgetGate {
  private readonly authorized: UsdMicros;
  private readonly campaignId: string;
  private readonly now: () => Date;
  private committed = 0n;
  private readonly reservations = new Map<string, ReservationState>();

  constructor(options: { campaignId: string; authorizedUsd: string; now?: () => Date }) {
    this.campaignId = options.campaignId;
    assertSafeIdentifier("campaignId", this.campaignId);
    this.authorized = parseUsd(options.authorizedUsd);
    if (this.authorized <= 0n) throw new Error("Paid evaluation budget must be positive");
    this.now = options.now ?? (() => new Date());
  }

  reserve(requestId: string, route: PaidAutoRoute, price: PriceCard, req: ChatRequest): PaidEvaluationReservation {
    assertSafeIdentifier("requestId", requestId);
    assertExactCurrentPrice(route, price);
    const estimated = estimateRequestUsd(req, price);
    const reserved = [...this.reservations.values()]
      .filter((reservation) => reservation.status === "RESERVED")
      .reduce((total, reservation) => total + reservation.estimated, 0n);
    if (this.committed + reserved + estimated > this.authorized) {
      throw new PaidEvaluationBudgetError(
        "PAID_EVALUATION_BUDGET_EXHAUSTED",
        `Reservation ${formatUsd(estimated)} exceeds remaining campaign budget ${formatUsd(this.authorized - this.committed - reserved)}`,
      );
    }
    const state: ReservationState = { reservationId: randomUUID(), route, estimated, status: "RESERVED" };
    this.reservations.set(state.reservationId, state);
    return {
      reservationId: state.reservationId,
      estimatedUsd: formatUsd(state.estimated),
      reconcile: (usage, servedModelId) => this.reconcile(state.reservationId, requestId, price, usage, servedModelId),
      release: (servedModelId) => this.release(state.reservationId, requestId, price, servedModelId),
    };
  }

  snapshot(): PaidEvaluationBudgetSnapshot {
    const reserved = [...this.reservations.values()]
      .filter((reservation) => reservation.status === "RESERVED")
      .reduce((total, reservation) => total + reservation.estimated, 0n);
    return {
      campaignId: this.campaignId,
      authorizedUsd: formatUsd(this.authorized),
      committedUsd: formatUsd(this.committed),
      reservedUsd: formatUsd(reserved),
      availableUsd: formatUsd(this.authorized - this.committed - reserved),
      reservations: [...this.reservations.values()].map((reservation) => ({
        reservationId: reservation.reservationId,
        routeId: reservation.route.routeId,
        estimatedUsd: formatUsd(reservation.estimated),
        status: reservation.status,
        ...(reservation.actual === undefined ? {} : { actualUsd: formatUsd(reservation.actual) }),
      })),
    };
  }

  private reconcile(reservationId: string, requestId: string, price: PriceCard, usage?: Usage, servedModelId?: string): PaidEvaluationReceipt {
    const reservation = this.requireOpen(reservationId);
    const actual = usage ? estimateUsageUsd(usage, price) : reservation.estimated;
    if (actual > reservation.estimated) {
      throw new PaidEvaluationBudgetError(
        "PAID_EVALUATION_SETTLEMENT_EXCEEDS_RESERVATION",
        `Provider-reported usage ${formatUsd(actual)} exceeds the pre-send reservation ${formatUsd(reservation.estimated)}`,
      );
    }
    reservation.status = "RECONCILED";
    reservation.actual = actual;
    this.committed += actual;
    return this.receipt(reservation, requestId, price, usage, usage ? "ACTUAL" : "ESTIMATED_ONLY", servedModelId);
  }

  private release(reservationId: string, requestId: string, price: PriceCard, servedModelId?: string): PaidEvaluationReceipt {
    const reservation = this.requireOpen(reservationId);
    reservation.status = "RELEASED";
    return this.receipt(reservation, requestId, price, undefined, "RELEASED", servedModelId);
  }

  private requireOpen(reservationId: string): ReservationState {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new PaidEvaluationBudgetError("PAID_EVALUATION_RESERVATION_UNKNOWN", `Reservation ${reservationId} is unknown`);
    if (reservation.status !== "RESERVED") throw new PaidEvaluationBudgetError("PAID_EVALUATION_RESERVATION_SETTLED", `Reservation ${reservationId} is ${reservation.status}`);
    return reservation;
  }

  private receipt(reservation: ReservationState, requestId: string, price: PriceCard, usage: Usage | undefined, reconciliation: PaidEvaluationReceipt["reconciliation"], servedModelId?: string): PaidEvaluationReceipt {
    const actualUsd = reservation.actual === undefined ? undefined : formatUsd(reservation.actual);
    const persistedServedModelId = safeServedModelId(servedModelId);
    const routeReceipt: PaidRouteReceipt = {
      canonicalModelId: reservation.route.canonicalModelId,
      routeId: reservation.route.routeId,
      providerId: reservation.route.providerId,
      requestedProviderModelId: reservation.route.providerModelId,
      ...(persistedServedModelId === undefined ? {} : { servedModelId: persistedServedModelId }),
    };
    const financialReceipt: PaidFinancialReceipt = {
      currency: "USD",
      priceCardSource: price.source,
      priceEffectiveAt: price.effectiveAt,
      estimatedUsd: formatUsd(reservation.estimated),
      ...(actualUsd === undefined ? {} : { actualUsd }),
      reconciliation,
    };
    return {
      receiptId: randomUUID(),
      campaignId: this.campaignId,
      reservationId: reservation.reservationId,
      requestId,
      canonicalModelId: reservation.route.canonicalModelId,
      routeId: reservation.route.routeId,
      providerId: reservation.route.providerId,
      requestedProviderModelId: reservation.route.providerModelId,
      ...(persistedServedModelId === undefined ? {} : { servedModelId: persistedServedModelId }),
      priceCardSource: price.source,
      estimatedUsd: formatUsd(reservation.estimated),
      ...(actualUsd === undefined ? {} : { actualUsd }),
      ...(usage === undefined ? {} : { usage }),
      reconciliation,
      routeReceipt,
      financialReceipt,
      createdAt: this.now().toISOString(),
    };
  }
}

interface DurableCampaignRecord {
  campaignId: string;
  sessionId: string;
  authorizedUsd: string;
  committedUsd: string;
  reservedUsd: string;
}

interface DurableReservationRecord {
  campaignId: string;
  reservationId: string;
  requestId: string;
  route: PaidAutoRoute;
  estimatedUsd: string;
  status: "RESERVED" | "RECONCILED" | "RELEASED";
  actualUsd?: string;
}

const durableLedgerId = (campaignId: string): string => `paid-evaluation-ledger-${campaignId}`;
const durableReservationId = (campaignId: string, reservationId: string): string => `paid-evaluation-reservation-${campaignId}-${reservationId}`;
const pendingMutations = new WeakMap<object, Promise<void>>();
const UNSAFE_IDENTIFIER = /(?:api[_-]?key|authorization\s*[:=]|bearer\s+|oauth|password\s*[:=]|secret\s*[:=]|sk-[a-z0-9]|gsk_|gh[pousr]_|github_pat_|xox[baprs]-|-----begin [a-z ]*private key-----)/i;

function assertSafeIdentifier(field: string, value: string): void {
  if (value.length === 0 || value.length > 160 || UNSAFE_IDENTIFIER.test(value)) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `${field} cannot contain secrets or unbounded text`);
  }
}

function safeServedModelId(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 160 || UNSAFE_IDENTIFIER.test(value)) return undefined;
  return value;
}

/** SQLite exposes one connection and rejects overlapping explicit transactions. Serialize local
 * callers while PostgreSQL's row lock covers the same campaign across server processes. */
async function serializeMutation<T>(persistence: ISessionPersistence, operation: () => Promise<T>): Promise<T> {
  const previous = pendingMutations.get(persistence) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  pendingMutations.set(persistence, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (pendingMutations.get(persistence) === tail) pendingMutations.delete(persistence);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `${label} is malformed`);
  return value as Record<string, unknown>;
}

function readCampaign(item: WorkItem | undefined, campaignId: string, sessionId: string): DurableCampaignRecord {
  if (!item || item.kind !== "paid_evaluation_campaign_ledger" || item.campaignId !== campaignId || item.sessionId !== sessionId) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Campaign ledger ${campaignId} is missing`);
  }
  const record = asRecord(item.record, "Paid evaluation campaign ledger");
  const authorizedUsd = record.authorizedUsd;
  const committedUsd = record.committedUsd;
  const reservedUsd = record.reservedUsd;
  if (record.campaignId !== campaignId || record.sessionId !== sessionId || typeof authorizedUsd !== "string" || typeof committedUsd !== "string" || typeof reservedUsd !== "string") {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Campaign ledger ${campaignId} has invalid money fields`);
  }
  const authorized = parseUsd(authorizedUsd);
  const committed = parseUsd(committedUsd);
  const reserved = parseUsd(reservedUsd);
  if (authorized <= 0n || committed < 0n || reserved < 0n || committed + reserved > authorized) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Campaign ledger ${campaignId} violates its budget invariant`);
  }
  return { campaignId, sessionId, authorizedUsd, committedUsd, reservedUsd };
}

function readReservation(item: WorkItem | undefined, campaignId: string, reservationId: string, sessionId: string): DurableReservationRecord {
  if (!item || item.kind !== "paid_evaluation_reservation" || item.campaignId !== campaignId || item.sessionId !== sessionId) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_RESERVATION_UNKNOWN", `Reservation ${reservationId} is unknown`);
  }
  const record = asRecord(item.record, "Paid evaluation reservation");
  const route = record.route;
  if (record.campaignId !== campaignId || record.reservationId !== reservationId || typeof record.requestId !== "string" || typeof record.estimatedUsd !== "string" || (record.status !== "RESERVED" && record.status !== "RECONCILED" && record.status !== "RELEASED") || !route || typeof route !== "object") {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Reservation ${reservationId} is malformed`);
  }
  parseUsd(record.estimatedUsd);
  if (record.actualUsd !== undefined && typeof record.actualUsd !== "string") throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Reservation ${reservationId} has an invalid actual amount`);
  if (typeof record.actualUsd === "string") parseUsd(record.actualUsd);
  return {
    campaignId,
    reservationId,
    requestId: record.requestId,
    route: route as PaidAutoRoute,
    estimatedUsd: record.estimatedUsd,
    status: record.status,
    ...(typeof record.actualUsd === "string" ? { actualUsd: record.actualUsd } : {}),
  };
}

/**
 * Transactional paid-evaluation ledger for the shared SQLite/PostgreSQL session store. Every
 * reserve/reconcile/release locks the campaign record, so independent server processes cannot
 * over-reserve an owner-approved ceiling. It persists only identity, price source, usage and
 * money evidence — never a request prompt, provider response body, or credential.
 */
export class DurablePaidEvaluationBudgetLedger implements PaidEvaluationBudgetGate {
  private readonly campaignId: string;
  private readonly sessionId: string;
  private readonly authorized: UsdMicros;
  private readonly now: () => Date;
  private initialized?: Promise<void>;

  constructor(private readonly persistence: ISessionPersistence, options: { campaignId: string; sessionId: string; authorizedUsd: string; now?: () => Date }) {
    this.campaignId = options.campaignId;
    this.sessionId = options.sessionId;
    assertSafeIdentifier("campaignId", this.campaignId);
    assertSafeIdentifier("sessionId", this.sessionId);
    this.authorized = parseUsd(options.authorizedUsd);
    if (this.authorized <= 0n) throw new Error("Paid evaluation budget must be positive");
    this.now = options.now ?? (() => new Date());
  }

  async reserve(requestId: string, route: PaidAutoRoute, price: PriceCard, req: ChatRequest): Promise<PaidEvaluationReservation> {
    assertSafeIdentifier("requestId", requestId);
    assertExactCurrentPrice(route, price);
    const estimated = estimateRequestUsd(req, price);
    await this.ensureCampaign();
    const reservationId = randomUUID();
    await serializeMutation(this.persistence, () => this.persistence.withTransaction(async (tx) => {
      const campaign = await this.lockCampaign(tx);
      const committed = parseUsd(campaign.committedUsd);
      const reserved = parseUsd(campaign.reservedUsd);
      if (committed + reserved + estimated > this.authorized) {
        throw new PaidEvaluationBudgetError("PAID_EVALUATION_BUDGET_EXHAUSTED", `Reservation ${formatUsd(estimated)} exceeds remaining campaign budget ${formatUsd(this.authorized - committed - reserved)}`);
      }
      const now = this.now().toISOString();
      const state: DurableReservationRecord = {
        campaignId: this.campaignId,
        reservationId,
        requestId,
        route,
        estimatedUsd: formatUsd(estimated),
        status: "RESERVED",
      };
      const inserted = await tx.insertIfAbsent({
        kind: "paid_evaluation_reservation",
        id: durableReservationId(this.campaignId, reservationId),
        sessionId: this.sessionId,
        campaignId: this.campaignId,
        record: state as unknown as Record<string, unknown>,
        createdAt: now,
        updatedAt: now,
      });
      if (!inserted) throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Reservation id collision for ${reservationId}`);
      await tx.upsertWorkItem(this.campaignItem({ ...campaign, reservedUsd: formatUsd(reserved + estimated) }, now));
    }));
    return {
      reservationId,
      estimatedUsd: formatUsd(estimated),
      reconcile: (usage, servedModelId) => this.settle(reservationId, requestId, price, usage, "ACTUAL", servedModelId),
      release: (servedModelId) => this.settle(reservationId, requestId, price, undefined, "RELEASED", servedModelId),
    };
  }

  async snapshot(): Promise<PaidEvaluationBudgetSnapshot> {
    await this.ensureCampaign();
    const campaign = readCampaign(await this.persistence.getWorkItem(durableLedgerId(this.campaignId)), this.campaignId, this.sessionId);
    const reservations = (await this.persistence.getWorkItems(this.sessionId))
      .filter((item): item is Extract<WorkItem, { kind: "paid_evaluation_reservation" }> => item.kind === "paid_evaluation_reservation" && item.campaignId === this.campaignId)
      .map((item) => readReservation(item, this.campaignId, (item.record as Record<string, unknown>).reservationId as string, this.sessionId))
      .sort((left, right) => left.reservationId.localeCompare(right.reservationId));
    return {
      campaignId: this.campaignId,
      authorizedUsd: campaign.authorizedUsd,
      committedUsd: campaign.committedUsd,
      reservedUsd: campaign.reservedUsd,
      availableUsd: formatUsd(parseUsd(campaign.authorizedUsd) - parseUsd(campaign.committedUsd) - parseUsd(campaign.reservedUsd)),
      reservations: reservations.map((reservation) => ({
        reservationId: reservation.reservationId,
        routeId: reservation.route.routeId,
        estimatedUsd: reservation.estimatedUsd,
        status: reservation.status,
        ...(reservation.actualUsd === undefined ? {} : { actualUsd: reservation.actualUsd }),
      })),
    };
  }

  async listReceipts(): Promise<PaidEvaluationReceipt[]> {
    return (await this.persistence.getWorkItems(this.sessionId))
      .filter((item): item is Extract<WorkItem, { kind: "paid_evaluation_receipt" }> => item.kind === "paid_evaluation_receipt" && item.campaignId === this.campaignId)
      .map((item) => item.record as unknown as PaidEvaluationReceipt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async ensureCampaign(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        const now = this.now().toISOString();
        await this.persistence.insertIfAbsent(this.campaignItem({
          campaignId: this.campaignId,
          sessionId: this.sessionId,
          authorizedUsd: formatUsd(this.authorized),
          committedUsd: "0.0",
          reservedUsd: "0.0",
        }, now));
        const existing = readCampaign(await this.persistence.getWorkItem(durableLedgerId(this.campaignId)), this.campaignId, this.sessionId);
        if (parseUsd(existing.authorizedUsd) !== this.authorized) {
          throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Campaign ${this.campaignId} already exists with a different authorized ceiling`);
        }
      })();
    }
    return this.initialized;
  }

  private campaignItem(record: DurableCampaignRecord, now: string): Extract<WorkItem, { kind: "paid_evaluation_campaign_ledger" }> {
    return {
      kind: "paid_evaluation_campaign_ledger",
      id: durableLedgerId(this.campaignId),
      sessionId: this.sessionId,
      campaignId: this.campaignId,
      record: record as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async lockCampaign(tx: SessionPersistenceTx): Promise<DurableCampaignRecord> {
    await tx.lockWorkItem(durableLedgerId(this.campaignId));
    return readCampaign(await tx.getWorkItem(durableLedgerId(this.campaignId)), this.campaignId, this.sessionId);
  }

  private async settle(reservationId: string, requestId: string, price: PriceCard, usage: Usage | undefined, requestedReconciliation: "ACTUAL" | "RELEASED", servedModelId?: string): Promise<PaidEvaluationReceipt> {
    await this.ensureCampaign();
    return serializeMutation(this.persistence, () => this.persistence.withTransaction(async (tx) => {
      const campaign = await this.lockCampaign(tx);
      const itemId = durableReservationId(this.campaignId, reservationId);
      await tx.lockWorkItem(itemId);
      const currentReservationItem = await tx.getWorkItem(itemId);
      const reservation = readReservation(currentReservationItem, this.campaignId, reservationId, this.sessionId);
      if (reservation.status !== "RESERVED") throw new PaidEvaluationBudgetError("PAID_EVALUATION_RESERVATION_SETTLED", `Reservation ${reservationId} is ${reservation.status}`);
      if (reservation.requestId !== requestId) throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Reservation ${reservationId} cannot be settled by another request`);
      assertExactCurrentPrice(reservation.route, price);
      const estimated = parseUsd(reservation.estimatedUsd);
      const actual = usage ? estimateUsageUsd(usage, price) : 0n;
      if (actual > estimated) {
        throw new PaidEvaluationBudgetError("PAID_EVALUATION_SETTLEMENT_EXCEEDS_RESERVATION", `Provider-reported usage ${formatUsd(actual)} exceeds the pre-send reservation ${formatUsd(estimated)}`);
      }
      const committed = parseUsd(campaign.committedUsd);
      const reserved = parseUsd(campaign.reservedUsd);
      if (reserved < estimated) throw new PaidEvaluationBudgetError("PAID_EVALUATION_LEDGER_STATE_INVALID", `Campaign ${this.campaignId} has insufficient reserved balance`);
      const status = requestedReconciliation === "RELEASED" ? "RELEASED" : "RECONCILED" as const;
      const settled: DurableReservationRecord = {
        ...reservation,
        status,
        ...(status === "RECONCILED" ? { actualUsd: formatUsd(actual) } : {}),
      };
      const receipt = this.receipt(settled, price, usage, status === "RECONCILED" ? "ACTUAL" : "RELEASED", servedModelId);
      const now = receipt.createdAt;
      await tx.upsertWorkItem({
        kind: "paid_evaluation_reservation",
        id: itemId,
        sessionId: this.sessionId,
        campaignId: this.campaignId,
        record: settled as unknown as Record<string, unknown>,
        createdAt: currentReservationItem?.kind === "paid_evaluation_reservation" ? currentReservationItem.createdAt : now,
        updatedAt: now,
      });
      await tx.upsertWorkItem(this.campaignItem({
        ...campaign,
        committedUsd: formatUsd(committed + actual),
        reservedUsd: formatUsd(reserved - estimated),
      }, now));
      await tx.insertIfAbsent({
        kind: "paid_evaluation_receipt",
        id: `paid-evaluation-receipt-${receipt.receiptId}`,
        sessionId: this.sessionId,
        campaignId: this.campaignId,
        record: receipt as unknown as Record<string, unknown>,
        createdAt: now,
      });
      return receipt;
    }));
  }

  private receipt(reservation: DurableReservationRecord, price: PriceCard, usage: Usage | undefined, reconciliation: PaidEvaluationReceipt["reconciliation"], servedModelId?: string): PaidEvaluationReceipt {
    const persistedServedModelId = safeServedModelId(servedModelId);
    const routeReceipt: PaidRouteReceipt = {
      canonicalModelId: reservation.route.canonicalModelId,
      routeId: reservation.route.routeId,
      providerId: reservation.route.providerId,
      requestedProviderModelId: reservation.route.providerModelId,
      ...(persistedServedModelId === undefined ? {} : { servedModelId: persistedServedModelId }),
    };
    const financialReceipt: PaidFinancialReceipt = {
      currency: "USD",
      priceCardSource: price.source,
      priceEffectiveAt: price.effectiveAt,
      estimatedUsd: reservation.estimatedUsd,
      ...(reservation.actualUsd === undefined ? {} : { actualUsd: reservation.actualUsd }),
      reconciliation,
    };
    return {
      receiptId: randomUUID(),
      campaignId: this.campaignId,
      reservationId: reservation.reservationId,
      requestId: reservation.requestId,
      canonicalModelId: reservation.route.canonicalModelId,
      routeId: reservation.route.routeId,
      providerId: reservation.route.providerId,
      requestedProviderModelId: reservation.route.providerModelId,
      ...(persistedServedModelId === undefined ? {} : { servedModelId: persistedServedModelId }),
      priceCardSource: price.source,
      estimatedUsd: reservation.estimatedUsd,
      ...(reservation.actualUsd === undefined ? {} : { actualUsd: reservation.actualUsd }),
      ...(usage === undefined ? {} : { usage }),
      reconciliation,
      routeReceipt,
      financialReceipt,
      createdAt: this.now().toISOString(),
    };
  }
}

/** Exact-model OpenRouter evaluation only. This does not call Paid Auto's direct/fallback router. */
export class PaidAutoOpenRouterEvaluationRunner {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly ledger: PaidEvaluationBudgetGate,
    private readonly priceCards: readonly PriceCard[],
    private readonly onReceipt?: (receipt: PaidEvaluationReceipt) => void,
  ) {}

  async chat(input: { requestId: string; canonicalModelId: PaidAutoCanonicalModelId; request: Omit<ChatRequest, "model"> }): Promise<{ response: ChatResponse; receipt: PaidEvaluationReceipt }> {
    const model = paidAutoModel(input.canonicalModelId);
    if (!model) throw new Error(`Unknown Paid Auto canonical model ${input.canonicalModelId}`);
    const route = model.fallback;
    const price = this.priceCards.find((candidate) => candidate.canonicalModelId === input.canonicalModelId && candidate.providerId === route.providerId && candidate.providerModelId === route.providerModelId);
    if (!price) throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", `No exact current PriceCard for ${route.providerModelId}`);
    // Send the exact provider slug directly. There is deliberately no OpenRouter model list or
    // gateway auto-selection field on an evaluation request.
    const request: ChatRequest = { ...input.request, model: route.providerModelId, fallbackModels: undefined };
    const reservation = await this.ledger.reserve(input.requestId, route, price, request);
    try {
      const response = await this.adapter.chat(request);
      if (response.model !== route.providerModelId) {
        const released = await reservation.release(response.model);
        this.onReceipt?.(released);
        throw new PaidEvaluationBudgetError("PAID_EVALUATION_MODEL_IDENTITY_MISMATCH", "Provider served model identity did not match the exact requested route");
      }
      const receipt = await reservation.reconcile(response.usage, response.model);
      this.onReceipt?.(receipt);
      return { response, receipt };
    } catch (error) {
      // A transport failure before a usable response consumes no deliberate evaluation budget;
      // a provider-side ambiguous execution remains outside the estimate and must be audited.
      try {
        const receipt = await reservation.release();
        this.onReceipt?.(receipt);
      } catch (releaseError) {
        if (!(releaseError instanceof PaidEvaluationBudgetError) || releaseError.code !== "PAID_EVALUATION_RESERVATION_SETTLED") throw releaseError;
      }
      throw error;
    }
  }
}

export function estimateRequestUsd(req: ChatRequest, price: PriceCard): UsdMicros {
  assertCurrentPrice(price);
  if (!Number.isInteger(req.maxTokens) || req.maxTokens === undefined || req.maxTokens <= 0) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_OUTPUT_BOUND_REQUIRED", "Paid evaluation requires an explicit positive maxTokens cap");
  }
  const promptChars = (req.system?.length ?? 0)
    + req.messages.reduce((total, message) => total + message.content.length, 0)
    + JSON.stringify(req.tools ?? []).length;
  // This is an upper admission bound, not a token-estimation heuristic: one token per UTF-16
  // code unit plus framing slack avoids a post-response bill exceeding the pre-send reservation.
  const conservativeInputTokens = Math.max(1, promptChars + (req.messages.length * 16) + 256);
  return priceForUsage({ inputTokens: conservativeInputTokens, outputTokens: req.maxTokens }, price);
}

export function estimateUsageUsd(usage: Usage, price: PriceCard): UsdMicros {
  assertCurrentPrice(price);
  return priceForUsage(usage, price);
}

export function parseUsd(value: string): UsdMicros {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`Invalid USD decimal ${value}`);
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
}

export function formatUsd(value: UsdMicros): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fraction || "0"}`;
}

function assertExactCurrentPrice(route: PaidAutoRoute, price: PriceCard): void {
  const registered = paidAutoRoute(route.routeId);
  if (!registered || registered.canonicalModelId !== route.canonicalModelId || registered.providerId !== route.providerId || registered.providerModelId !== route.providerModelId) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", "Paid evaluation route is not a registered canonical route");
  }
  assertSafeIdentifier("priceCard.source", price.source);
  if (
    route.canonicalModelId !== price.canonicalModelId
    || route.providerId !== price.providerId
    || route.providerModelId !== price.providerModelId
    || price.modelIdentity.canonicalModelId !== route.canonicalModelId
    || price.modelIdentity.providerId !== route.providerId
    || price.modelIdentity.providerModelId !== route.providerModelId
    || price.providerIdentity.providerId !== route.providerId
  ) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", "PriceCard identity does not match the exact requested Paid Auto route");
  }
  assertCurrentPrice(price);
}

function assertCurrentPrice(price: PriceCard): void {
  if (price.currency !== "USD" || price.status !== "CURRENT" || !price.source || price.confidence === "LOW") {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", "Paid evaluation requires a current, non-low-confidence USD PriceCard");
  }
  if (price.reasoningUsdPerMillion !== undefined || price.toolUsdPerCall !== undefined || price.imageUsdPerUnit !== undefined || price.audioUsdPerMinute !== undefined || price.videoUsdPerSecond !== undefined) {
    throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", "Paid evaluation cannot use a PriceCard with billed dimensions that the adapter cannot observe and reserve");
  }
}

function priceForUsage(usage: Pick<Usage, "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens">, price: PriceCard): UsdMicros {
  const tier = [...(price.contextTiers ?? [])]
    .filter((candidate) => Number.isSafeInteger(candidate.minInputTokens) && candidate.minInputTokens >= 0 && usage.inputTokens >= candidate.minInputTokens)
    .sort((left, right) => right.minInputTokens - left.minInputTokens)[0];
  const uncachedInputRate = tier?.uncachedInputUsdPerMillion ?? price.uncachedInputUsdPerMillion;
  const outputRate = tier?.outputUsdPerMillion ?? price.outputUsdPerMillion;
  const cachedInputRate = tier?.cachedInputUsdPerMillion ?? price.cachedInputUsdPerMillion ?? uncachedInputRate;
  const cacheWriteRateValue = tier?.cacheWriteUsdPerMillion ?? price.cacheWriteUsdPerMillion ?? "0";
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const uncached = usage.inputTokens - cached;
  const cacheReadRate = parseUsd(cachedInputRate);
  const cacheWriteRate = parseUsd(cacheWriteRateValue);
  const input = proportionalUsd(uncached, parseUsd(uncachedInputRate));
  const cacheRead = proportionalUsd(cached, cacheReadRate);
  const output = proportionalUsd(usage.outputTokens, parseUsd(outputRate));
  const cacheWrite = proportionalUsd(usage.cacheWriteTokens ?? 0, cacheWriteRate);
  return input + cacheRead + output + cacheWrite + parseUsd(price.gatewayFeeUsdPerRequest ?? "0");
}

function proportionalUsd(tokens: number, ratePerMillion: UsdMicros): UsdMicros {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Token usage must be a non-negative safe integer");
  return (BigInt(tokens) * ratePerMillion + 999_999n) / 1_000_000n;
}

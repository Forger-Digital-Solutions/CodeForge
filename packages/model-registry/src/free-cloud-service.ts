import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import {
  supplyClassIsZeroCash,
  type CapacityRoute,
  type CapacityWindow,
  type ProviderCapacityPool,
  type SupplyClass,
} from "@codeforge/forge-zero";
import type { ChatRequest, ProviderAdapter, ProviderCatalog, ProviderExecutionContext, ProviderResponseObservation, ProviderResponseObserver, StreamEvent } from "@codeforge/providers";
import {
  runRoleAwareQualification,
  rateLimitObservationFromHeaders,
  type EightBitRouteHealthAuthority,
  type EightBitRole,
  type ModelQualificationReceipt,
  type QualificationPersistence,
  InMemoryQualificationPersistence,
} from "@codeforge/eight-bit";
import { canonicalIdentityFor } from "./canonical.js";
import {
  buildFreeCloudSnapshot,
  explainRoute,
  freeCandidates,
  supplyClassFor,
  type FreeCandidate,
  type FreeCloudSnapshot,
  type ProviderConnectionState,
  type ProviderRouteView,
  type RouteHealth,
  type RouteQuota,
} from "./free-cloud-registry.js";
import { PROVIDER_DEFINITIONS, type ProviderDefinition } from "./provider-definitions.js";
import type { NormalizedModelRegistry } from "./registry.js";
import { RouteQuotaTracker, parseRouteQuota, effectiveQuota, exhaustedQuotaResetAt } from "./quota.js";
import { createFreeModelCatalogRefresh, type FreeModelCatalogRefresh, type RefreshOptions } from "./catalog-refresh.js";

/**
 * Routing hooks ForgeAuto (the server's AgentRuntime) consumes. 8-Bit maintains the pool; the
 * router decides. Everything here is a pure lookup over the current registry state.
 */
export interface FreeCloudRoutingHooks {
  isForgeAutoEligible(providerId: string, modelId: string): boolean;
  supplyClassOf?(providerId: string, modelId: string): SupplyClass | undefined;
  canonicalIdOf(providerId: string, modelId: string): string;
  /** Other ForgeAuto-eligible routes serving the same canonical model (same-model failover first). */
  sameModelAlternates(providerId: string, modelId: string): Array<{ providerId: string; modelId: string }>;
  recordRouteFailure(providerId: string, modelId: string, reason: string, retryAfterMs?: number): void;
  recordRouteSuccess(providerId: string, modelId: string): void;
  quotaRemaining(providerId: string, modelId: string): number | undefined;
  /** Deterministic 8-Bit advice for choosing among already-admitted free routes. */
  capacityRoutingAdvice(providerId: string, modelId: string): { scoreAdjustment: number; reasonCodes: string[] };
  /**
   * R41: the route's persisted qualification receipt — the evidence behind per-role
   * advisory ranking. Optional so existing hosts/mocks stay valid; absent (or an absent
   * receipt) contributes a zero role-quality adjustment, never a disqualification.
   */
  getQualificationReceipt?(providerId: string, modelId: string): ModelQualificationReceipt | undefined;
  /**
   * R51: measure a route's quota domain on demand when the fabric denies it as
   * CAPACITY_UNMEASURED — a metadata quota endpoint where available, else one bounded
   * `maxTokens: 1` ping whose headers land through the response observer. Optional so
   * existing hosts/mocks stay valid; absent means unmeasured candidates stay denied.
   */
  probeRouteCapacity?(providerId: string, modelId?: string, opts?: { capacityPoolId?: string }): Promise<boolean>;
  /**
   * R59: verified-free routes still awaiting a CodeForge qualification receipt — the set a
   * denial-time recovery cycle could make eligible. Optional; absent means "nothing pending"
   * for recovery purposes, never fabricated as qualified.
   */
  pendingQualification?(): ProviderRouteView[];
  /** Whether a qualification cycle is currently in flight. */
  isQualifying?(): boolean;
  /**
   * Per-provider qualification posture — pending counts, in-flight state, and daily spend
   * against each lane's budget. Denial-time recovery uses it to keep waiting only while a
   * lane can still produce a verdict; a lane at its daily budget is done honestly.
   */
  qualificationSummary?(): Array<{ providerId: string; pending: number; qualifying: boolean; requestsSpentToday: number; dailyBudget: number; liveEvidence?: boolean; recoveryScheduledAt?: string }>;
  /**
   * R59: run one bounded qualification cycle over pending routes. `recovery: true` skips the
   * normal inter-cycle interval — used only when provider-stated cooldowns elapsed — but
   * never the per-day budget or the bounded recovery allowance. Optional so existing
   * hosts/mocks stay valid.
   */
  qualifyPending?(opts?: { providerId?: string; recovery?: boolean }): Promise<ModelQualificationReceipt[]>;
  /**
   * R59: the smallest stamped input-token serving window across this user's routes the fabric
   * could admit for a role — the largest single-request prompt the fleet can physically
   * ingest. `undefined` when no candidate route stamps a token window (unbounded upstreams
   * never clamp context). `role` is the fabric's model-role vocabulary (e.g.
   * PRIMARY_CODING_AGENT). Optional so existing hosts/mocks stay valid.
   */
  servingInputTokenCeiling?(userId: string, role: string): number | undefined;
}

export interface FreeCloudServiceOptions {
  firewall: ForgeZero;
  providerCatalog: ProviderCatalog;
  registry: NormalizedModelRegistry;
  definitions?: Record<string, ProviderDefinition>;
  qualificationStore?: QualificationPersistence;
  now?: () => Date;
  /** Max routes to qualify per `qualifyPending` cycle (free quota is finite). Default 3. */
  maxQualificationsPerCycle?: number;
  /**
   * Suite runner for one route. `runOpts.signal` aborts the suite's in-flight provider calls at
   * the cycle's wall-clock deadline — the runner should surface that abort as a transient
   * outcome so a saturated upstream stays pending rather than earning a capability verdict.
   */
  qualificationRunner?: (model: FreeModelRecord, adapter: ProviderAdapter, runOpts?: { signal?: AbortSignal }) => Promise<ModelQualificationReceipt>;
  /** Cooldown base for route failures recorded through the hooks. */
  failureCooldownMs?: number;
  /** Free quota is shared with real work: cap qualification requests per provider per day.
   *  Default 24 — one worst-case role-aware suite (13 probes + retries) per provider per day. */
  qualificationDailyBudgetPerProvider?: number;
  /** Estimated requests one qualification cycle spends; used for the daily-budget pre-check
   *  before a suite runs (the receipt's reported count reconciles the real spend after).
   *  Default: the role-aware suite's clean cost, or the compact suite's 3 when a custom
   *  `qualificationRunner` is injected without a declared cost. */
  qualificationRequestsPerCycle?: number;
  /** Minimum interval between qualification cycles for the same provider. Default 20 minutes. */
  qualificationCycleIntervalMs?: number;
  /**
   * R59: how many providers' qualification lanes may run concurrently in one `qualifyPending`
   * cycle. Provider quotas are independent, so a saturated provider's slow suite must not
   * serialize a healthy provider's pending routes behind it. Routes within a provider stay
   * serial — they share that provider's daily qualification budget. Default 2.
   */
  qualificationProviderConcurrency?: number;
  /**
   * R59: wall-clock bound for one route's qualification suite. A saturated upstream makes every
   * case hit its per-observe timeout, stretching a suite past any admission wait; the deadline
   * aborts in-flight probes and the suite reports transient evidence — the route stays pending
   * and retries at its cooldown instead of producing a starvation verdict it never earned.
   * Default 6 minutes.
   */
  qualificationSuiteDeadlineMs?: number;
  /**
   * R59: bound on one capacity-measurement probe (`probeAccountQuota` or the 1-token ping). The
   * adapter calls carry no timeout of their own; a stalled connection must not hold an
   * admission recovery wait indefinitely. Default 30 seconds.
   */
  capacityProbeTimeoutMs?: number;
  /**
   * R59: floor on spacing between provider-bound probe/qualification requests for providers
   * without a declared `freeAccess.maxRequestsPerMinute`. Free tiers rate-limit per minute —
   * an unpaced suite bursts past the cap and trips its own 429 mid-measurement, burning the
   * provider's daily qualification budget on evidence that never lands. Default 1.2s.
   */
  probeMinIntervalMs?: number;
  /**
   * R59: bound on cooldown-aligned recovery cycles per provider per day. A cycle that ended
   * transient-only schedules a retry at the provider's own cooldown expiry; this cap keeps a
   * permanently saturated upstream from being re-probed forever. Default 8.
   */
  qualificationRecoveryAttemptsPerProviderPerDay?: number;
  /**
   * R24: the host-shared route-health authority. When wired (or via {@link setRouteHealth}),
   * every provider response observation also lands there as a normalized `rate_limit_headers`
   * fact — one header stream feeds the quota tracker, the governor, and the authority, once.
   */
  routeHealth?: EightBitRouteHealthAuthority;
}

/** Family prior for qualification ordering — strong coding/agent families are tested first. */
const FAMILY_PRIOR: Record<string, number> = {
  "gpt-oss": 10,
  glm: 9,
  laguna: 9,
  nemotron: 8,
  qwen: 8,
  kimi: 8,
  deepseek: 8,
  devstral: 7,
  gemma: 6,
  gemini: 6,
  mistral: 5,
  llama: 4,
  codestral: 5,
};

interface RouteHealthEntry {
  status: RouteHealth;
  cooldownUntil?: number;
  consecutiveFailures: number;
  lastReason?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

/**
 * R34 Mission B: one server-owned upstream account behind a provider. A provider connection
 * says "credentials exist"; a managed pool says "this account is a distinct physical quota
 * domain we may schedule against." PURE_MANAGED_FREE supply is a fleet of these, not a single
 * implied bucket — quota observations stamped with `accountId` key to it directly.
 */
export type ManagedPoolState = "ACTIVE" | "QUARANTINED" | "DISABLED";

export interface ManagedPoolRecord {
  /** `managed:<providerId>:<accountId>` */
  poolId: string;
  providerId: string;
  accountId: string;
  /** Zero-cash only — a managed pool can never be the vehicle for paid or owner supply. */
  supplyClass: SupplyClass;
  state: ManagedPoolState;
  reason?: string;
  at: string;
}

/** Persistence seam for the managed fleet. Durable hosts implement this; the in-memory
 *  default keeps tests and the ephemeral path honest (a quarantine never silently clears). */
export interface ManagedPoolPersistence {
  save(record: ManagedPoolRecord): Promise<void>;
  delete(poolId: string): Promise<void>;
  loadAll(): Promise<ManagedPoolRecord[]>;
}

export class InMemoryManagedPoolPersistence implements ManagedPoolPersistence {
  private readonly rows = new Map<string, ManagedPoolRecord>();
  async save(record: ManagedPoolRecord): Promise<void> {
    this.rows.set(record.poolId, { ...record });
  }
  async delete(poolId: string): Promise<void> {
    this.rows.delete(poolId);
  }
  async loadAll(): Promise<ManagedPoolRecord[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}

const SHARED_MAX_COOLDOWN_MS = 15 * 60_000;
const NO_RESET = "9999-12-31T23:59:59.999Z";
/** Clean request cost of the default role-aware suite: 3 compact probes + 10 role cases. */
const ROLE_SUITE_REQUESTS = 13;
/** Legacy assumed cycle cost for injected runners that do not declare one. */
const COMPACT_SUITE_REQUESTS = 3;
/** A recovery fire that lands mid-cycle re-arms on this cadence instead of dropping — the
 *  periodic rediscovery tick is interval-gated and may not re-attempt within the cooldown. */
const RECOVERY_DEFER_RETRY_MS = 5_000;
/** How long a deferred recovery keeps re-arming before the periodic tick becomes the backstop. */
const RECOVERY_DEFER_WINDOW_MS = 10 * 60_000;

/** Provider headers only ever report request/token buckets; everything we emit is observed
 *  evidence (`authoritative: true`) or absent — CodeForge never invents quota numbers. An
 *  elapsed reset refills to the declared limit (`effectiveQuota`) — a stale zero otherwise
 *  strands the pool forever because no traffic flows to refresh the headers. */
function quotaWindows(quota: RouteQuota | undefined, scope: "ORG" | "USER_ACCOUNT", now: () => Date): CapacityWindow[] {
  const effective = effectiveQuota(quota, now);
  const windows: CapacityWindow[] = [];
  if (effective?.remainingRequests !== undefined || effective?.limitRequests !== undefined) {
    windows.push({ unit: "requests", limit: effective.limitRequests ?? effective.remainingRequests ?? 0, remaining: effective.remainingRequests ?? 0, resetAt: effective.requestResetAt ?? effective.resetAt ?? NO_RESET, scope, observedAt: effective.observedAt, authoritative: true });
  }
  if (effective?.remainingTokens !== undefined || effective?.limitTokens !== undefined) {
    windows.push({ unit: "input_tokens", limit: effective.limitTokens ?? effective.remainingTokens ?? 0, remaining: effective.remainingTokens ?? 0, resetAt: effective.tokenResetAt ?? effective.resetAt ?? NO_RESET, scope, observedAt: effective.observedAt, authoritative: true });
  }
  return windows;
}

/**
 * 8-Bit Free Cloud Service — the stateful owner of the free fleet on a CodeForge host.
 *
 * Holds provider connection state (from the trusted process), qualification receipts, shared
 * route health/quota observations, and exposes the registry snapshot plus routing hooks.
 * Discovery/verification remain in `discovery.ts` + ForgeZero; this service sequences them.
 */
export class FreeCloudService implements FreeCloudRoutingHooks {
  private readonly firewall: ForgeZero;
  private readonly providerCatalog: ProviderCatalog;
  private readonly registry: NormalizedModelRegistry;
  private definitions: Record<string, ProviderDefinition>;
  private qualificationStore: QualificationPersistence;
  private readonly receipts = new Map<string, ModelQualificationReceipt>();
  private readonly connections = new Map<string, ProviderConnectionState>();
  private readonly managedPools = new Map<string, ManagedPoolRecord>();
  /** Instant-disable set for ANY poolId (shared, per-user, managed). A quarantined pool's
   *  routes project `enabled: false` + `lifecycle: QUARANTINED` — ForgeZero denies them at
   *  admission on the next decision with no cache to flush. */
  private readonly poolQuarantines = new Map<string, { reason: string; at: string }>();
  private managedPoolStore: ManagedPoolPersistence = new InMemoryManagedPoolPersistence();
  private readonly health = new Map<string, RouteHealthEntry>();
  readonly quota = new RouteQuotaTracker();
  private readonly now: () => Date;
  private readonly maxQualificationsPerCycle: number;
  private readonly qualificationRunner: NonNullable<FreeCloudServiceOptions["qualificationRunner"]>;
  private readonly failureCooldownMs: number;
  private readonly qualificationDailyBudget: number;
  private readonly qualificationRequestsPerCycle: number;
  private readonly qualificationCycleIntervalMs: number;
  private readonly qualificationRecoveryCapPerDay: number;
  private readonly qualificationProviderConcurrency: number;
  private readonly qualificationSuiteDeadlineMs: number;
  private readonly capacityProbeTimeoutMs: number;
  private readonly probeMinIntervalMs: number;
  /**
   * Per-provider claim cursor for probe pacing. Stamping the NEXT slot at claim time (not at
   * fire time) keeps concurrent qualification lanes and capacity probes from double-spending
   * the same RPM window.
   */
  private readonly probeNextAllowedAt = new Map<string, number>();
  /** Qualification requests spent per provider, keyed by UTC day. */
  private readonly qualificationSpend = new Map<string, { day: string; requests: number; lastCycleAt: number; recoveries: number }>();
  /** R59: cooldown-aligned recovery retries — one armed timer per provider at most. */
  private readonly recoveryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; at: string }>();
  private qualifying = false;
  private listeners = new Set<() => void>();
  private routeHealth?: EightBitRouteHealthAuthority;

  constructor(options: FreeCloudServiceOptions) {
    this.firewall = options.firewall;
    this.providerCatalog = options.providerCatalog;
    this.registry = options.registry;
    this.definitions = options.definitions ?? PROVIDER_DEFINITIONS;
    this.qualificationStore = options.qualificationStore ?? new InMemoryQualificationPersistence();
    this.now = options.now ?? (() => new Date());
    this.maxQualificationsPerCycle = options.maxQualificationsPerCycle ?? 3;
    this.qualificationRunner = options.qualificationRunner ?? ((model, adapter, runOpts) => runRoleAwareQualification(model, adapter, { now: this.now, signal: runOpts?.signal }));
    this.failureCooldownMs = options.failureCooldownMs ?? 30_000;
    this.qualificationDailyBudget = options.qualificationDailyBudgetPerProvider ?? 24;
    this.qualificationRequestsPerCycle =
      options.qualificationRequestsPerCycle ?? (options.qualificationRunner ? COMPACT_SUITE_REQUESTS : ROLE_SUITE_REQUESTS);
    this.qualificationCycleIntervalMs = options.qualificationCycleIntervalMs ?? 20 * 60_000;
    this.qualificationRecoveryCapPerDay = options.qualificationRecoveryAttemptsPerProviderPerDay ?? 8;
    this.qualificationProviderConcurrency = Math.max(1, options.qualificationProviderConcurrency ?? 2);
    this.qualificationSuiteDeadlineMs = options.qualificationSuiteDeadlineMs ?? 360_000;
    this.capacityProbeTimeoutMs = options.capacityProbeTimeoutMs ?? 30_000;
    this.probeMinIntervalMs = options.probeMinIntervalMs ?? 1_200;
    this.routeHealth = options.routeHealth;
  }

  /** Attach (or replace) the shared route-health authority after construction — the desktop
   * host creates the service before the server that owns the authority. */
  setRouteHealth(authority: EightBitRouteHealthAuthority | undefined): void {
    this.routeHealth = authority;
  }

  getRouteHealth(): EightBitRouteHealthAuthority | undefined {
    return this.routeHealth;
  }

  invalidateReceipt(providerId: string, modelId: string): boolean {
    const key = `${providerId}::${modelId}`;
    const deleted = this.receipts.delete(key);
    if (deleted) this.emit();
    return deleted;
  }

  createCatalogRefresh(options?: Partial<RefreshOptions>): FreeModelCatalogRefresh {
    return createFreeModelCatalogRefresh({
      firewall: this.firewall,
      providerCatalog: this.providerCatalog,
      registry: this.registry,
      routeHealth: this.routeHealth,
      service: this,
      now: this.now,
      ...options,
    });
  }

  // --- definitions ---------------------------------------------------------------------------

  setDefinitions(definitions: Record<string, ProviderDefinition>): void {
    this.definitions = definitions;
    this.emit();
  }

  getDefinitions(): Record<string, ProviderDefinition> {
    return this.definitions;
  }

  // --- connections ---------------------------------------------------------------------------

  setConnection(state: ProviderConnectionState): void {
    this.connections.set(state.providerId, state);
    this.emit();
  }

  updateConnection(providerId: string, patch: Partial<ProviderConnectionState>): void {
    const existing = this.connections.get(providerId) ?? { providerId, connected: false, credentialSource: "NONE" as const, authState: "unknown" as const };
    this.connections.set(providerId, { ...existing, ...patch, providerId });
    this.emit();
  }

  getConnection(providerId: string): ProviderConnectionState | undefined {
    return this.connections.get(providerId);
  }

  connections_(): ProviderConnectionState[] {
    return [...this.connections.values()];
  }

  // --- managed pools (R34 Mission B) -----------------------------------------------------------
  //
  // A provider connection proves credentials exist; a managed pool is one server-owned upstream
  // account = one physical quota domain. The fabric projects one route per (model × managed
  // pool) so per-account windows never contend, and quota observations stamped with the
  // account that served them land on the right pool. This is also the only supported path for
  // declaring managed supply on a direct (non-gateway) provider: a server-held Mistral key is
  // `registerManagedPool("mistral", "ops-acct-1")`, not a phantom connection.

  attachManagedPoolStore(store: ManagedPoolPersistence): void {
    this.managedPoolStore = store;
  }

  async loadManagedPools(): Promise<number> {
    const all = await this.managedPoolStore.loadAll();
    for (const r of all) {
      if (!this.validManagedSupplyClass(r.supplyClass)) continue;
      this.managedPools.set(r.poolId, r);
      // A quarantine must survive restart — restoring the pool without restoring the block
      // would silently reopen disabled supply.
      if (r.state === "ACTIVE") this.poolQuarantines.delete(r.poolId);
      else this.poolQuarantines.set(r.poolId, { reason: r.reason ?? r.state, at: r.at });
    }
    this.emit();
    return this.managedPools.size;
  }

  private validManagedSupplyClass(supplyClass: SupplyClass | undefined): supplyClass is SupplyClass {
    // A managed pool is server-owned fleet capacity. Reject anything that would smuggle in a
    // paid route or hand the server-side pool to a single user — the class is set at
    // registration and re-vetted on restore so a corrupt store cannot widen it.
    return supplyClass !== undefined
      && supplyClassIsZeroCash(supplyClass)
      && supplyClass !== "USER_CONNECTED_FREE"
      && supplyClass !== "DISTRIBUTED_USER_FREE"
      && supplyClass !== "PAID";
  }

  registerManagedPool(
    providerId: string,
    accountId: string,
    opts: { supplyClass?: SupplyClass; state?: ManagedPoolState; reason?: string } = {},
  ): ManagedPoolRecord {
    if (!this.definitions[providerId]) throw new Error(`managed pool for unknown provider: ${providerId}`);
    if (!accountId) throw new Error("managed pool requires an accountId");
    const supplyClass = opts.supplyClass ?? "PURE_MANAGED_FREE";
    if (!this.validManagedSupplyClass(supplyClass)) throw new Error(`supply class ${supplyClass} cannot own a managed pool`);
    const record: ManagedPoolRecord = {
      poolId: `managed:${providerId}:${accountId}`,
      providerId,
      accountId,
      supplyClass,
      state: opts.state ?? "ACTIVE",
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      at: this.now().toISOString(),
    };
    this.managedPools.set(record.poolId, record);
    if (record.state === "ACTIVE") this.poolQuarantines.delete(record.poolId);
    else this.poolQuarantines.set(record.poolId, { reason: record.reason ?? record.state, at: record.at });
    void this.managedPoolStore.save(record);
    this.emit();
    return record;
  }

  /** Flip a managed pool's lifecycle. QUARANTINED/DISABLED deny admission immediately —
   *  the route projection reads this map synchronously on the next decision. */
  setManagedPoolState(poolId: string, state: ManagedPoolState, reason?: string): ManagedPoolRecord | undefined {
    const record = this.managedPools.get(poolId);
    if (!record) return undefined;
    const next: ManagedPoolRecord = { ...record, state, at: this.now().toISOString(), ...(reason !== undefined ? { reason } : {}) };
    this.managedPools.set(poolId, next);
    if (state === "ACTIVE") this.poolQuarantines.delete(poolId);
    else this.poolQuarantines.set(poolId, { reason: reason ?? state, at: next.at });
    void this.managedPoolStore.save(next);
    this.emit();
    return next;
  }

  removeManagedPool(poolId: string): boolean {
    const deleted = this.managedPools.delete(poolId);
    this.poolQuarantines.delete(poolId);
    if (deleted) {
      void this.managedPoolStore.delete(poolId);
      this.emit();
    }
    return deleted;
  }

  managedPoolsFor(providerId?: string): ManagedPoolRecord[] {
    const all = [...this.managedPools.values()];
    return providerId === undefined ? all : all.filter((p) => p.providerId === providerId);
  }

  /** Instant disable for a poolId the managed registry does not own (shared:, per-user). */
  quarantinePool(poolId: string, reason: string): void {
    if (this.managedPools.has(poolId)) {
      this.setManagedPoolState(poolId, "QUARANTINED", reason);
      return;
    }
    this.poolQuarantines.set(poolId, { reason, at: this.now().toISOString() });
    this.emit();
  }

  releasePoolQuarantine(poolId: string): boolean {
    if (this.managedPools.has(poolId)) {
      return this.setManagedPoolState(poolId, "ACTIVE") !== undefined;
    }
    const released = this.poolQuarantines.delete(poolId);
    if (released) this.emit();
    return released;
  }

  poolQuarantineOf(poolId: string): { reason: string; at: string } | undefined {
    return this.quarantineFor(poolId);
  }

  /** Pool ids are `:`-delimited hierarchies: quarantining `managed:p:acct` must also deny the
   *  sharded `managed:p:acct:model:m` pools — the whole account is the physical domain. */
  private quarantineFor(poolId: string): { reason: string; at: string } | undefined {
    const exact = this.poolQuarantines.get(poolId);
    if (exact) return exact;
    for (const [qid, entry] of this.poolQuarantines) {
      if (poolId.startsWith(`${qid}:`)) return entry;
    }
    return undefined;
  }

  // --- qualification -------------------------------------------------------------------------

  attachQualificationStore(store: QualificationPersistence): void {
    this.qualificationStore = store;
  }

  async loadQualification(): Promise<number> {
    const all = await this.qualificationStore.loadAll();
    for (const r of all) {
      this.receipts.set(`${r.providerId}::${r.modelId}`, r);
      this.applyReceiptToFirewall(r);
    }
    this.emit();
    return all.length;
  }

  /**
   * Qualification evidence becomes ranking input: ForgeRouter already weighs `agentScore`,
   * `toolReliability` and `empiricalStatus`, so a QUALIFIED route outranks a PROBATION one for
   * the same task without a second ranking system. Scores derive only from CodeForge probes.
   */
  applyReceiptToFirewall(receipt: ModelQualificationReceipt): void {
    const model = this.firewall.getModel(receipt.providerId, receipt.modelId);
    if (!model) return;
    const cases = Object.values(receipt.roleResults).flatMap((r) => r.testCases);
    const toolCases = cases.filter((c) => c.category === "tool_call" || c.category === "edit");
    const toolReliability = toolCases.length > 0 ? toolCases.filter((c) => c.passed).length / toolCases.length : undefined;
    const agentScore = receipt.qualificationState === "QUALIFIED" ? 90 : receipt.qualificationState === "PROBATION" ? 60 : 20;
    const empiricalStatus: FreeModelRecord["empiricalStatus"] =
      receipt.qualificationState === "QUALIFIED" ? "passing" : receipt.qualificationState === "PROBATION" ? "degraded" : "failing";
    this.firewall.register({ ...model, agentScore, toolReliability, empiricalStatus });
  }

  getReceipt(providerId: string, modelId: string): ModelQualificationReceipt | undefined {
    return this.receipts.get(`${providerId}::${modelId}`);
  }

  /** R41 routing-hook surface: the same persisted receipt, exposed for role-quality advice. */
  getQualificationReceipt(providerId: string, modelId: string): ModelQualificationReceipt | undefined {
    return this.getReceipt(providerId, modelId);
  }

  /** Current, independent runtime failures can reopen a still-fresh role receipt. */
  runtimeRequalificationRoles(providerId: string, modelId: string): string[] {
    const receipt = this.getReceipt(providerId, modelId);
    if (!receipt || !this.routeHealth) return [];
    const qualifiedAt = Date.parse(receipt.completedAt);
    if (!Number.isFinite(qualifiedAt)) return [];
    return Object.entries(receipt.roleResults)
      .filter(([, result]) => result.status === "QUALIFIED" || result.status === "PROBATION")
      .filter(([role]) => {
        const samples = this.routeHealth!.roleEvidenceFor(providerId, modelId, role as EightBitRole);
        const recentFailures = samples.filter((sample) => sample.at > qualifiedAt && sample.weight < 0);
        const distinctRuns = new Set(recentFailures.map((sample) => sample.correlationId).filter(Boolean));
        return distinctRuns.size >= 3 && this.routeHealth!.roleQualityDelta(providerId, modelId, role as EightBitRole).netEvidence <= -1.5;
      })
      .map(([role]) => role);
  }

  /** Test/certification seam: record an externally produced receipt. */
  async recordReceipt(receipt: ModelQualificationReceipt): Promise<void> {
    this.receipts.set(`${receipt.providerId}::${receipt.modelId}`, receipt);
    await this.qualificationStore.save(receipt);
    this.emit();
  }

  /**
   * Routes that are verified free, connected, tool-capable and not yet qualified — the
   * candidates 8-Bit still has to test before ForgeAuto may use them. Ordered so that a
   * canonical model with the most alternate routes (best failover value) is tested first.
   */
  pendingQualification(): ProviderRouteView[] {
    const snap = this.snapshot();
    const routeCountByModel = new Map<string, number>();
    const familyByModel = new Map<string, string>();
    for (const m of snap.models) {
      routeCountByModel.set(m.canonicalId, m.freeRouteCount);
      familyByModel.set(m.canonicalId, m.family);
    }
    const score = (r: ProviderRouteView): number =>
      (FAMILY_PRIOR[familyByModel.get(r.canonicalModelId) ?? ""] ?? 0) * 100 +
      (routeCountByModel.get(r.canonicalModelId) ?? 0) * 10 +
      Math.min(9, Math.round((r.contextWindow ?? 0) / 100_000));
    // A route whose last probe failed transiently (upstream 429/5xx → DEGRADED after its cooldown)
    // is tested after the never-tested ones: re-probing the same rate-limited upstream first in
    // every cycle starved untested candidates of the bounded per-cycle slots (observed in R5).
    // Distinct current role failures take priority: this route is still serving tasks under an
    // old qualification, so delaying requalification behind unrelated discovery would retain
    // the known mismatch. Capacity failures never create this priority.
    const penalty = (r: ProviderRouteView): number => (r.health === "DEGRADED" ? 1 : 0);
    const urgentRoleFailure = (r: ProviderRouteView): number => this.runtimeRequalificationRoles(r.providerId, r.providerModelId).length > 0 ? 1 : 0;
    const seen = new Set<string>();
    return snap.models
      .flatMap((m) => m.routes)
      .filter((r) => {
        const ordinaryPending = r.admission.failedGate === "CODEFORGE_QUALIFIED" && (r.qualificationState === "NOT_TESTED" || r.qualificationState === "STALE");
        const degradedRole = r.supplyClass !== undefined && supplyClassIsZeroCash(r.supplyClass) && r.verifiedFree && r.connected && r.toolSupport
          && r.privacyClass !== "permissive" && r.termsStatus === "CLEARED"
          && this.runtimeRequalificationRoles(r.providerId, r.providerModelId).length > 0;
        return ordinaryPending || degradedRole;
      })
      .filter((r) => r.health !== "COOLDOWN" && r.health !== "QUOTA_EXHAUSTED" && r.health !== "AUTH_REQUIRED")
      .filter((r) => {
        const key = `${r.providerId}::${r.providerModelId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => urgentRoleFailure(b) - urgentRoleFailure(a) || penalty(a) - penalty(b) || score(b) - score(a));
  }

  /**
   * R59: spacing between provider-bound probe requests. Free tiers rate-limit per minute
   * (Groq free plan 30 RPM, OpenRouter `:free` 20 RPM); an unpaced qualification suite bursts
   * ~25 requests in ~20s and trips its own 429 mid-measurement — daily budget spent, verdict
   * never landed. Declared `maxRequestsPerMinute` wins (+100ms margin); undeclared providers
   * get the conservative floor. Pacing spaces requests — it never changes their count.
   */
  private probeIntervalMs(providerId: string): number {
    const declared = this.definitions[providerId]?.freeAccess?.maxRequestsPerMinute;
    return typeof declared === "number" && declared > 0 ? Math.ceil(60_000 / declared) + 100 : this.probeMinIntervalMs;
  }

  /**
   * Claim the next request slot for `providerId` and wait for it. The slot is stamped at claim
   * time so concurrent callers (qualification lanes, capacity probes) serialize against one
   * shared RPM window instead of each starting their own. An aborted wait rejects with a
   * timeout-classified message — callers observe it as transient, never as a verdict.
   */
  private probePace(providerId: string, signal?: AbortSignal): Promise<void> {
    const nowMs = Date.now();
    const slot = Math.max(this.probeNextAllowedAt.get(providerId) ?? 0, nowMs);
    this.probeNextAllowedAt.set(providerId, slot + this.probeIntervalMs(providerId));
    const wait = slot - nowMs;
    if (signal?.aborted) return Promise.reject(new Error("probe pace wait aborted (timed out)"));
    if (wait <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("probe pace wait aborted (timed out)"));
      }, { once: true });
    });
  }

  private async *pacedStream(providerId: string, open: () => AsyncIterable<StreamEvent>, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    await this.probePace(providerId, signal);
    yield* open();
  }

  /**
   * Pace every provider-bound request an adapter can make inside a measurement path. Test
   * providers are exempt — they bypass the global capacity governor for the same reason:
   * a scripted adapter has no real rate limit to spend.
   */
  private paceProviderAdapter(adapter: ProviderAdapter): ProviderAdapter {
    if (adapter.isTestProvider === true) return adapter;
    const providerId = adapter.providerId;
    return {
      providerId,
      ...(adapter.isTestProvider !== undefined ? { isTestProvider: adapter.isTestProvider } : {}),
      ...(adapter.supportsDispatchIdentity !== undefined ? { supportsDispatchIdentity: adapter.supportsDispatchIdentity } : {}),
      listModels: () => adapter.listModels(),
      healthCheck: () => adapter.healthCheck(),
      chat: async (req: ChatRequest) => {
        await this.probePace(providerId);
        return adapter.chat(req);
      },
      streamChat: (req: ChatRequest, signal?: AbortSignal) => this.pacedStream(providerId, () => adapter.streamChat(req, signal), signal),
      ...(adapter.streamChatWithContext !== undefined ? {
        streamChatWithContext: (req: ChatRequest, context: ProviderExecutionContext, signal?: AbortSignal) =>
          this.pacedStream(providerId, () => adapter.streamChatWithContext!(req, context, signal), signal),
      } : {}),
      ...(adapter.canRoute !== undefined ? { canRoute: (modelId: string) => adapter.canRoute!(modelId) } : {}),
      ...(adapter.getPromptCacheCapability !== undefined ? { getPromptCacheCapability: (modelId: string) => adapter.getPromptCacheCapability!(modelId) } : {}),
      ...(adapter.probeAccountQuota !== undefined ? {
        probeAccountQuota: async () => {
          await this.probePace(providerId);
          return adapter.probeAccountQuota!();
        },
      } : {}),
    };
  }

  private spendFor(providerId: string): { day: string; requests: number; lastCycleAt: number; recoveries: number } {
    const day = this.now().toISOString().slice(0, 10);
    const entry = this.qualificationSpend.get(providerId);
    if (!entry || entry.day !== day) {
      const fresh = { day, requests: 0, lastCycleAt: 0, recoveries: 0 };
      this.qualificationSpend.set(providerId, fresh);
      return fresh;
    }
    return entry;
  }

  /** True when this provider may run another qualification cycle now (budget + interval). */
  qualificationAllowed(providerId: string, requests = this.qualificationRequestsPerCycle): boolean {
    const spend = this.spendFor(providerId);
    if (spend.requests + requests > this.qualificationDailyBudget) return false;
    return this.now().getTime() - spend.lastCycleAt >= this.qualificationCycleIntervalMs;
  }

  /**
   * Run the compact qualification suite for pending routes, bounded per cycle. Idempotent under
   * concurrency (a second caller while a cycle runs returns immediately).
   *
   * R59 `recovery`: skips the inter-cycle interval — the provider-stated cooldown that just
   * elapsed IS the cadence evidence — but never the daily budget or the bounded per-day
   * recovery count. A cycle that observed only transient failures schedules its own recovery
   * at the earliest cooldown expiry, so a rate-limited route returns to measurement without
   * waiting for a restart or a manual refresh.
   */
  async qualifyPending(opts: { budget?: number; providerId?: string; recovery?: boolean } = {}): Promise<ModelQualificationReceipt[]> {
    if (this.qualifying) return [];
    this.qualifying = true;
    const produced: ModelQualificationReceipt[] = [];
    const transientCooldowns = new Map<string, number>();
    try {
      const budget = opts.budget ?? this.maxQualificationsPerCycle;
      const pending = this.pendingQualification().filter((r) => !opts.providerId || r.providerId === opts.providerId);
      // R59: provider lanes run concurrently — provider quotas are independent, so one
      // saturated upstream's slow suite must not serialize another provider's pending routes
      // behind it. The per-cycle slot budget is claimed before the suite awaits, so concurrent
      // lanes still cannot overspend it. Routes within a provider stay serial: they share that
      // provider's daily qualification budget.
      const lanes = new Map<string, typeof pending>();
      for (const route of pending) {
        const lane = lanes.get(route.providerId);
        if (lane) lane.push(route);
        else lanes.set(route.providerId, [route]);
      }
      const ctx = { budget, taken: 0, inflight: 0, recovery: opts.recovery === true, produced, transientCooldowns };
      const queue = [...lanes.values()];
      const workers = Array.from({ length: Math.min(this.qualificationProviderConcurrency, queue.length) }, async () => {
        let lane: typeof pending | undefined;
        while ((lane = queue.shift()) !== undefined) await this.qualifyLane(lane, ctx);
      });
      await Promise.all(workers);
    } finally {
      this.qualifying = false;
    }
    // R59: transient-only evidence schedules its own retry at the provider's cooldown expiry.
    // A permanently saturated upstream hits the recovery cap and stops; a recovered route
    // becomes pending again and is measured without anyone refreshing by hand.
    for (const [providerId, until] of transientCooldowns) {
      this.scheduleQualificationRecovery(providerId, until);
    }
    return produced;
  }

  /**
   * One provider's serial qualification lane inside a cycle. Shares the cycle's slot budget
   * through `ctx`: a slot is claimed before the suite awaits (`inflight`) and released on a
   * transient outcome, so the global cap matches the serial loop exactly.
   */
  private async qualifyLane(
    routes: readonly ProviderRouteView[],
    ctx: {
      budget: number;
      taken: number;
      inflight: number;
      recovery: boolean;
      produced: ModelQualificationReceipt[];
      transientCooldowns: Map<string, number>;
    },
  ): Promise<void> {
    const providerId = routes[0]?.providerId;
    if (providerId === undefined) return;
    let providerStarted = false;
    for (const route of routes) {
      if (ctx.taken + ctx.inflight >= ctx.budget) break;
      // Shared free quota: never spend more than the daily qualification budget on a provider,
      // and never re-enter a provider's cycle before the interval elapsed (§195). Recovery
      // cycles substitute the cooldown-expiry evidence for the interval.
      if (!providerStarted) {
        const allowed = ctx.recovery ? this.recoveryAllowed(providerId) : this.qualificationAllowed(providerId);
        if (!allowed) continue;
      }
      const model = this.firewall.getModel(route.providerId, route.providerModelId);
      const adapter = this.providerCatalog.get(route.providerId);
      if (!model || !adapter) continue;
      const spend = this.spendFor(providerId);
      // Conservative pre-check at the runner's declared cycle cost; the spend is
      // reconciled to the receipt's real request count after the run.
      if (spend.requests + this.qualificationRequestsPerCycle > this.qualificationDailyBudget) continue;
      providerStarted = true;
      spend.lastCycleAt = this.now().getTime();
      if (ctx.recovery) spend.recoveries += 1;
      spend.requests += this.qualificationRequestsPerCycle;
      ctx.inflight++;
      const suiteDeadline = new AbortController();
      const deadlineTimer = setTimeout(() => suiteDeadline.abort(), this.qualificationSuiteDeadlineMs);
      try {
        const receipt = await this.qualificationRunner(model, this.paceProviderAdapter(adapter), { signal: suiteDeadline.signal });
        if (typeof receipt.metadata?.requests === "number") {
          spend.requests += receipt.metadata.requests - this.qualificationRequestsPerCycle;
        }
        // A transient (429/401/timeout) probe is not evidence about the model; keep it pending.
        // It still counts against the provider's daily spend (conservative), but not against the
        // per-cycle slots, so the lane moves on to a route that can actually be scored.
        if (receipt.metadata?.transient === true) {
          this.recordRouteFailure(route.providerId, route.providerModelId, "RATE_LIMITED");
          const coolingUntil = this.health.get(`${route.providerId}::${route.providerModelId}`)?.cooldownUntil;
          if (coolingUntil !== undefined) {
            const prior = ctx.transientCooldowns.get(providerId);
            ctx.transientCooldowns.set(providerId, prior === undefined ? coolingUntil : Math.min(prior, coolingUntil));
          }
          continue;
        }
        ctx.taken++;
        this.receipts.set(`${receipt.providerId}::${receipt.modelId}`, receipt);
        await this.qualificationStore.save(receipt).catch(() => undefined);
        this.applyReceiptToFirewall(receipt);
        ctx.produced.push(receipt);
        this.emit();
      } catch {
        // Qualification must never take the fleet down; an exception is still a spent slot.
        ctx.taken++;
      } finally {
        clearTimeout(deadlineTimer);
        ctx.inflight--;
      }
    }
  }

  /**
   * Recovery cycles bypass the cadence interval — cooldown expiry is the evidence — but never
   * the daily request budget or the per-day recovery allowance.
   */
  private recoveryAllowed(providerId: string): boolean {
    const spend = this.spendFor(providerId);
    if (spend.recoveries >= this.qualificationRecoveryCapPerDay) return false;
    return spend.requests + this.qualificationRequestsPerCycle <= this.qualificationDailyBudget;
  }

  /**
   * Arm one recovery retry for a provider at the earliest transient cooldown expiry. At most
   * one timer per provider: later evidence reschedules only when it recovers sooner.
   */
  private scheduleQualificationRecovery(providerId: string, cooldownUntil: number): void {
    const now = this.now().getTime();
    const fireAt = Math.max(now, Math.min(cooldownUntil, now + SHARED_MAX_COOLDOWN_MS)) + 250;
    const existing = this.recoveryTimers.get(providerId);
    if (existing && Date.parse(existing.at) <= fireAt) return;
    if (existing) clearTimeout(existing.timer);
    const fireAtIso = new Date(fireAt).toISOString();
    const arm = (delay: number): void => {
      const timer = setTimeout(() => {
        this.recoveryTimers.delete(providerId);
        // A cycle already in flight no-ops a second qualifyPending — dropping the fire here
        // would strand the cooled-down route behind the next interval-gated tick. Re-arm
        // briefly inside the cooldown window; beyond it the periodic rediscovery is the
        // backstop and re-spamming a saturated upstream is not recovery.
        if (this.qualifying && this.now().getTime() < fireAt + RECOVERY_DEFER_WINDOW_MS) {
          arm(RECOVERY_DEFER_RETRY_MS);
          return;
        }
        void this.qualifyPending({ providerId, recovery: true }).catch(() => undefined);
      }, Math.max(0, delay));
      timer.unref?.();
      this.recoveryTimers.set(providerId, { timer, at: fireAtIso });
    };
    arm(fireAt - now);
  }

  isQualifying(): boolean {
    return this.qualifying;
  }

  /**
   * R59 diagnostic surface: per-provider qualification posture — pending count, today's spend,
   * cycle cadence, and any armed cooldown-aligned recovery — so "why is nothing qualified yet"
   * is answerable from data, not inference.
   */
  qualificationSummary(): Array<{
    providerId: string;
    pending: number;
    qualifying: boolean;
    requestsSpentToday: number;
    dailyBudget: number;
    liveEvidence: boolean;
    lastCycleAt?: string;
    cycleIntervalMs: number;
    recoveryAttemptsToday: number;
    recoveryScheduledAt?: string;
  }> {
    const day = this.now().toISOString().slice(0, 10);
    const nowMs = this.now().getTime();
    const pendingByProvider = new Map<string, number>();
    for (const r of this.pendingQualification()) {
      pendingByProvider.set(r.providerId, (pendingByProvider.get(r.providerId) ?? 0) + 1);
    }
    const providerIds = new Set<string>([
      ...this.connections.keys(),
      ...this.qualificationSpend.keys(),
      ...pendingByProvider.keys(),
    ]);
    return [...providerIds].map((providerId) => {
      const raw = this.qualificationSpend.get(providerId);
      const spend = raw?.day === day ? raw : undefined;
      const recovery = this.recoveryTimers.get(providerId);
      const pending = pendingByProvider.get(providerId) ?? 0;
      const requestsSpentToday = spend?.requests ?? 0;
      const recoveryAttemptsToday = spend?.recoveries ?? 0;
      const canSpend = requestsSpentToday + this.qualificationRequestsPerCycle <= this.qualificationDailyBudget;
      const recoveryCapLeft = recoveryAttemptsToday < this.qualificationRecoveryCapPerDay;
      const intervalElapsed = !spend || spend.lastCycleAt === 0 || nowMs - spend.lastCycleAt >= this.qualificationCycleIntervalMs;
      // A denial is only honest once no lane can still produce a verdict inside the caller's
      // recovery window. Pending routes are reachable now only through a recovery kick (cap +
      // budget) or a due normal cycle. Cooled routes hide from `pending` until their armed
      // retry fires and they re-enter it, so an armed timer with headroom left is live
      // evidence-in-waiting — treating it as dead denied runs minutes before the retry.
      const liveEvidence = canSpend && (
        (pending > 0 && (recoveryCapLeft || intervalElapsed))
        || (recovery !== undefined && recoveryCapLeft)
      );
      return {
        providerId,
        pending,
        qualifying: this.qualifying,
        requestsSpentToday,
        dailyBudget: this.qualificationDailyBudget,
        liveEvidence,
        ...(spend !== undefined && spend.lastCycleAt > 0 ? { lastCycleAt: new Date(spend.lastCycleAt).toISOString() } : {}),
        cycleIntervalMs: this.qualificationCycleIntervalMs,
        recoveryAttemptsToday,
        ...(recovery !== undefined ? { recoveryScheduledAt: recovery.at } : {}),
      };
    }).sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  // --- health / quota ------------------------------------------------------------------------

  private routeHealthLookup = (providerId: string, modelId: string): { status: RouteHealth; cooldownUntil?: number } | undefined => {
    if (this.routeHealth) {
      const assessment = this.routeHealth.assess(providerId, modelId, { now: this.now().getTime() });
      if (assessment.state !== "UNKNOWN") {
        let status: RouteHealth;
        let cooldownUntil: number | undefined = assessment.expiresAt;
        switch (assessment.state) {
          case "HEALTHY":
            status = "HEALTHY";
            break;
          case "DEGRADED":
          case "TOOL_UNRELIABLE":
          case "CAPABILITY_LIMITED":
            status = "DEGRADED";
            break;
          case "SATURATED":
          case "RATE_LIMITED":
          case "TEMPORARY_CAPACITY":
            status = "COOLDOWN";
            break;
          case "DAILY_QUOTA_EXHAUSTED":
            status = "QUOTA_EXHAUSTED";
            break;
          case "AUTH_REQUIRED":
          case "USER_CONNECTION_REQUIRED":
            status = "AUTH_REQUIRED";
            break;
          case "MODEL_RETIRED":
          case "ACCESS_RESTRICTED":
            status = "UNAVAILABLE";
            break;
          case "BILLING_VERIFICATION_REQUIRED":
          case "QUARANTINED":
            status = "INELIGIBLE";
            break;
          default:
            status = "UNKNOWN";
            break;
        }
        return { status, cooldownUntil };
      }
    }
    const entry = this.health.get(`${providerId}::${modelId}`);
    if (!entry) return undefined;
    if (entry.cooldownUntil !== undefined && entry.cooldownUntil > this.now().getTime()) {
      return { status: "COOLDOWN", cooldownUntil: entry.cooldownUntil };
    }
    if (entry.status === "COOLDOWN") return { status: entry.consecutiveFailures > 0 ? "DEGRADED" : "HEALTHY" };
    return { status: entry.status, cooldownUntil: entry.cooldownUntil };
  };

  recordRouteFailure(providerId: string, modelId: string, reason: string, retryAfterMs?: number): void {
    const key = `${providerId}::${modelId}`;
    const prev = this.health.get(key);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    const nowMs = this.now().getTime();
    const upper = reason.toUpperCase();
    let status: RouteHealth = "DEGRADED";
    let cooldownUntil: number | undefined;
    if (/RATE|QUOTA|OUTAGE|TIMEOUT|CAPACITY/.test(upper)) {
      status = /QUOTA/.test(upper) ? "QUOTA_EXHAUSTED" : "COOLDOWN";
      const backoff = Math.min(SHARED_MAX_COOLDOWN_MS, this.failureCooldownMs * 2 ** Math.min(5, failures - 1));
      cooldownUntil = nowMs + Math.max(retryAfterMs ?? 0, backoff);
      if (status === "QUOTA_EXHAUSTED") cooldownUntil = nowMs + Math.max(retryAfterMs ?? 0, SHARED_MAX_COOLDOWN_MS);
    } else if (/AUTH/.test(upper)) {
      status = "AUTH_REQUIRED";
    } else if (/NOT_FOUND|RETIRED|ELIGIBILITY|PAID_PLAN|FREE_TIER/.test(upper)) {
      status = "UNAVAILABLE";
    }
    this.health.set(key, { status, cooldownUntil, consecutiveFailures: failures, lastReason: reason, lastFailureAt: new Date(nowMs).toISOString(), lastSuccessAt: prev?.lastSuccessAt });
    this.emit();
  }

  recordRouteSuccess(providerId: string, modelId: string): void {
    const key = `${providerId}::${modelId}`;
    this.health.set(key, { status: "HEALTHY", consecutiveFailures: 0, lastSuccessAt: this.now().toISOString() });
    this.emit();
  }

  /** R47 §14: managed-capacity evidence that arrived stamped with no account — or an account
   *  no registered pool owns — cannot feed a managed quota domain. Tracked as safe diagnostic
   *  metadata (counts, timestamps, model ids) so a missing stamp is visible instead of silent. */
  private readonly unattributedManagedEvidence = new Map<string, { count: number; lastAt: string; lastModelId?: string }>();

  /** Diagnostic surface: per-provider counts of response observations that managed pools could
   *  not attribute to a declared quota domain. Empty = every managed-bound observation landed. */
  capacityEvidenceGaps(): Array<{ providerId: string; count: number; lastAt: string; lastModelId?: string }> {
    return [...this.unattributedManagedEvidence.entries()].map(([providerId, g]) => ({ providerId, ...g }));
  }

  /**
   * R47 §13 — the managed-account stamping contract as an API, not host glue. Returns the
   * observer a managed adapter must emit through; throws when `managed:<provider>:<account>`
   * is not registered, so an adapter can never carry an undeclared quota identity.
   */
  managedAccountObserver(providerId: string, accountId: string): ProviderResponseObserver {
    if (!this.managedPools.has(`managed:${providerId}:${accountId}`)) {
      throw new Error(`no managed pool registered for ${providerId} account "${accountId}"`);
    }
    return (obs) => this.onProviderResponse({ ...obs, accountId });
  }

  /** Provider response observer for adapters (quota headers + 429 cooldown). */
  readonly onProviderResponse = (obs: ProviderResponseObservation): void => {
    const quota = parseRouteQuota(obs.headers, this.now);
    this.quota.record(obs.providerId, obs.modelId, quota, obs.accountId);
    // R47 §14: unattributed evidence on a managed provider is flagged, never inherited. The
    // observation still records to its own (unscoped or stranger) bucket — owner paths may
    // legitimately read unscoped evidence — but managed queries no longer see it.
    let managed = false;
    let attributed = false;
    for (const mp of this.managedPools.values()) {
      if (mp.providerId !== obs.providerId) continue;
      managed = true;
      if (obs.accountId !== undefined && mp.accountId === obs.accountId) attributed = true;
    }
    if (managed && !attributed) {
      const gap = this.unattributedManagedEvidence.get(obs.providerId) ?? { count: 0, lastAt: "" };
      gap.count++;
      gap.lastAt = new Date(obs.observedAt).toISOString();
      if (obs.modelId !== undefined) gap.lastModelId = obs.modelId;
      this.unattributedManagedEvidence.set(obs.providerId, gap);
    }
    // R24: the same header stream is the authority's quota evidence. One observation enters
    // once — no re-parsed copy (§16-17 provenance). Provider-scoped responses (no modelId) have
    // no route to attribute to; the authority keys conditions per route.
    if (this.routeHealth && obs.modelId) {
      const observation = rateLimitObservationFromHeaders({
        providerId: obs.providerId,
        modelId: obs.modelId,
        status: obs.status,
        headers: obs.headers,
        observedAt: obs.observedAt,
        source: "registry",
      });
      if (observation) this.routeHealth.observe(observation);
    }
    if (obs.status === 429 && obs.modelId) {
      // Providers commonly omit Retry-After but expose an absolute X-RateLimit-Reset value.
      // The reset is equally authoritative; discarding it caused R12 to retry an OpenRouter
      // route after a short synthetic cooldown even though its daily free allowance was gone.
      this.recordRouteFailure(obs.providerId, obs.modelId, "RATE_LIMITED", retryDelayMs(quota?.retryAfterMs, exhaustedQuotaResetAt(quota), this.now()));
    } else if (obs.status === 402 && obs.modelId) {
      this.recordRouteFailure(obs.providerId, obs.modelId, "PAID_PLAN_REQUIRED");
    }
  };

  quotaRemaining(providerId: string, modelId: string): number | undefined {
    return effectiveQuota(this.quota.get(providerId, modelId), this.now)?.remainingRequests;
  }

  /** Last on-demand capacity-measurement attempt per quota domain — bounds probe rate. */
  private readonly capacityProbeAt = new Map<string, number>();
  /** In-flight measurement per quota domain — concurrent demand coalesces onto one probe. */
  private readonly capacityProbeInFlight = new Map<string, Promise<boolean>>();

  /** True when this route's quota domain already has an observation worth admitting on. */
  private routeCapacityObserved(providerId: string, modelId: string | undefined, accountId?: string): boolean {
    if (modelId !== undefined && this.quota.get(providerId, modelId, accountId) !== undefined) return true;
    if (this.quota.hasProviderScoped(providerId, accountId)) return true;
    // A managed-account probe stamps evidence under its account; the unscoped read misses it.
    if (accountId === undefined) {
      return this.managedPoolsFor(providerId).some(
        (mp) => this.quota.hasProviderScoped(providerId, mp.accountId)
          || (modelId !== undefined && this.quota.get(providerId, modelId, mp.accountId) !== undefined),
      );
    }
    return false;
  }

  /**
   * R51: measure a quota domain on demand. An unmeasured route denies admission as
   * CAPACITY_UNMEASURED and can never self-measure (admission is what generates header
   * evidence), so the runtime calls this when a denial rests on unmeasured candidates.
   * Metadata quota endpoints (e.g. OpenRouter /key) are preferred — zero inference spend;
   * otherwise one bounded `maxTokens:1` ping, whose rate-limit headers land through the
   * adapter's wired onResponse observer even when the call itself 429s. Returns whether an
   * observation now exists — a failed probe leaves nothing behind except its cooldown.
   */
  async probeRouteCapacity(providerId: string, modelId?: string, opts: { capacityPoolId?: string } = {}): Promise<boolean> {
    // A managed account id is resolved through the pool table, not string-splitting: model-domain
    // pools append `:model:<id>` and account ids are the authoritative segment in between.
    const accountId = opts.capacityPoolId === undefined
      ? undefined
      : this.managedPoolsFor(providerId).find(
          (mp) => opts.capacityPoolId === mp.poolId || opts.capacityPoolId!.startsWith(`${mp.poolId}:`),
        )?.accountId;
    const key = `${providerId}::${accountId ?? "-"}::${modelId ?? "*"}`;
    // R52: concurrent demand for the same unmeasured domain coalesces onto the in-flight
    // probe — N simultaneous turns measure it once, never N times.
    const inFlight = this.capacityProbeInFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const nowMs = this.now().getTime();
    const last = this.capacityProbeAt.get(key);
    if (last !== undefined && nowMs - last < 60_000) {
      return this.routeCapacityObserved(providerId, modelId, accountId);
    }
    this.capacityProbeAt.set(key, nowMs);
    if (this.routeCapacityObserved(providerId, modelId, accountId)) return true;
    const adapter = this.providerCatalog.get(providerId);
    if (!adapter) return false;
    // Adapter calls carry no timeout of their own; a stalled connection must not hold an
    // admission recovery wait indefinitely. The race bounds the measurement; the underlying
    // request still completes in the background and records its quota headers. Calls run
    // through the probe pacer so a measurement burst cannot trip the provider's RPM cap.
    const pacedAdapter = this.paceProviderAdapter(adapter);
    const bound = <T>(call: Promise<T>): Promise<T> =>
      Promise.race([
        call,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("capacity probe timed out")), this.capacityProbeTimeoutMs)),
      ]);
    const probe = (async (): Promise<boolean> => {
      try {
        if (typeof pacedAdapter.probeAccountQuota === "function" && await bound(pacedAdapter.probeAccountQuota())) {
          return true;
        }
      } catch {
        // A metadata probe that throws leaves no evidence; fall through to the inference ping.
      }
      if (modelId === undefined) return this.routeCapacityObserved(providerId, modelId, accountId);
      try {
        await bound(pacedAdapter.chat({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 1,
        } as import("@codeforge/providers").ChatRequest));
      } catch {
        // A 429 still recorded its quota headers through onResponse — measured is measured.
      }
      return this.routeCapacityObserved(providerId, modelId, accountId);
    })();
    this.capacityProbeInFlight.set(key, probe);
    try {
      return await probe;
    } finally {
      this.capacityProbeInFlight.delete(key);
    }
  }

  capacityRoutingAdvice(providerId: string, modelId: string): { scoreAdjustment: number; reasonCodes: string[] } {
    const quota = effectiveQuota(this.quota.get(providerId, modelId), this.now);
    if (!quota) return { scoreAdjustment: 0, reasonCodes: ["CAPACITY_UNOBSERVED"] };

    const reasons: string[] = [];
    let scoreAdjustment = 0;
    // Exhaustion is per-dimension and recovery needs every exhausted window — the LATEST reset
    // among zero-remaining dimensions, not the aggregate's earliest.
    const exhaustedReset = exhaustedQuotaResetAt(quota);
    const resetAt = exhaustedReset === undefined ? Number.NaN : Date.parse(exhaustedReset);
    const resetsInFuture = Number.isFinite(resetAt) && resetAt > this.now().getTime();
    if (resetsInFuture) {
      return { scoreAdjustment: -100, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] };
    }
    if (quota.remainingRequests !== undefined && quota.limitRequests !== undefined && quota.limitRequests > 0) {
      const remainingRatio = quota.remainingRequests / quota.limitRequests;
      if (remainingRatio <= 0.1) {
        scoreAdjustment -= 30;
        reasons.push("LOW_REQUEST_CAPACITY_CRITICAL");
      } else if (remainingRatio <= 0.25) {
        scoreAdjustment -= 15;
        reasons.push("LOW_REQUEST_CAPACITY");
      }
    } else if (quota.remainingRequests !== undefined && quota.remainingRequests <= 2) {
      scoreAdjustment -= 10;
      reasons.push("LOW_REQUEST_CAPACITY");
    }
    if (quota.remainingTokens !== undefined && quota.limitTokens !== undefined && quota.limitTokens > 0 && quota.remainingTokens / quota.limitTokens <= 0.1) {
      scoreAdjustment -= 20;
      reasons.push("LOW_TOKEN_CAPACITY_CRITICAL");
    }
    return { scoreAdjustment, reasonCodes: reasons.length > 0 ? reasons : ["CAPACITY_AVAILABLE"] };
  }

  // --- snapshot / hooks ----------------------------------------------------------------------

  snapshot(): FreeCloudSnapshot {
    return buildFreeCloudSnapshot({
      firewall: this.firewall,
      registry: this.registry,
      connections: [...this.connections.values()],
      definitions: this.definitions,
      qualification: this.receipts,
      routeHealth: this.routeHealthLookup,
      quota: (p, m) => this.quota.get(p, m),
      now: this.now,
    });
  }

  candidates(): FreeCandidate[] {
    return freeCandidates(this.snapshot());
  }

  isForgeAutoEligible(providerId: string, modelId: string): boolean {
    const snap = this.snapshot();
    for (const m of snap.models) {
      const r = m.routes.find((x) => x.providerId === providerId && x.providerModelId === modelId);
      if (r) return r.forgeAutoEligible;
    }
    return false;
  }

  supplyClassOf(providerId: string, modelId: string): SupplyClass | undefined {
    return this.snapshot().models.flatMap((model) => model.routes).find((route) => route.providerId === providerId && route.providerModelId === modelId)?.supplyClass;
  }

  canonicalIdOf(providerId: string, modelId: string): string {
    return canonicalIdentityFor(providerId, modelId).canonicalId;
  }

  sameModelAlternates(providerId: string, modelId: string): Array<{ providerId: string; modelId: string }> {
    const canonicalId = this.canonicalIdOf(providerId, modelId);
    const model = this.snapshot().models.find((m) => m.canonicalId === canonicalId);
    if (!model) return [];
    return model.routes
      .filter((r) => r.forgeAutoEligible && !(r.providerId === providerId && r.providerModelId === modelId))
      .map((r) => ({ providerId: r.providerId, modelId: r.providerModelId }));
  }

  /** Routes for a canonical model that can execute for an explicit selection (best first). */
  executableRoutesFor(canonicalId: string): ProviderRouteView[] {
    const model = this.snapshot().models.find((m) => m.canonicalId === canonicalId);
    if (!model) return [];
    return model.routes
      .filter((r) => r.executable)
      .sort((a, b) => Number(b.forgeAutoEligible) - Number(a.forgeAutoEligible) || (this.quotaRemaining(b.providerId, b.providerModelId) ?? Number.MAX_SAFE_INTEGER) - (this.quotaRemaining(a.providerId, a.providerModelId) ?? Number.MAX_SAFE_INTEGER));
  }

  explain(providerId: string, modelId: string): string | undefined {
    for (const m of this.snapshot().models) {
      const r = m.routes.find((x) => x.providerId === providerId && x.providerModelId === modelId);
      if (r) return explainRoute(r);
    }
    return undefined;
  }

  /**
   * R24 Free Fabric: project every zero-cash route the registry knows into ForgeZero's
   * physical capacity model. Paid/BYOK routes never appear — the fabric is a zero-cost
   * surface by construction, and `freeRouteExclusionReason` still vets each row. Quota
   * windows come from the same provider-header evidence the RouteQuotaTracker recorded;
   * nothing is invented.
   */
  capacityRoutes(options: { qualityScoreOf?: (providerId: string, modelId: string) => number | undefined } = {}): CapacityRoute[] {
    const snap = this.snapshot();
    const routes: CapacityRoute[] = [];
    for (const model of snap.models) {
      for (const r of model.routes) {
        const supplyClass = r.supplyClass;
        if (supplyClass === undefined || !supplyClassIsZeroCash(supplyClass)) continue;
        const conn = this.connections.get(r.providerId);
        const def = this.definitions[r.providerId];
        const perUser = supplyClass === "USER_CONNECTED_FREE" || supplyClass === "DISTRIBUTED_USER_FREE";
        // A plain BYOK connection carries no account hash — the local-connection sentinel keeps
        // its pool claimable by the owning host's fabric plan (and only that plan) instead of
        // collapsing every same-provider key into one shared "unclaimed" identity.
        const capacityIdentity = conn?.userConnectedFree?.capacityIdentity ?? (perUser ? `localconn:${r.providerId}` : undefined);
        // R34 Mission C: on a model-domain provider (Groq per-model windows, Mistral's
        // per-model limits) two models are independent physical quota domains — reservations
        // against model A must not consume model B's budget. A provider-wide observation
        // collapses the shard back to the account pool: account evidence beats declaration.
        const modelDomain = def?.freeAccess.quotaDomain === "model" && !this.quota.hasProviderScoped(r.providerId);
        const capacityPoolId = perUser
          ? conn?.userConnectedFree?.capacityPoolId ?? `${r.providerId}:user:${capacityIdentity}`
          : `${supplyClass === "OWNER_DEV_FREE" || supplyClass === "OWNER_CREDIT_RESERVE" ? "owner" : "shared"}:${r.providerId}${modelDomain ? `:model:${r.providerModelId}` : ""}`;
        // R34 Mission B: a provider may draw from several physical accounts. Each managed pool
        // is its own quota domain, so a route projects once per pool it can consume — the
        // fabric's per-route reservation then lands on the account that would actually serve it.
        // For an FDS_GATEWAY connection the gateway handle is a catalog entry, not a quota
        // domain: once managed pools exist they ARE the supply and the implied `shared:` bucket
        // is suppressed (it would double-count the same upstream accounts).
        const managed = this.managedPoolsFor(r.providerId);
        const gatewayBacked = conn?.credentialSource === "FDS_GATEWAY";
        const targets: Array<{
          poolId: string;
          supply: SupplyClass;
          poolScope: "PER_USER_POOL" | "SHARED_OWNER_POOL";
          capScope: "USER_ACCOUNT" | "ORG";
          accountId?: string;
          identity?: string;
        }> = [];
        if (managed.length === 0 || !gatewayBacked || perUser) {
          targets.push({
            poolId: capacityPoolId,
            supply: supplyClass,
            poolScope: perUser ? "PER_USER_POOL" : "SHARED_OWNER_POOL",
            capScope: perUser ? "USER_ACCOUNT" : "ORG",
            ...(capacityIdentity !== undefined ? { identity: capacityIdentity } : {}),
          });
        }
        for (const mp of managed) {
          const accountDomain = def?.freeAccess.quotaDomain === "model" && !this.quota.hasProviderScoped(r.providerId, mp.accountId);
          targets.push({
            poolId: accountDomain ? `${mp.poolId}:model:${r.providerModelId}` : mp.poolId,
            supply: mp.supplyClass,
            poolScope: "SHARED_OWNER_POOL",
            capScope: "ORG",
            accountId: mp.accountId,
            identity: `managed:${mp.providerId}:${mp.accountId}`,
          });
        }
        for (const target of targets) {
        const quarantine = this.quarantineFor(target.poolId);
        const quota = r.quota ?? this.quota.get(r.providerId, r.providerModelId, target.accountId);
        const targetPerUser = target.poolScope === "PER_USER_POOL";
        routes.push({
          routeId: `fabric:${r.routeId}${target.accountId !== undefined ? `:acct:${target.accountId}` : ""}`,
          providerId: r.providerId,
          modelId: r.providerModelId,
          canonicalModelId: r.canonicalModelId,
          family: model.family,
          gateway: r.providerId,
          supplyClass: target.supply,
          capacityPoolId: target.poolId,
          capacityPoolScope: target.poolScope,
          capacityScope: target.capScope,
          // A permissive provider may train on what it sees: private code requires an explicit
          // user consent decision, not a silent routing default.
          dataPolicyProfile: r.privacyClass === "permissive" ? "USER_CONSENT_REQUIRED" : "PRIVATE_CODE_ALLOWED",
          lifecycle: r.lifecycle === "RETIRED" ? "REJECTED" : quarantine ? "QUARANTINED" : "APPROVED",
          explicitZeroPrice: r.verifiedFree,
          // USER_CONNECTED_FREE needs proof the account cannot silently bill: a managed
          // user-connection that completed its own admission, an explicit free-plan
          // attestation, or a provider whose free surface cannot spill into charges.
          freeOnlyAdmissionProven: targetPerUser
            ? conn?.userConnectedFree?.status === "CONNECTED"
              || conn?.planAttested === true
              || def?.freeAccess.spillover === "NONE"
            : undefined,
          paidFallbackDisabled: true,
          managedMultiUserAllowed: r.termsStatus === "CLEARED",
          privacyClass: r.privacyClass ?? "standard",
          roles: r.roles,
          ...(r.fallbackRoles !== undefined ? { fallbackRoles: r.fallbackRoles } : {}),
          ...(r.contextWindow !== undefined ? { contextWindow: r.contextWindow } : {}),
          qualityScore: options.qualityScoreOf?.(r.providerId, r.providerModelId)
            ?? this.firewall.getModel(r.providerId, r.providerModelId)?.codingScore
            ?? this.firewall.getModel(r.providerId, r.providerModelId)?.agentScore
            ?? (r.qualificationState === "QUALIFIED" ? 70 : r.qualificationState === "PROBATION" ? 55 : r.qualificationState === "NOT_TESTED" ? 40 : 30),
          // The fabric is a ForgeAuto surface: executable-without-qualification is an explicit
          // picker privilege, not managed-supply eligibility.
          healthy: r.forgeAutoEligible,
          // R59: when a route is ineligible, carry WHY — the governing admission gate —
          // so "UNHEALTHY" ledger rows distinguish "awaiting qualification" from actual
          // health failures instead of collapsing them into one opaque word.
          ...(r.forgeAutoEligible || r.admission.failedGate === undefined
            ? {}
            : {
                healthGate: r.admission.failedGate,
                ...(r.admission.reason !== undefined ? { healthReason: r.admission.reason } : {}),
              }),
          enabled: quarantine === undefined,
          windows: quotaWindows(quota, targetPerUser ? "USER_ACCOUNT" : "ORG", this.now),
          ...(target.identity !== undefined ? { capacityIdentity: target.identity } : {}),
        });
        }
      }
    }
    return routes;
  }

  /** Physical pools behind {@link capacityRoutes} — one shared bucket per provider account,
   * one per-user pool per connected account. Pool-level windows carry only provider-scoped
   * observations; route-scoped quota stays on the routes. */
  capacityPools(): ProviderCapacityPool[] {
    const observedAt = this.now().toISOString();
    const snap = this.snapshot();
    const pools = new Map<string, ProviderCapacityPool>();
    for (const conn of this.connections.values()) {
      const def = this.definitions[conn.providerId];
      const supplyClass = supplyClassFor(def, conn);
      if (supplyClass === undefined || !supplyClassIsZeroCash(supplyClass)) continue;
      const perUser = supplyClass === "USER_CONNECTED_FREE" || supplyClass === "DISTRIBUTED_USER_FREE";
      const capacityIdentity = conn.userConnectedFree?.capacityIdentity ?? (perUser ? `localconn:${conn.providerId}` : undefined);
      const poolId = perUser
        ? conn.userConnectedFree?.capacityPoolId ?? `${conn.providerId}:user:${capacityIdentity}`
        : `shared:${conn.providerId}`;
      // Model-domain providers shard into per-model pools below; the account-level pool is
      // dead weight when no provider-scoped observation exists (no route claims it).
      const modelDomain = !perUser && def?.freeAccess.quotaDomain === "model" && !this.quota.hasProviderScoped(conn.providerId);
      // A gateway connection's implied `shared:` bucket is not a quota domain once managed
      // pools exist — the fleet owns the supply, and counting both would double-admit.
      const gatewaySupplanted = conn.credentialSource === "FDS_GATEWAY" && this.managedPoolsFor(conn.providerId).length > 0;
      if (pools.has(poolId) || modelDomain || gatewaySupplanted) continue;
      const windows: CapacityWindow[] = quotaWindows(this.quota.get(conn.providerId, ""), perUser ? "USER_ACCOUNT" : "ORG", this.now);
      if (conn.userConnectedFree) {
        windows.push({ unit: "concurrency", limit: conn.userConnectedFree.concurrencyLimit, remaining: conn.userConnectedFree.concurrencyLimit, resetAt: NO_RESET, scope: "USER_ACCOUNT", observedAt, authoritative: true });
        if (conn.userConnectedFree.includedUsageRemainingUsd !== undefined) {
          windows.push({ unit: "credits", limit: conn.userConnectedFree.includedUsageRemainingUsd, remaining: conn.userConnectedFree.includedUsageRemainingUsd, resetAt: conn.userConnectedFree.includedUsageResetAt ?? NO_RESET, scope: "USER_ACCOUNT", observedAt, authoritative: conn.userConnectedFree.capacityConfidence === "HIGH" });
        }
      }
      pools.set(poolId, {
        poolId,
        providerId: conn.providerId,
        scope: perUser ? "PER_USER_POOL" : "SHARED_OWNER_POOL",
        supplyClass,
        windows,
        observedAt,
        authoritative: windows.length > 0,
        ...(capacityIdentity !== undefined ? { capacityIdentity } : {}),
      });
    }

    // R34 Mission B: one pool row per registered managed account (sharded per model on
    // model-domain providers, matching the route projection). Quota evidence is the
    // account-scoped slice the response observer stamped — a managed account never inherits
    // another account's window.
    for (const mp of this.managedPools.values()) {
      const mpDef = this.definitions[mp.providerId];
      const accountScoped = this.quota.hasProviderScoped(mp.providerId, mp.accountId);
      const mpModelDomain = mpDef?.freeAccess.quotaDomain === "model" && !accountScoped;
      const modelIds = mpModelDomain
        ? [...new Set(snap.models.flatMap((m) => m.routes.filter((r) => r.providerId === mp.providerId).map((r) => r.providerModelId)))]
        : [];
      if (!mpModelDomain || modelIds.length === 0) {
        const windows = quotaWindows(this.quota.get(mp.providerId, "", mp.accountId), "ORG", this.now);
        pools.set(mp.poolId, {
          poolId: mp.poolId,
          providerId: mp.providerId,
          scope: "SHARED_OWNER_POOL",
          supplyClass: mp.supplyClass,
          windows,
          observedAt,
          authoritative: windows.length > 0,
          capacityIdentity: `managed:${mp.providerId}:${mp.accountId}`,
        });
        continue;
      }
      for (const modelId of modelIds) {
        const modelPoolId = `${mp.poolId}:model:${modelId}`;
        if (pools.has(modelPoolId)) continue;
        const windows = quotaWindows(this.quota.get(mp.providerId, modelId, mp.accountId), "ORG", this.now);
        pools.set(modelPoolId, {
          poolId: modelPoolId,
          providerId: mp.providerId,
          scope: "SHARED_OWNER_POOL",
          supplyClass: mp.supplyClass,
          windows,
          observedAt,
          authoritative: windows.length > 0,
          capacityIdentity: `managed:${mp.providerId}:${mp.accountId}`,
        });
      }
    }

    // R34 Mission C: model-domain providers get one physical pool per quota domain — the same
    // ids `capacityRoutes` claims (`<prefix>:<provider>:model:<model>`). A model with no quota
    // record still gets a pool (windows empty) so route-level windows keep governing; an
    // account-scoped observation collapses every model back into the account pool above.
    for (const model of snap.models) {
      for (const r of model.routes) {
        const supplyClass = r.supplyClass;
        if (supplyClass === undefined || !supplyClassIsZeroCash(supplyClass)) continue;
        const def = this.definitions[r.providerId];
        const perUser = supplyClass === "USER_CONNECTED_FREE" || supplyClass === "DISTRIBUTED_USER_FREE";
        if (perUser || def?.freeAccess.quotaDomain !== "model" || this.quota.hasProviderScoped(r.providerId)) continue;
        const prefix = supplyClass === "OWNER_DEV_FREE" || supplyClass === "OWNER_CREDIT_RESERVE" ? "owner" : "shared";
        const modelPoolId = `${prefix}:${r.providerId}:model:${r.providerModelId}`;
        if (pools.has(modelPoolId)) continue;
        const modelWindows: CapacityWindow[] = quotaWindows(this.quota.get(r.providerId, r.providerModelId), "ORG", this.now);
        pools.set(modelPoolId, {
          poolId: modelPoolId,
          providerId: r.providerId,
          scope: "SHARED_OWNER_POOL",
          supplyClass,
          windows: modelWindows,
          observedAt,
          authoritative: modelWindows.length > 0,
        });
      }
    }
    return [...pools.values()];
  }

  /**
   * R24 Mission C: the per-user supply projection the Free Fabric's `userSources` consume.
   * A request may only see a `PER_USER_POOL` route/pool when the stamped `ownerUserId` of the
   * connection behind it matches the requesting user — user-owned capacity is never aggregated
   * into managed supply, and one user's pool is invisible to another's decision.
   */
  routesForUser(userId: string): CapacityRoute[] {
    return this.capacityRoutes().filter(
      (route) => route.capacityPoolScope === "PER_USER_POOL" && this.connections.get(route.providerId)?.ownerUserId === userId,
    );
  }

  poolsForUser(userId: string): ProviderCapacityPool[] {
    return this.capacityPools().filter(
      (pool) => pool.scope === "PER_USER_POOL" && this.connections.get(pool.providerId)?.ownerUserId === userId,
    );
  }

  servingInputTokenCeiling(userId: string, role: string): number | undefined {
    // A provider-stamped token window bounds every request the route will ever serve — it is
    // structural supply evidence, so transient cooldown/qualification states do not remove a
    // route from the bound. Role-declared routes bound first; when none declare the role the
    // probation path can still pick any enabled route, so the whole eligible set bounds.
    const eligible = this.routesForUser(userId).filter((route) => route.enabled);
    const roleMatched = eligible.filter(
      (route) => route.roles.includes(role) || route.fallbackRoles?.includes(role) === true,
    );
    const limits = (roleMatched.length > 0 ? roleMatched : eligible)
      .flatMap((route) => route.windows)
      .filter((w) => w.unit === "input_tokens" && Number.isFinite(w.limit) && w.limit > 0)
      .map((w) => w.limit);
    return limits.length === 0 ? undefined : Math.min(...limits);
  }

  /**
   * The non-secret capacity identities this user owns, computed from the same stamped
   * connection state {@link capacityRoutes} projects — including the `localconn:` sentinel a
   * per-user connection gets when the host recorded no account hash. Ownership is decided by
   * `ownerUserId`, so a user can never name an identity it does not hold.
   */
  capacityIdentitiesFor(userId: string): string[] {
    const identities: string[] = [];
    for (const conn of this.connections.values()) {
      if (conn.ownerUserId !== userId) continue;
      const supplyClass = supplyClassFor(this.definitions[conn.providerId], conn);
      if (supplyClass !== "USER_CONNECTED_FREE" && supplyClass !== "DISTRIBUTED_USER_FREE") continue;
      identities.push(conn.userConnectedFree?.capacityIdentity ?? `localconn:${conn.providerId}`);
    }
    return identities;
  }

  // --- change notification -------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // listeners are advisory
      }
    }
  }
}

function retryDelayMs(retryAfterMs: number | undefined, resetAt: string | undefined, now: Date): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs;
  if (!resetAt) return undefined;
  const reset = Date.parse(resetAt);
  return Number.isFinite(reset) ? Math.max(0, reset - now.getTime()) : undefined;
}

export function createFreeCloudService(options: FreeCloudServiceOptions): FreeCloudService {
  return new FreeCloudService(options);
}

import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, ProviderCatalog, ProviderResponseObservation } from "@codeforge/providers";
import {
  runCompactQualification,
  type ModelQualificationReceipt,
  type QualificationPersistence,
  InMemoryQualificationPersistence,
} from "@codeforge/eight-bit";
import { canonicalIdentityFor } from "./canonical.js";
import {
  buildFreeCloudSnapshot,
  explainRoute,
  freeCandidates,
  type FreeCandidate,
  type FreeCloudSnapshot,
  type ProviderConnectionState,
  type ProviderRouteView,
  type RouteHealth,
} from "./free-cloud-registry.js";
import { PROVIDER_DEFINITIONS, type ProviderDefinition } from "./provider-definitions.js";
import type { NormalizedModelRegistry } from "./registry.js";
import { RouteQuotaTracker, parseRouteQuota } from "./quota.js";

/**
 * Routing hooks ForgeAuto (the server's AgentRuntime) consumes. 8-Bit maintains the pool; the
 * router decides. Everything here is a pure lookup over the current registry state.
 */
export interface FreeCloudRoutingHooks {
  isForgeAutoEligible(providerId: string, modelId: string): boolean;
  canonicalIdOf(providerId: string, modelId: string): string;
  /** Other ForgeAuto-eligible routes serving the same canonical model (same-model failover first). */
  sameModelAlternates(providerId: string, modelId: string): Array<{ providerId: string; modelId: string }>;
  recordRouteFailure(providerId: string, modelId: string, reason: string, retryAfterMs?: number): void;
  recordRouteSuccess(providerId: string, modelId: string): void;
  quotaRemaining(providerId: string, modelId: string): number | undefined;
  /** Monotonic live roster revision consumed by Forge Auto delegation evidence. */
  rosterRevision(): number;
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
  qualificationRunner?: (model: FreeModelRecord, adapter: ProviderAdapter) => Promise<ModelQualificationReceipt>;
  /** Cooldown base for route failures recorded through the hooks. */
  failureCooldownMs?: number;
  /** Free quota is shared with real work: cap qualification requests per provider per day. Default 12. */
  qualificationDailyBudgetPerProvider?: number;
  /** Minimum interval between qualification cycles for the same provider. Default 20 minutes. */
  qualificationCycleIntervalMs?: number;
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

const SHARED_MAX_COOLDOWN_MS = 15 * 60_000;

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
  private readonly health = new Map<string, RouteHealthEntry>();
  readonly quota = new RouteQuotaTracker();
  private readonly now: () => Date;
  private readonly maxQualificationsPerCycle: number;
  private readonly qualificationRunner: NonNullable<FreeCloudServiceOptions["qualificationRunner"]>;
  private readonly failureCooldownMs: number;
  private readonly qualificationDailyBudget: number;
  private readonly qualificationCycleIntervalMs: number;
  /** Qualification requests spent per provider, keyed by UTC day. */
  private readonly qualificationSpend = new Map<string, { day: string; requests: number; lastCycleAt: number }>();
  private qualifying = false;
  private listeners = new Set<() => void>();
  private rosterRevisionNumber = 1;

  constructor(options: FreeCloudServiceOptions) {
    this.firewall = options.firewall;
    this.providerCatalog = options.providerCatalog;
    this.registry = options.registry;
    this.definitions = options.definitions ?? PROVIDER_DEFINITIONS;
    this.qualificationStore = options.qualificationStore ?? new InMemoryQualificationPersistence();
    this.now = options.now ?? (() => new Date());
    this.maxQualificationsPerCycle = options.maxQualificationsPerCycle ?? 3;
    this.qualificationRunner = options.qualificationRunner ?? ((model, adapter) => runCompactQualification(model, adapter, { now: this.now }));
    this.failureCooldownMs = options.failureCooldownMs ?? 30_000;
    this.qualificationDailyBudget = options.qualificationDailyBudgetPerProvider ?? 12;
    this.qualificationCycleIntervalMs = options.qualificationCycleIntervalMs ?? 20 * 60_000;
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
    const penalty = (r: ProviderRouteView): number => (r.health === "DEGRADED" ? 1 : 0);
    return snap.models
      .flatMap((m) => m.routes)
      .filter((r) => r.admission.failedGate === "CODEFORGE_QUALIFIED" && (r.qualificationState === "NOT_TESTED" || r.qualificationState === "STALE"))
      .filter((r) => r.health !== "COOLDOWN" && r.health !== "QUOTA_EXHAUSTED" && r.health !== "AUTH_REQUIRED")
      .sort((a, b) => penalty(a) - penalty(b) || score(b) - score(a));
  }

  private spendFor(providerId: string): { day: string; requests: number; lastCycleAt: number } {
    const day = this.now().toISOString().slice(0, 10);
    const entry = this.qualificationSpend.get(providerId);
    if (!entry || entry.day !== day) {
      const fresh = { day, requests: 0, lastCycleAt: 0 };
      this.qualificationSpend.set(providerId, fresh);
      return fresh;
    }
    return entry;
  }

  /** True when this provider may run another qualification cycle now (budget + interval). */
  qualificationAllowed(providerId: string, requests = 3): boolean {
    const spend = this.spendFor(providerId);
    if (spend.requests + requests > this.qualificationDailyBudget) return false;
    return this.now().getTime() - spend.lastCycleAt >= this.qualificationCycleIntervalMs;
  }

  /**
   * Run the compact qualification suite for pending routes, bounded per cycle. Idempotent under
   * concurrency (a second caller while a cycle runs returns immediately).
   */
  async qualifyPending(opts: { budget?: number; providerId?: string } = {}): Promise<ModelQualificationReceipt[]> {
    if (this.qualifying) return [];
    this.qualifying = true;
    const produced: ModelQualificationReceipt[] = [];
    try {
      const budget = opts.budget ?? this.maxQualificationsPerCycle;
      const cycleStarted = new Set<string>();
      const pending = this.pendingQualification().filter((r) => !opts.providerId || r.providerId === opts.providerId);
      let taken = 0;
      for (const route of pending) {
        if (taken >= budget) break;
        // Shared free quota: never spend more than the daily qualification budget on a provider,
        // and never re-enter a provider's cycle before the interval elapsed (§195).
        if (!cycleStarted.has(route.providerId) && !this.qualificationAllowed(route.providerId)) continue;
        const model = this.firewall.getModel(route.providerId, route.providerModelId);
        const adapter = this.providerCatalog.get(route.providerId);
        if (!model || !adapter) continue;
        const spend = this.spendFor(route.providerId);
        if (spend.requests + 3 > this.qualificationDailyBudget) continue;
        cycleStarted.add(route.providerId);
        spend.lastCycleAt = this.now().getTime();
        spend.requests += 3;
        try {
          const receipt = await this.qualificationRunner(model, adapter);
          // A transient (429/401) probe is not evidence about the model; keep it pending. It
          // still counts against the provider's daily spend (conservative), but not against the
          // per-cycle slots, so the cycle moves on to a route that can actually be scored.
          if (receipt.metadata?.transient === true) {
            this.recordRouteFailure(route.providerId, route.providerModelId, "RATE_LIMITED");
            continue;
          }
          taken++;
          this.receipts.set(`${receipt.providerId}::${receipt.modelId}`, receipt);
          await this.qualificationStore.save(receipt).catch(() => undefined);
          this.applyReceiptToFirewall(receipt);
          produced.push(receipt);
          this.emit();
        } catch {
          // Qualification must never take the fleet down; an exception is still a spent slot.
          taken++;
        }
      }
    } finally {
      this.qualifying = false;
    }
    return produced;
  }

  isQualifying(): boolean {
    return this.qualifying;
  }

  // --- health / quota ------------------------------------------------------------------------

  private routeHealthLookup = (providerId: string, modelId: string): { status: RouteHealth; cooldownUntil?: number } | undefined => {
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

  /** Provider response observer for adapters (quota headers + 429 cooldown). */
  readonly onProviderResponse = (obs: ProviderResponseObservation): void => {
    const quota = parseRouteQuota(obs.headers, this.now);
    this.quota.record(obs.providerId, obs.modelId, quota);
    if (obs.status === 429 && obs.modelId) {
      this.recordRouteFailure(obs.providerId, obs.modelId, "RATE_LIMITED", quota?.retryAfterMs);
    } else if (obs.status === 402 && obs.modelId) {
      this.recordRouteFailure(obs.providerId, obs.modelId, "PAID_PLAN_REQUIRED");
    }
  };

  quotaRemaining(providerId: string, modelId: string): number | undefined {
    return this.quota.remainingRequests(providerId, modelId);
  }

  rosterRevision(): number {
    return this.rosterRevisionNumber;
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

  // --- change notification -------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.rosterRevisionNumber += 1;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // listeners are advisory
      }
    }
  }
}

export function createFreeCloudService(options: FreeCloudServiceOptions): FreeCloudService {
  return new FreeCloudService(options);
}

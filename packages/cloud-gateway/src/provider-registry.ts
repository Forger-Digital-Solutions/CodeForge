import { PROVIDER_DEFINITIONS } from "@codeforge/model-registry";
import {
  createProviderAdapterById,
  createProviderAdapterFromDefinition,
  type ProviderAdapter,
  type CredentialStore,
} from "@codeforge/providers";
import type { CloudFirewallManager } from "./cloud-firewall.js";
import { MANAGED_FREE_INVENTORY, managedRoutesFor } from "./managed-free-inventory.js";

/** Plain in-memory credential store — holds only server-owned keys, never persisted, never exposed. */
export class MapCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();
  get(providerId: string): string | undefined {
    return this.map.get(providerId);
  }
  set(providerId: string, credential: string): void {
    this.map.set(providerId, credential);
  }
  delete(providerId: string): boolean {
    return this.map.delete(providerId);
  }
  has(providerId: string): boolean {
    return this.map.has(providerId);
  }
}

export interface ResolvedProviderCredentials {
  /** Credential store keyed by providerId (plus `cloudflare-account-id`). */
  store: CredentialStore;
  /** Provider ids that have a usable server-owned credential present. */
  providerIds: string[];
}

/**
 * Resolve which providers have server-owned credentials present in the given environment, honoring
 * the dedicated CodeForge Cloud env vars and Cloudflare's split account-id + token. Reads env only
 * — never performs network calls, never logs values. The returned
 * store is handed to provider adapters so keys stay inside the process and never reach the desktop.
 */
export function resolveCloudProviderCredentials(env: Record<string, string | undefined> = process.env): ResolvedProviderCredentials {
  const store = new MapCredentialStore();
  const providerIds: string[] = [];

  const managed = [
    { providerId: "groq", key: env.CODEFORGE_GROQ_API_KEY?.trim(), requireFreePlan: true },
  ] as const;
  for (const candidate of managed) {
    if (!candidate.key || (candidate.requireFreePlan && env.CODEFORGE_GROQ_FREE_PLAN_ONLY !== "true")) continue;
    store.set(candidate.providerId, candidate.key);
    providerIds.push(candidate.providerId);
  }
  {
    const providerId = "cloudflare-workers-ai";
    const accountId = env.CODEFORGE_CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = env.CODEFORGE_CLOUDFLARE_API_TOKEN?.trim();
    if (accountId && token && env.CODEFORGE_CLOUDFLARE_FREE_PLAN_ONLY === "true") {
      store.set(providerId, token);
      store.set("cloudflare-account-id", accountId);
      providerIds.push(providerId);
    }
  }
  return { store, providerIds };
}

/**
 * Operational status of one server-owned provider's hosted-free capacity.
 * - healthy:          adapter registered and >= 1 ForgeZero-verified free model was discovered
 * - no_free_models:   adapter works but no $0-safe model qualified (provider may be paid-tier only)
 * - auth_required:    credential invalid/revoked (401/403) — excluded from routing
 * - rate_limited:     429 during discovery/probe — cools down, retried later
 * - offline:          network/other transport error
 * - misconfigured:    required configuration missing (e.g. Cloudflare account id)
 * - skipped_paid_only: provider has NO free access of any kind (OpenAI) — never registered as
 *                      hosted-free capacity so owner cash can never be spent through the free pool
 */
export type ProviderCapacityStatus =
  | "healthy"
  | "no_free_models"
  | "auth_required"
  | "rate_limited"
  | "offline"
  | "misconfigured"
  | "skipped_paid_only"
  | "not_approved";

export interface ProviderCapacityReport {
  providerId: string;
  displayName: string;
  status: ProviderCapacityStatus;
  /** Count of ForgeZero-verified free models registered from this provider. */
  verifiedFreeCount: number;
  /** Count of models the provider's live catalog listed (before eligibility filtering). */
  discoveredModelCount: number;
  lastCheckedAt: string;
  /** Sanitized error category (never contains credentials). */
  error?: string;
}

export interface ManagedFreeRouteStatus {
  providerId: string;
  modelId: string;
  displayName: string;
  source: string;
  qualified: boolean;
  active: boolean;
  liveTested: boolean;
  activationState: "active" | "qualified_but_inactive" | "policy_record_required";
  providerStatus: ProviderCapacityStatus | "not_configured";
  lastCheckedAt?: string;
  reason: string;
}

export interface CloudProviderRegistryOptions {
  firewallManager: CloudFirewallManager;
  /** Resolves each provider's credential (and `cloudflare-account-id`). */
  credentialStore: CredentialStore;
  /** Provider ids to attempt — only those whose credentials are actually present. */
  providerIds: string[];
  now?: () => Date;
  /** Test seam: build an adapter for a providerId. Defaults to createProviderAdapterById(store). */
  adapterFactory?: (providerId: string) => ProviderAdapter | undefined;
  /** Minimum ms between successful full refreshes (default 5 minutes). */
  refreshTtlMs?: number;
  /** Per-probe/list network timeout hint passed to adapters (default 30s). */
  timeoutMs?: number;
}

type LiveProviderModel = {
  modelId: string;
  isFree: boolean;
  displayName: string;
  contextWindow?: number;
  toolCalling: boolean;
  vision: boolean;
  structuredOutput: boolean;
};

const DEFAULT_REFRESH_TTL_MS = 5 * 60 * 1000;

/**
 * Discovers REAL, server-owned hosted-free capacity. For every provider whose credential is present
 * it builds the provider adapter, registers it into the cloud provider catalog, lists the live model
 * catalog, and hands the listing to the SAME ForgeZero discovery engine the desktop uses
 * (`discoverAndVerifyFree` for $0-unit models, `verifyAllowanceViaProbe` for allowance tiers). Only
 * models ForgeZero independently verifies as free-safe are registered — nothing is trusted from a
 * hard-coded list. Paid-only providers are never registered, structurally preventing owner spend
 * through the free pool.
 */
export class CloudProviderRegistry {
  private readonly firewallManager: CloudFirewallManager;
  private readonly credentialStore: CredentialStore;
  private readonly providerIds: string[];
  private readonly now: () => Date;
  private readonly adapterFactory: (providerId: string) => ProviderAdapter | undefined;
  private readonly refreshTtlMs: number;
  private readonly timeoutMs: number;

  private reports = new Map<string, ProviderCapacityReport>();
  private lastFullRefreshAt = 0;
  private discovering: Promise<ProviderCapacityReport[]> | null = null;

  constructor(options: CloudProviderRegistryOptions) {
    this.firewallManager = options.firewallManager;
    this.credentialStore = options.credentialStore;
    this.providerIds = options.providerIds;
    this.now = options.now ?? (() => new Date());
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.adapterFactory =
      options.adapterFactory ??
      ((providerId: string) => {
        // R1: every implemented provider definition (Cerebras, SambaNova, Mistral, …) gets a real
        // adapter; the legacy id switch remains the fallback for the original set.
        const def = PROVIDER_DEFINITIONS[providerId];
        const fromDefinition = def?.implemented
          ? createProviderAdapterFromDefinition(def, { credentialStore: this.credentialStore, timeoutMs: this.timeoutMs })
          : undefined;
        return fromDefinition ?? createProviderAdapterById(providerId, { credentialStore: this.credentialStore, timeoutMs: this.timeoutMs });
      });
  }

  /** Provider capacity reports from the most recent discovery, newest snapshot per provider. */
  getReports(): ProviderCapacityReport[] {
    return [...this.reports.values()];
  }

  /**
   * Truthful operator-facing state for every reviewed managed-free route. A route is `active` only
   * when the same ForgeZero catalog that serves inference currently marks its exact provider/model
   * eligible. Static qualification never masquerades as live capacity.
   */
  getManagedFreeRouteStatuses(): ManagedFreeRouteStatus[] {
    const reportByProvider = new Map([...this.reports.values()].map((report) => [report.providerId, report]));
    const activeByRoute = new Map(
      this.firewallManager
        .listHostedModels()
        .filter((model) => model.isEligibleFree)
        .map((model) => [`${model.providerId}::${model.modelId}`, model]),
    );

    return MANAGED_FREE_INVENTORY.map((route) => {
      const report = reportByProvider.get(route.providerId);
      const active = route.activation === "ready" && activeByRoute.has(`${route.providerId}::${route.modelId}`);
      const qualified = route.activation === "ready";
      const activationState = route.activation === "policy_record_required"
        ? "policy_record_required"
        : active
          ? "active"
          : "qualified_but_inactive";
      const providerStatus = report?.status ?? "not_configured";
      let reason = "Operator credential and free-plan guard are not configured";
      if (route.activation === "policy_record_required") {
        reason = "Hosted multi-tenant policy/data-use record is required before activation";
      } else if (active) {
        reason = "Live-listed, live-probed, and ForgeZero-eligible";
      } else if (report?.status === "auth_required") {
        reason = "Provider credential was rejected or revoked";
      } else if (report?.status === "rate_limited") {
        reason = "Provider is cooling down after a rate limit";
      } else if (report?.status === "healthy") {
        reason = "Provider is healthy, but this exact managed route is not active";
      } else if (report?.error) {
        reason = report.error;
      }
      return {
        providerId: route.providerId,
        modelId: route.modelId,
        displayName: route.displayName,
        source: route.source,
        qualified,
        active,
        liveTested: active,
        activationState,
        providerStatus,
        ...(report?.lastCheckedAt ? { lastCheckedAt: report.lastCheckedAt } : {}),
        reason,
      };
    });
  }

  /** True when at least one provider currently backs >= 1 verified-free model. */
  hasHealthyFreeCapacity(): boolean {
    for (const r of this.reports.values()) {
      if (r.status === "healthy" && r.verifiedFreeCount > 0) return true;
    }
    return false;
  }

  /**
   * Run (or coalesce) a full discovery pass across every configured provider. Respects the refresh
   * TTL unless `force` is set. Concurrent callers share one in-flight pass. Never throws — provider
   * failures are captured as reports so one bad credential can't stop the server.
   */
  async discover(opts: { force?: boolean } = {}): Promise<ProviderCapacityReport[]> {
    if (this.discovering) return this.discovering;
    const age = Date.now() - this.lastFullRefreshAt;
    if (!opts.force && this.lastFullRefreshAt > 0 && age < this.refreshTtlMs) {
      return this.getReports();
    }
    this.discovering = this.runDiscovery();
    try {
      const result = await this.discovering;
      this.lastFullRefreshAt = Date.now();
      return result;
    } finally {
      this.discovering = null;
    }
  }

  private async runDiscovery(): Promise<ProviderCapacityReport[]> {
    const results = await Promise.all(this.providerIds.map((id) => this.discoverProvider(id)));
    for (const r of results) this.reports.set(r.providerId, r);
    return results;
  }

  private async discoverProvider(providerId: string): Promise<ProviderCapacityReport> {
    const definition = PROVIDER_DEFINITIONS[providerId];
    const displayName = definition?.displayName ?? providerId;
    const lastCheckedAt = this.now().toISOString();
    const base = { providerId, displayName, lastCheckedAt, verifiedFreeCount: 0, discoveredModelCount: 0 };

    const allowedRoutes = managedRoutesFor(providerId);
    if (allowedRoutes.length === 0) {
      return { ...base, status: "not_approved", error: "Provider is not in managed-free inventory" };
    }
    if (allowedRoutes.some((route) => route.activation !== "ready")) {
      for (const existingId of this.firewallManager.listProviderModelIds(providerId)) {
        this.firewallManager.unregisterModel(providerId, existingId);
      }
      return { ...base, status: "not_approved", error: "Hosted policy record required" };
    }

    // Cloudflare needs an account id in addition to the API token.
    if (providerId === "cloudflare-workers-ai" && !this.credentialStore.get("cloudflare-account-id")) {
      return { ...base, status: "misconfigured", error: "Missing Cloudflare account id" };
    }

    const adapter = this.adapterFactory(providerId);
    if (!adapter) {
      return { ...base, status: "misconfigured", error: "No adapter available for provider" };
    }

    // Register the adapter so the gateway can execute against it and the orphan oracle sees it active.
    this.firewallManager.registerProvider(adapter);

    let live: LiveProviderModel[];
    try {
      const models = await adapter.listModels();
      live = models.map((m) => ({
        modelId: m.modelId,
        isFree: m.isFree,
        displayName: m.displayName,
        contextWindow: m.contextWindow,
        toolCalling: m.capabilities.toolCalling,
        vision: m.capabilities.vision,
        structuredOutput: m.capabilities.structuredOutput,
      }));
      const matchedRoutes = allowedRoutes.filter((route) => live.some((model) => model.modelId === route.modelId));
      console.info(`[CodeForge Cloud API] provider ${providerId}: liveModels=${live.length} managedRouteMatches=${matchedRoutes.length}`);
    } catch (e) {
      const status = classifyError(e);
      this.firewallManager.markProviderHealth(providerId, healthForStatus(status), {
        lastError: status,
        ...(status === "rate_limited" ? { retryAfter: Date.now() + 60_000 } : {}),
      });
      return { ...base, status, error: status };
    }

    const verifiedIds = new Set<string>();
    let probeFailure: ProviderCapacityStatus | undefined;
    for (const route of allowedRoutes) {
      if (!live.some((model) => model.modelId === route.modelId)) continue;
      try {
        let streamed = false;
        for await (const event of adapter.streamChat({ model: route.modelId, messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 5 })) {
          if (event.type === "text_delta" || event.type === "finish") streamed = true;
        }
        if (!streamed) continue;
        this.firewallManager.registerModel(route.record(lastCheckedAt));
        verifiedIds.add(route.modelId);
      } catch (error) {
        probeFailure ??= classifyError(error);
      }
    }
    const verifiedFreeCount = verifiedIds.size;

    // Owner-spend firewall — cost-transition safety: any model previously registered for this provider
    // that is NO LONGER verified-free (flipped to paid, withdrawn, or now rate-limited out of the free
    // set) is reconciled away so it can never be routed. Only runs when listModels succeeded, so a
    // transient outage never wipes last-known-good capacity.
    for (const existingId of this.firewallManager.listProviderModelIds(providerId)) {
      if (!verifiedIds.has(existingId)) this.firewallManager.unregisterModel(providerId, existingId);
    }

    if (verifiedFreeCount > 0) {
      return { ...base, status: "healthy", verifiedFreeCount, discoveredModelCount: live.length };
    }
    if (probeFailure) {
      console.info(`[CodeForge Cloud API] provider ${providerId}: managed route probe status=${probeFailure}`);
      this.firewallManager.markProviderHealth(providerId, healthForStatus(probeFailure), { lastError: probeFailure, ...(probeFailure === "rate_limited" ? { retryAfter: Date.now() + 60_000 } : {}) });
      return { ...base, status: probeFailure, discoveredModelCount: live.length, error: probeFailure };
    }
    return { ...base, status: "no_free_models", discoveredModelCount: live.length };
  }
}

/** Classify a thrown provider error into a capacity status. Never surfaces credential material. */
function classifyError(e: unknown): ProviderCapacityStatus {
  const code = (e as { code?: string })?.code;
  if (code === "PAYMENT_REQUIRED" || code === "PAID_PLAN_REQUIRED") return "no_free_models";
  if (code === "AUTH_ERROR" || code === "MISSING_API_KEY") return "auth_required";
  if (code === "RATE_LIMITED") return "rate_limited";
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid api key/i.test(msg)) return "auth_required";
  if (/\b429\b|rate.?limit|quota/i.test(msg)) return "rate_limited";
  return "offline";
}

function healthForStatus(status: ProviderCapacityStatus): "auth_required" | "rate_limited" | "offline" {
  if (status === "auth_required") return "auth_required";
  if (status === "rate_limited") return "rate_limited";
  return "offline";
}

import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderCatalog,
  ProviderHealthResponse,
  ProviderModel,
  StreamEvent,
} from "@codeforge/providers";
import { ForgeAaaRegistry, type ForgeAaaRegistryEntry, type ForgeAaaQualification } from "./registry.js";
import { resolveForgeAaaLead, FORGE_AAA_LEAD_POLICIES, type ForgeAaaLeadResolution, type ForgeAaaLeadRoute } from "./lead-policy.js";
import { routeForgeAaaTask, type ForgeAaaRouteCandidate, type ForgeAaaRouteDecision } from "./router.js";
import { BlenderAdapter, type BlenderDetection } from "./adapters/blender.js";
import { UnrealAdapter, type UnrealDetection } from "./adapters/unreal.js";
import { ForgeAaaDirector, type ForgeAaaDirectorDeps, type ForgeAaaRun } from "./orchestrator.js";
import { FORGE_AAA_SPECIALTIES } from "./specialties.js";
import { FORGE_AAA_ERRORS, FORGE_AAA_PROVIDER_ID, ForgeAaaError, type ForgeAaaLeadPolicyId, type ForgeAaaSpecialtyId } from "./types.js";

/**
 * ForgeAAA mode service (mission §3/§6). Registered in the provider catalog like Paid
 * Auto, but its "models" are lead policies. Dispatch resolves a policy to a concrete
 * upstream route inside an already-authorized domain — managed-free routes still require
 * the server's free-dispatch authorization, managed-paid routes dispatch through the
 * paid-auto adapter so its kill switch and budget gate apply unmodified, and user routes
 * stay inside USER_API ownership. ForgeAAA is never itself permission to spend money.
 */

export const FORGE_AAA_MODEL_IDS = ["auto", "sol-lead", "opus-lead", "dual-lead", "economy-lead"] as const;
export type ForgeAaaModelId = (typeof FORGE_AAA_MODEL_IDS)[number];

/** Picker rows and stored selections carry the provider prefix; policy resolution strips it. */
export const FORGE_AAA_MODEL_PREFIX = "forge-aaa:";
export function forgeAaaModelId(raw: string): ForgeAaaModelId | undefined {
  const id = raw.startsWith(FORGE_AAA_MODEL_PREFIX) ? raw.slice(FORGE_AAA_MODEL_PREFIX.length) : raw;
  return FORGE_AAA_MODEL_IDS.includes(id as ForgeAaaModelId) ? id as ForgeAaaModelId : undefined;
}

export interface ForgeAaaModelView {
  id: ForgeAaaModelId;
  providerId: typeof FORGE_AAA_PROVIDER_ID;
  displayName: string;
  tier: "forge-aaa";
  freeStatus: "unknown";
  accessClass: "FREE_NATIVE" | "PAID" | "UNKNOWN";
  available: boolean;
  unavailableReason?: string;
  state: "READY" | "NO_ELIGIBLE_LEAD" | "NAMED_LEAD_UNAVAILABLE" | "DUAL_LEAD_INCOMPLETE" | "DISABLED";
  description: string;
}

export interface ForgeAaaRuntimeModel {
  providerId: typeof FORGE_AAA_PROVIDER_ID;
  modelId: ForgeAaaModelId;
  displayName: string;
  freeStatus: "unknown";
  tier: "forge-aaa";
  capabilities: ProviderModel["capabilities"];
  isRemote: true;
}

export interface ForgeAaaDomainRouteSource {
  /** Live eligible routes across authorized domains, projected by the server. */
  leadRoutes(): ForgeAaaLeadRoute[];
  routeCandidates(): ForgeAaaRouteCandidate[];
}

export interface ForgeAaaServiceOptions {
  registry?: ForgeAaaRegistry;
  routes?: ForgeAaaDomainRouteSource;
  blender?: BlenderAdapter;
  unreal?: UnrealAdapter;
  /** Authorizes a resolved managed-free upstream route — the server's fabric authority.
   *  Absent → free upstream routes are never delegated (fail closed). */
  authorizeRoute?: (route: { providerId: string; modelId: string }) => void;
  /** Durable policy/qualification persistence; structural — satisfied by ISessionPersistence. */
  persistence?: {
    getWorkItem(id: string): Promise<Record<string, unknown> | undefined>;
    upsertWorkItem(item: Record<string, unknown> & { id: string; kind: string }): Promise<unknown>;
  };
  ownerKey?: string;
  directorDeps?: ForgeAaaDirectorDeps;
  enabled?: boolean;
  now?: () => number;
}

export class ForgeAaaService {
  readonly registry: ForgeAaaRegistry;
  private readonly routes?: ForgeAaaDomainRouteSource;
  readonly blender: BlenderAdapter;
  readonly unreal: UnrealAdapter;
  private readonly authorizeRoute?: (route: { providerId: string; modelId: string }) => void;
  private readonly persistence?: ForgeAaaServiceOptions["persistence"];
  private readonly ownerKey: string;
  private readonly enabled: boolean;
  private readonly director: ForgeAaaDirector;
  private leadPolicy: ForgeAaaLeadPolicyId = "auto";
  private cachedDetection?: { blender?: BlenderDetection; unreal?: UnrealDetection; at: number };
  private readonly now: () => number;

  constructor(options: ForgeAaaServiceOptions = {}) {
    this.registry = options.registry ?? new ForgeAaaRegistry();
    this.routes = options.routes;
    this.blender = options.blender ?? new BlenderAdapter();
    this.unreal = options.unreal ?? new UnrealAdapter();
    this.authorizeRoute = options.authorizeRoute;
    this.persistence = options.persistence;
    this.ownerKey = options.ownerKey ?? "local";
    this.enabled = options.enabled ?? true;
    this.director = new ForgeAaaDirector(options.directorDeps ?? {});
    this.now = options.now ?? Date.now;
  }

  /** Policy store — `forge-aaa-policy-<owner>` work item, same pattern as the roster. */
  private policyKey(): string {
    return `forge-aaa-policy-${this.ownerKey}`;
  }

  async loadPolicy(): Promise<ForgeAaaLeadPolicyId> {
    const item = await this.persistence?.getWorkItem(this.policyKey());
    const stored = item && typeof (item as { leadPolicy?: unknown }).leadPolicy === "string" ? (item as { leadPolicy: string }).leadPolicy : undefined;
    if (stored && FORGE_AAA_MODEL_IDS.includes(stored as ForgeAaaModelId)) this.leadPolicy = stored as ForgeAaaLeadPolicyId;
    return this.leadPolicy;
  }

  async savePolicy(policy: ForgeAaaLeadPolicyId): Promise<void> {
    this.leadPolicy = policy;
    await this.persistence?.upsertWorkItem({ id: this.policyKey(), kind: "forge-aaa-policy", leadPolicy: policy, updatedAt: new Date().toISOString() });
  }

  getLeadPolicy(): ForgeAaaLeadPolicyId {
    return this.leadPolicy;
  }

  /** Live domain routes → lead resolution for the current or given policy. */
  resolveLead(policy: ForgeAaaLeadPolicyId = this.leadPolicy): ForgeAaaLeadResolution {
    const routes = this.routes?.leadRoutes() ?? [];
    const registryLeads = this.registry.eligibleLeads()
      .map((entry) => entry.candidate.provider?.leadIdentity)
      .filter((v): v is NonNullable<typeof v> => v !== undefined);
    // A named-lead registry binding authorizes a route to claim that identity; without it
    // any leadIdentity field on the route is stripped — claims are not self-asserted.
    const bound = routes.map((r) => r.leadIdentity && registryLeads.includes(r.leadIdentity) ? r : { ...r, leadIdentity: undefined });
    return resolveForgeAaaLead(policy, bound);
  }

  routeTask(input: { taskId: string; specialty: ForgeAaaSpecialtyId; privateCode?: boolean; userConsented?: boolean; preferIndependentFrom?: string }): ForgeAaaRouteDecision {
    return routeForgeAaaTask({ ...input, candidates: this.routes?.routeCandidates() ?? [] });
  }

  /**
   * The route a forge-aaa model id would physically dispatch on, or undefined. Throws
   * nothing — callers render the honest outcome instead of catching.
   */
  upstreamFor(modelId: string): ForgeAaaLeadRoute | undefined {
    const policy = forgeAaaModelId(modelId);
    if (!policy) return undefined;
    const resolution = this.resolveLead(policy);
    return resolution.selected;
  }

  modelViews(): ForgeAaaModelView[] {
    return FORGE_AAA_MODEL_IDS.map((id) => {
      const meta = FORGE_AAA_LEAD_POLICIES.find((p) => p.id === id)!;
      if (!this.enabled) {
        return { id, providerId: FORGE_AAA_PROVIDER_ID, displayName: `ForgeAAA ${meta.displayName}`, tier: "forge-aaa", freeStatus: "unknown", accessClass: "UNKNOWN", available: false, state: "DISABLED", description: meta.description, unavailableReason: "ForgeAAA mode is disabled" };
      }
      const resolution = this.resolveLead(id);
      const state: ForgeAaaModelView["state"] = resolution.outcome === "selected" ? "READY"
        : resolution.outcome === "named_lead_unavailable" ? "NAMED_LEAD_UNAVAILABLE"
        : resolution.outcome === "dual_lead_incomplete" ? "DUAL_LEAD_INCOMPLETE"
        : "NO_ELIGIBLE_LEAD";
      const available = resolution.outcome === "selected" || resolution.outcome === "dual_lead_incomplete";
      return {
        id, providerId: FORGE_AAA_PROVIDER_ID, displayName: `ForgeAAA ${meta.displayName}`,
        tier: "forge-aaa", freeStatus: "unknown",
        accessClass: resolution.selected?.costClass === "free" ? "FREE_NATIVE" : resolution.selected ? "PAID" : "UNKNOWN",
        available, state,
        description: resolution.selected
          ? `${meta.description} → ${resolution.selected.displayName}`
          : meta.description,
        ...(available ? {} : { unavailableReason: resolution.blockedReason ?? "No eligible lead route" }),
      };
    });
  }

  runtimeModel(modelId: string): ForgeAaaRuntimeModel | undefined {
    if (!FORGE_AAA_MODEL_IDS.includes(modelId as ForgeAaaModelId)) return undefined;
    const meta = FORGE_AAA_LEAD_POLICIES.find((p) => p.id === modelId)!;
    return {
      providerId: FORGE_AAA_PROVIDER_ID,
      modelId: modelId as ForgeAaaModelId,
      displayName: `ForgeAAA ${meta.displayName}`,
      freeStatus: "unknown",
      tier: "forge-aaa",
      capabilities: { text: true, coding: true, toolCalling: true, vision: true, structuredOutput: true, longContext: true },
      isRemote: true,
    };
  }

  /** Engine detection, cached for 60s — probes spawn processes; never serve stale-hardcoded. */
  async engineStatus(forceRefresh = false): Promise<{ blender: BlenderDetection; unreal: UnrealDetection }> {
    if (!forceRefresh && this.cachedDetection && this.now() - this.cachedDetection.at < 60_000 && this.cachedDetection.blender && this.cachedDetection.unreal) {
      return { blender: this.cachedDetection.blender, unreal: this.cachedDetection.unreal };
    }
    const [blender, unreal] = await Promise.all([this.blender.detect(), this.unreal.detect()]);
    this.cachedDetection = { blender, unreal, at: this.now() };
    return { blender, unreal };
  }

  recordQualification(q: ForgeAaaQualification): void {
    this.registry.recordQualification(q);
  }

  specialistRoster(): { specialty: ForgeAaaSpecialtyId; displayName: string; eligible: string[]; status: string }[] {
    return FORGE_AAA_SPECIALTIES.map((s) => {
      const eligible = this.registry.eligibleFor(s.id).map((e) => e.candidate.id);
      return {
        specialty: s.id,
        displayName: s.displayName,
        eligible,
        status: eligible.length > 0 ? "covered" : "uncovered",
      };
    });
  }

  directorOps(): ForgeAaaDirector {
    return this.director;
  }

  /**
   * Provider-adapter surface for the catalog. Dispatch resolves the lead policy to a
   * concrete upstream route in an authorized domain and delegates — the upstream adapter's
   * own gates (ForgeZero/fabric for free, PaidAutoService for paid) still apply.
   */
  asProviderAdapter(catalog: () => ProviderCatalog): ProviderAdapter {
    const resolveUpstream = (model: string): { adapter: ProviderAdapter; modelId: string; route: ForgeAaaLeadRoute } => {
      if (!this.enabled) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.NO_ELIGIBLE_ROUTE, "ForgeAAA mode is disabled");
      }
      const policy = forgeAaaModelId(model);
      const resolution = policy ? this.resolveLead(policy) : undefined;
      if (!resolution || resolution.outcome !== "selected" || !resolution.selected) {
        throw new ForgeAaaError(
          FORGE_AAA_ERRORS.NO_ELIGIBLE_ROUTE,
          `ForgeAAA ${model}: ${resolution ? (resolution.blockedReason ?? resolution.outcome) : "unknown policy"}`,
        );
      }
      const route = resolution.selected;
      const adapter = catalog().get(route.upstreamProviderId);
      if (!adapter) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.NO_ELIGIBLE_ROUTE, `upstream provider ${route.upstreamProviderId} not registered`);
      }
      if (route.domain === "managed_free") {
        if (!this.authorizeRoute) {
          throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "free-fabric authorization unavailable — refusing dispatch");
        }
        this.authorizeRoute({ providerId: route.upstreamProviderId, modelId: route.upstreamModelId });
      }
      return { adapter, modelId: route.upstreamModelId, route };
    };
    const listModels = async (): Promise<ProviderModel[]> => this.modelViews().map((v) => ({
      modelId: `forge-aaa:${v.id}`,
      displayName: v.displayName,
      capabilities: { text: true, coding: true, toolCalling: true, vision: true, structuredOutput: true, longContext: true },
      isFree: v.accessClass === "FREE_NATIVE",
      freeStatus: "unknown" as const,
    }));
    const healthCheck = async (): Promise<ProviderHealthResponse> => {
      const views = this.modelViews();
      if (views.some((v) => v.available)) return { status: "available" };
      return { status: "unknown", error: "ForgeAAA has no eligible lead route" };
    };
    const canRoute = (modelId: string): boolean => this.upstreamFor(modelId) !== undefined;
    return {
      providerId: FORGE_AAA_PROVIDER_ID,
      listModels,
      healthCheck,
      canRoute,
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const { adapter, modelId } = resolveUpstream(req.model);
        return adapter.chat({ ...req, model: modelId });
      },
      async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        const { adapter, modelId } = resolveUpstream(req.model);
        yield* adapter.streamChat({ ...req, model: modelId }, signal);
      },
    };
  }
}

export function createForgeAaaService(options: ForgeAaaServiceOptions = {}): ForgeAaaService {
  return new ForgeAaaService(options);
}

/** Adapter-boundary resolver: forge-aaa model id → current concrete upstream route. */
export function forgeAaaUpstreamResolver(service: ForgeAaaService): (modelId: string) => { providerId: string; modelId: string } | undefined {
  return (modelId) => {
    const route = service.upstreamFor(modelId);
    return route ? { providerId: route.upstreamProviderId, modelId: route.upstreamModelId } : undefined;
  };
}

export type { ForgeAaaRun, ForgeAaaQualification, ForgeAaaRegistryEntry };

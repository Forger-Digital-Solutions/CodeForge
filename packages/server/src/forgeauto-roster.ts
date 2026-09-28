import { createHash } from "node:crypto";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { PaidAutoCanonicalModelId } from "@codeforge/paid-auto";
import type { ShillingConfidence } from "@codeforge/cloud-usage";

export type IntelligenceSourceClass = "MANAGED_FREE" | "MANAGED_PAID" | "USER_API" | "USER_HOSTED" | "LOCAL";
export type RosterEntitlement = "FREE" | "PAID" | "CUSTOM";
export type RosterRole = "EXPLORER" | "PLANNER" | "CODER" | "TESTER" | "REVIEWER" | "LEAD";
export type RosterSlot =
  | { kind: "PINNED_VERSION"; modelId: string; allowedRoles?: RosterRole[]; enabled: boolean }
  | { kind: "AUTO_CURRENT"; familyId: string; sourceClass: IntelligenceSourceClass; allowedRoles?: RosterRole[]; enabled: boolean }
  | { kind: "AUTO"; sourceClass: IntelligenceSourceClass; allowedRoles?: RosterRole[]; enabled: boolean };

export interface ForgeAutoRoster {
  ownerUserId: string;
  entitlement: RosterEntitlement;
  slots: RosterSlot[];
  lead: { mode: "NONE" | "AUTO" | "MANUAL"; slotIndex?: number };
  updatedAt: string;
}

export interface RosterCandidate {
  modelId: string;
  providerId: string;
  providerModelId: string;
  routes?: readonly { providerId: string; modelId: string }[];
  familyId: string;
  version: string;
  sourceClass: IntelligenceSourceClass;
  lifecycle: "DISCOVERED" | "PROBATION" | "QUALIFIED" | "ACTIVE" | "ACTIVE_ECONOMY" | "SUPERSEDED" | "RETIRED";
  available: boolean;
  approved: boolean;
  qualifiedRoles: readonly RosterRole[];
  credentialRef?: string;
  ownerUserId?: string;
  /** R55: durable id of the owning user-intelligence source (USER_API candidates only). */
  sourceId?: string;
  /** R55: user-declared per-million-token pricing carried into the route allowance. */
  inputCostPerMillion?: number | null;
  outputCostPerMillion?: number | null;
  costConfidence?: ShillingConfidence;
  priceSource?: string;
  /** Internal resolution metadata: which slot kind admitted this candidate. Set by
   *  resolveForgeAutoRole on the returned copy; never persisted, never a secret. */
  resolvedViaSlot?: RosterSlot["kind"];
  dataPolicy: { privateCode: boolean; syntheticOnly?: boolean; userConsentRequired?: boolean };
}

export interface RosterPolicy {
  minSlots: number;
  maxSlots: number;
  allowSingleModel: boolean;
}

export const DEFAULT_ROSTER_POLICY: RosterPolicy = { minSlots: 2, maxSlots: 5, allowSingleModel: false };
const ROSTER_ROLES = new Set<RosterRole>(["EXPLORER", "PLANNER", "CODER", "TESTER", "REVIEWER", "LEAD"]);
const SOURCE_CLASSES = new Set<IntelligenceSourceClass>(["MANAGED_FREE", "MANAGED_PAID", "USER_API", "USER_HOSTED", "LOCAL"]);

function sourceAllowed(entitlement: RosterEntitlement, source: IntelligenceSourceClass): boolean {
  if (entitlement === "FREE") return source === "MANAGED_FREE";
  if (entitlement === "PAID") return source === "MANAGED_FREE" || source === "MANAGED_PAID";
  return entitlement === "CUSTOM" && SOURCE_CLASSES.has(source);
}

function candidateAuthorized(candidate: RosterCandidate, roster: ForgeAutoRoster): boolean {
  return candidate.approved && sourceAllowed(roster.entitlement, candidate.sourceClass)
    && (candidate.sourceClass === "MANAGED_FREE" || candidate.sourceClass === "MANAGED_PAID" || candidate.ownerUserId === roster.ownerUserId);
}

/** R55 V1: USER_HOSTED and LOCAL remain schema values for forward compatibility but no
 *  executable adapter exists for them — selection fails closed rather than guessing. */
const NON_EXECUTABLE_V1_SOURCES = new Set<IntelligenceSourceClass>(["USER_HOSTED", "LOCAL"]);

export function validateForgeAutoRoster(
  roster: ForgeAutoRoster,
  catalog: readonly RosterCandidate[],
  policy: RosterPolicy = DEFAULT_ROSTER_POLICY,
): void {
  if (!roster.ownerUserId.trim()) throw new Error("ROSTER_OWNER_REQUIRED");
  if (!Array.isArray(roster.slots) || !roster.lead || !["NONE", "AUTO", "MANUAL"].includes(roster.lead.mode)) throw new Error("ROSTER_FORMAT_INVALID");
  if (roster.slots.some((slot) => !slot || typeof slot !== "object" || typeof slot.enabled !== "boolean")) throw new Error("ROSTER_FORMAT_INVALID");
  for (const slot of roster.slots) {
    if (!["PINNED_VERSION", "AUTO_CURRENT", "AUTO"].includes(slot.kind)) throw new Error("ROSTER_FORMAT_INVALID");
    if (slot.kind === "PINNED_VERSION" ? !slot.modelId?.trim() : !SOURCE_CLASSES.has(slot.sourceClass) || slot.kind === "AUTO_CURRENT" && !slot.familyId?.trim()) throw new Error("ROSTER_FORMAT_INVALID");
    if (slot.allowedRoles && (!Array.isArray(slot.allowedRoles) || slot.allowedRoles.length === 0 || new Set(slot.allowedRoles).size !== slot.allowedRoles.length || slot.allowedRoles.some((role) => !ROSTER_ROLES.has(role)))) throw new Error("ROSTER_ROLES_INVALID");
  }
  if (!Number.isInteger(policy.minSlots) || !Number.isInteger(policy.maxSlots) || policy.maxSlots < policy.minSlots || policy.minSlots < 1) throw new Error("ROSTER_POLICY_INVALID");
  const active = roster.slots.filter((slot) => slot.enabled);
  if (active.length === 0) throw new Error("ROSTER_EMPTY");
  if (active.length > policy.maxSlots) throw new Error("ROSTER_TOO_LARGE");
  if (active.length < policy.minSlots && !(policy.allowSingleModel && active.length === 1)) throw new Error("ROSTER_TOO_SMALL");
  const identities = new Set<string>();
  for (const slot of active) {
    const identity = slot.kind === "PINNED_VERSION" ? `PIN:${slot.modelId}` : slot.kind === "AUTO_CURRENT" ? `FAMILY:${slot.sourceClass}:${slot.familyId}` : `AUTO:${slot.sourceClass}`;
    if (identities.has(identity)) throw new Error("ROSTER_DUPLICATE_SLOT");
    identities.add(identity);
    if (slot.kind === "PINNED_VERSION") {
      const candidate = catalog.find((entry) => entry.modelId === slot.modelId);
      // An unavailable or retired pin still validates as configured intent — resolution
      // reports PINNED_MODEL_UNAVAILABLE so the owner sees the action required rather
      // than losing the roster outright.
      if (!candidate || !candidateAuthorized(candidate, roster)) throw new Error("ROSTER_MODEL_INELIGIBLE");
      if (NON_EXECUTABLE_V1_SOURCES.has(candidate.sourceClass)) throw new Error("ROSTER_SOURCE_NOT_EXECUTABLE_V1");
    } else {
      if (!sourceAllowed(roster.entitlement, slot.sourceClass)) throw new Error("ROSTER_SOURCE_INELIGIBLE");
      if (NON_EXECUTABLE_V1_SOURCES.has(slot.sourceClass)) throw new Error("ROSTER_SOURCE_NOT_EXECUTABLE_V1");
      if (slot.kind === "AUTO_CURRENT" && !catalog.some((entry) => entry.familyId === slot.familyId && entry.sourceClass === slot.sourceClass && candidateAuthorized(entry, roster))) throw new Error("ROSTER_FAMILY_UNKNOWN");
      if (slot.kind === "AUTO" && !catalog.some((entry) => entry.sourceClass === slot.sourceClass && candidateAuthorized(entry, roster))) throw new Error("ROSTER_POOL_EMPTY");
    }
  }
  // Two active slots that can select the same exact candidate for an overlapping role are
  // a hidden double route — an exact pin must not silently overlap an AUTO pool. Disjoint
  // allowedRoles (or disjoint candidates) may coexist.
  const ALL_ROLES: readonly RosterRole[] = [...ROSTER_ROLES];
  const slotRoles = (slot: RosterSlot): readonly RosterRole[] => slot.allowedRoles ?? ALL_ROLES;
  const selectableFor = (slot: RosterSlot, role: RosterRole): Set<string> => new Set(
    catalog.filter((entry) => candidateAuthorized(entry, roster)
      && entry.available
      && !NON_EXECUTABLE_V1_SOURCES.has(entry.sourceClass)
      && entry.qualifiedRoles.includes(role)
      && (slot.kind === "PINNED_VERSION"
        ? entry.modelId === slot.modelId && (entry.lifecycle === "ACTIVE" || entry.lifecycle === "ACTIVE_ECONOMY" || entry.lifecycle === "SUPERSEDED")
        : slot.kind === "AUTO_CURRENT"
          ? entry.familyId === slot.familyId && entry.sourceClass === slot.sourceClass && entry.lifecycle === "ACTIVE"
          : entry.sourceClass === slot.sourceClass && (entry.lifecycle === "ACTIVE" || entry.lifecycle === "ACTIVE_ECONOMY")))
      .map((entry) => entry.modelId),
  );
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      for (const role of slotRoles(a)) {
        if (!slotRoles(b).includes(role)) continue;
        const setA = selectableFor(a, role);
        const setB = selectableFor(b, role);
        if ([...setA].some((modelId) => setB.has(modelId))) throw new Error("ROSTER_CONFLICTING_SLOTS");
      }
    }
  }
  if (roster.lead.mode === "MANUAL") {
    if (roster.lead.slotIndex === undefined || !roster.slots[roster.lead.slotIndex]?.enabled || roster.slots[roster.lead.slotIndex]?.allowedRoles?.includes("LEAD") === false) throw new Error("ROSTER_LEAD_INVALID");
    // A manual Lead must resolve at write time to at least one authorized, currently
    // executable candidate qualified for LEAD — a dangling pointer is refused, not saved.
    const slot = roster.slots[roster.lead.slotIndex]!;
    if (selectableFor(slot, "LEAD").size === 0) throw new Error("ROSTER_LEAD_INVALID");
  }
  if (roster.lead.mode !== "MANUAL" && roster.lead.slotIndex !== undefined) throw new Error("ROSTER_LEAD_INVALID");
}

export interface RosterResolution {
  status: "READY" | "UNAVAILABLE_ACTION_REQUIRED" | "NO_ELIGIBLE_ROLE_MODEL";
  candidates: RosterCandidate[];
  rejected: { slotIndex: number; reason: string }[];
}

export function resolveForgeAutoRole(
  roster: ForgeAutoRoster,
  catalog: readonly RosterCandidate[],
  role: RosterRole,
  context: { privateCode: boolean; userConsented: boolean } = { privateCode: false, userConsented: false },
): RosterResolution {
  const candidates: RosterCandidate[] = [];
  const rejected: RosterResolution["rejected"] = [];
  for (const [slotIndex, slot] of roster.slots.entries()) {
    if (!slot.enabled || (slot.allowedRoles && !slot.allowedRoles.includes(role))) continue;
    if (slot.kind !== "PINNED_VERSION" && NON_EXECUTABLE_V1_SOURCES.has(slot.sourceClass)) {
      rejected.push({ slotIndex, reason: "ROSTER_SOURCE_NOT_EXECUTABLE_V1" });
      continue;
    }
    const matching = catalog.filter((entry) => slot.kind === "PINNED_VERSION"
      ? entry.modelId === slot.modelId
      : slot.kind === "AUTO_CURRENT"
        ? entry.familyId === slot.familyId && entry.sourceClass === slot.sourceClass
        : entry.sourceClass === slot.sourceClass);
    const eligible = matching.filter((entry) => candidateAuthorized(entry, roster)
      && entry.available && (entry.lifecycle === "ACTIVE" || entry.lifecycle === "ACTIVE_ECONOMY" || (slot.kind === "PINNED_VERSION" && entry.lifecycle === "SUPERSEDED"))
      && entry.qualifiedRoles.includes(role)
      && (!context.privateCode || entry.dataPolicy.privateCode)
      && (!entry.dataPolicy.syntheticOnly || !context.privateCode)
      && (!entry.dataPolicy.userConsentRequired || context.userConsented));
    if (slot.kind === "PINNED_VERSION") {
      if (eligible[0] && NON_EXECUTABLE_V1_SOURCES.has(eligible[0].sourceClass)) rejected.push({ slotIndex, reason: "ROSTER_SOURCE_NOT_EXECUTABLE_V1" });
      else if (eligible[0]) candidates.push({ ...eligible[0], resolvedViaSlot: "PINNED_VERSION" });
      else {
        // Split the failure honestly: an authorized pin that is unavailable, retired, or
        // out of the executable lifecycle window is action-required; an authorized and
        // servable pin that only fails role/data-policy fit is role-ineligible.
        const pin = matching.find((entry) => candidateAuthorized(entry, roster) && !NON_EXECUTABLE_V1_SOURCES.has(entry.sourceClass));
        const unavailable = pin === undefined
          || !pin.available
          || pin.lifecycle === "RETIRED"
          || (pin.lifecycle !== "ACTIVE" && pin.lifecycle !== "ACTIVE_ECONOMY" && pin.lifecycle !== "SUPERSEDED");
        rejected.push({ slotIndex, reason: unavailable ? "PINNED_MODEL_UNAVAILABLE" : "PINNED_MODEL_ROLE_INELIGIBLE" });
      }
    } else if (slot.kind === "AUTO_CURRENT") {
      const current = eligible.find((entry) => entry.lifecycle === "ACTIVE");
      if (current) candidates.push({ ...current, resolvedViaSlot: "AUTO_CURRENT" });
      else rejected.push({ slotIndex, reason: "FAMILY_HAS_NO_CERTIFIED_CURRENT_MODEL" });
    } else {
      candidates.push(...eligible.map((entry) => ({ ...entry, resolvedViaSlot: "AUTO" as const })));
      if (eligible.length === 0) rejected.push({ slotIndex, reason: "AUTO_POOL_EMPTY_FOR_ROLE" });
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.modelId, candidate])).values()];
  return {
    status: unique.length > 0 ? "READY" : rejected.some((item) => item.reason === "PINNED_MODEL_UNAVAILABLE") ? "UNAVAILABLE_ACTION_REQUIRED" : "NO_ELIGIBLE_ROLE_MODEL",
    candidates: unique,
    rejected,
  };
}

export class ForgeAutoRosterStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  private key(ownerUserId: string): string {
    return `forgeauto-roster-${createHash("sha256").update(ownerUserId).digest("hex")}`;
  }

  async put(ownerUserId: string, roster: ForgeAutoRoster, catalog: readonly RosterCandidate[], policy?: RosterPolicy): Promise<ForgeAutoRoster> {
    if (ownerUserId !== roster.ownerUserId) throw new Error("ROSTER_OWNER_MISMATCH");
    validateForgeAutoRoster(roster, catalog, policy);
    const safe: ForgeAutoRoster = {
      ownerUserId, entitlement: roster.entitlement, updatedAt: roster.updatedAt,
      lead: roster.lead.mode === "MANUAL" ? { mode: "MANUAL", slotIndex: roster.lead.slotIndex } : { mode: roster.lead.mode },
      slots: roster.slots.map((slot) => slot.kind === "PINNED_VERSION"
        ? { kind: "PINNED_VERSION", modelId: slot.modelId, enabled: slot.enabled, ...(slot.allowedRoles ? { allowedRoles: [...slot.allowedRoles] } : {}) }
        : slot.kind === "AUTO_CURRENT"
          ? { kind: "AUTO_CURRENT", familyId: slot.familyId, sourceClass: slot.sourceClass, enabled: slot.enabled, ...(slot.allowedRoles ? { allowedRoles: [...slot.allowedRoles] } : {}) }
          : { kind: "AUTO", sourceClass: slot.sourceClass, enabled: slot.enabled, ...(slot.allowedRoles ? { allowedRoles: [...slot.allowedRoles] } : {}) }),
    };
    await this.persistence.upsertWorkItem({ id: this.key(ownerUserId), kind: "forgeauto_roster", ...safe } as unknown as WorkItem);
    return safe;
  }

  async get(ownerUserId: string): Promise<ForgeAutoRoster | undefined> {
    const item = await this.persistence.getWorkItem(this.key(ownerUserId));
    if (!item) return undefined;
    const { id: _id, kind: _kind, ...roster } = item as unknown as ForgeAutoRoster & { id: string; kind: string };
    if (roster.ownerUserId !== ownerUserId) throw new Error("ROSTER_OWNER_MISMATCH");
    return roster;
  }
}

export interface RosterUserRoute {
  sourceId: string;
  providerId: string;
  modelId: string;
  sourceClass: "USER_API";
  pinned: boolean;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  costConfidence: ShillingConfidence;
  priceSource?: string;
}

export interface RosterRouteAllowance {
  freeRoutes: readonly { providerId: string; modelId: string }[];
  paidModelIds: readonly PaidAutoCanonicalModelId[];
  userRoutes: readonly RosterUserRoute[];
  /**
   * R55 wave 2: bounded routing-decision evidence for append-only receipts. Populated only
   * when the resolving caller supplies audit identity — it carries candidate identity and
   * lifecycle only: never an endpoint URL, credentialRef, header, prompt, or body.
   */
  decision?: {
    ownerUserId: string;
    rosterUpdatedAt: string;
    role: RosterRole;
    candidates: Array<{
      modelId: string;
      providerId: string;
      providerModelId: string;
      familyId: string;
      version: string;
      sourceClass: IntelligenceSourceClass;
      lifecycle: RosterCandidate["lifecycle"];
    }>;
  };
}

export function rosterRouteAllowance(
  resolution: RosterResolution,
  audit?: { ownerUserId: string; rosterUpdatedAt: string; role: RosterRole },
): RosterRouteAllowance {
  return {
    freeRoutes: resolution.candidates.filter((candidate) => candidate.sourceClass === "MANAGED_FREE")
      .flatMap((candidate) => candidate.routes ?? [{ providerId: candidate.providerId, modelId: candidate.providerModelId }]),
    paidModelIds: resolution.candidates.filter((candidate) => candidate.sourceClass === "MANAGED_PAID").map((candidate) => candidate.modelId as PaidAutoCanonicalModelId),
    userRoutes: resolution.candidates.filter((candidate) => candidate.sourceClass === "USER_API")
      .map((candidate) => ({
        sourceId: candidate.sourceId ?? "",
        providerId: candidate.providerId,
        modelId: candidate.providerModelId,
        sourceClass: "USER_API" as const,
        pinned: candidate.resolvedViaSlot === "PINNED_VERSION",
        inputCostPerMillion: candidate.inputCostPerMillion ?? null,
        outputCostPerMillion: candidate.outputCostPerMillion ?? null,
        costConfidence: candidate.costConfidence ?? "UNKNOWN",
        ...(candidate.priceSource ? { priceSource: candidate.priceSource } : {}),
      })),
    ...(audit
      ? {
          decision: {
            ...audit,
            candidates: resolution.candidates.map((candidate) => ({
              modelId: candidate.modelId,
              providerId: candidate.providerId,
              providerModelId: candidate.providerModelId,
              familyId: candidate.familyId,
              version: candidate.version,
              sourceClass: candidate.sourceClass,
              lifecycle: candidate.lifecycle,
            })),
          },
        }
      : {}),
  };
}

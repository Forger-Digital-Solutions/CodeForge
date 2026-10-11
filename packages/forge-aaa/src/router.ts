import { forgeAaaSpecialty } from "./specialties.js";
import type { ForgeAaaDomain, ForgeAaaSpecialtyId } from "./types.js";

/**
 * Capability router (mission §6): specialty task → ordered eligible routes. The server
 * maps its roster catalog onto ForgeAaaRouteCandidate and translates the decision back
 * into a roster route allowance — dispatch itself stays on the proven path.
 */
export interface ForgeAaaRouteCandidate {
  modelId: string;
  providerId: string;
  providerModelId: string;
  domain: ForgeAaaDomain;
  lifecycle: string;
  available: boolean;
  qualifiedRoles: readonly string[];
  costClass: "free" | "paid" | "user";
  /** Roster privateCode flag — private project content may only go to flagged routes. */
  privateCodeAllowed: boolean;
  requiresConsent?: boolean;
}

export interface ForgeAaaRouteDecision {
  taskId: string;
  specialty: ForgeAaaSpecialtyId;
  role: string;
  outcome: "selected" | "no_eligible_route" | "specialty_unknown";
  selected?: ForgeAaaRouteCandidate;
  ordered: ForgeAaaRouteCandidate[];
  reasonCodes: string[];
  decidedAt: string;
}

const DOMAIN_ORDER: Record<ForgeAaaDomain, number> = {
  managed_free: 0,
  user_api: 1,
  managed_paid: 2,
  local_tool: 3,
  external_service: 4,
};

function domainRank(c: ForgeAaaRouteCandidate): number {
  // Local tools rank after model domains for reasoning work, but a task whose specialty is
  // adapter-executable prefers the local tool that can actually perform it — see the
  // candidate's qualifiedRoles/providerId shape supplied by the server.
  return DOMAIN_ORDER[c.domain];
}

/**
 * Route one specialty task. Eligibility is conjunctive: role-qualified + available +
 * lifecycle servable + data-policy fit. Order is domain preference (free first), then
 * stable identity. `preferIndependentFrom` nudges review/verify tasks away from the
 * implementer's route without forbidding same-pool fallback.
 */
export function routeForgeAaaTask(input: {
  taskId: string;
  specialty: ForgeAaaSpecialtyId;
  candidates: readonly ForgeAaaRouteCandidate[];
  privateCode?: boolean;
  userConsented?: boolean;
  /** Route identity `${providerId}/${modelId}` the implementer used — soft preference. */
  preferIndependentFrom?: string;
  now?: () => string;
}): ForgeAaaRouteDecision {
  const specialty = forgeAaaSpecialty(input.specialty);
  const decidedAt = (input.now ?? (() => new Date().toISOString()))();
  if (!specialty) {
    return { taskId: input.taskId, specialty: input.specialty, role: "CODER", outcome: "specialty_unknown", ordered: [], reasonCodes: ["SPECIALTY_UNKNOWN"], decidedAt };
  }
  const role = specialty.rosterRole;
  const reasonCodes: string[] = [];
  const eligible = input.candidates.filter((c) =>
    c.available
    && c.qualifiedRoles.includes(role)
    && c.lifecycle !== "RETIRED"
    && (!input.privateCode || c.privateCodeAllowed)
    && c.domain !== "external_service"
    && (!c.requiresConsent || input.userConsented === true));

  for (const c of input.candidates) {
    if (!c.available) reasonCodes.push(`EXCLUDED_UNAVAILABLE:${c.modelId}`);
    else if (!c.qualifiedRoles.includes(role)) reasonCodes.push(`EXCLUDED_ROLE:${c.modelId}`);
    else if (input.privateCode && !c.privateCodeAllowed) reasonCodes.push(`EXCLUDED_PRIVACY:${c.modelId}`);
  }

  const ordered = [...eligible].sort((a, b) => {
    const da = domainRank(a);
    const db = domainRank(b);
    if (da !== db) return da - db;
    return `${a.providerId}/${a.providerModelId}`.localeCompare(`${b.providerId}/${b.providerModelId}`);
  });

  if (input.preferIndependentFrom && ordered.length > 1) {
    ordered.sort((a, b) =>
      Number(`${a.providerId}/${a.providerModelId}` === input.preferIndependentFrom)
      - Number(`${b.providerId}/${b.providerModelId}` === input.preferIndependentFrom));
    reasonCodes.push("INDEPENDENT_POOL_PREFERRED");
  }

  const selected = ordered[0];
  return {
    taskId: input.taskId,
    specialty: input.specialty,
    role,
    outcome: selected ? "selected" : "no_eligible_route",
    ...(selected ? { selected } : {}),
    ordered,
    reasonCodes: selected ? [...reasonCodes, "ROUTE_SELECTED"] : [...reasonCodes, "NO_ELIGIBLE_ROUTE"],
    decidedAt,
  };
}

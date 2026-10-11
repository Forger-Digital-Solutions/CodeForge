import type { ForgeAaaDomain, ForgeAaaLeadIdentity, ForgeAaaLeadPolicyId } from "./types.js";

/**
 * One executable lead route, projected by the caller (server) from its live catalogs.
 * `upstreamProviderId` is the adapter the request physically dispatches through —
 * for managed-paid candidates that is the paid-auto domain adapter itself, so Paid
 * Auto's kill switch, budget gate, and telemetry apply unmodified.
 */
export interface ForgeAaaLeadRoute {
  domain: Exclude<ForgeAaaDomain, "local_tool" | "external_service">;
  upstreamProviderId: string;
  upstreamModelId: string;
  canonicalId?: string;
  displayName: string;
  costClass: "free" | "paid" | "user";
  qualifiedRoles: readonly string[];
  /** Present only when the route is verified-bound to a named lead candidate. */
  leadIdentity?: ForgeAaaLeadIdentity;
  contextWindow?: number;
  available: boolean;
  reasonCodes?: string[];
}

export interface ForgeAaaLeadEvidence {
  /** Measured quality 0..1 for this route in lead work; absent = unmeasured. */
  quality?: number;
  /** Measured reliability 0..1; absent = unmeasured. */
  reliability?: number;
  measuredAt?: string;
}

export interface ForgeAaaLeadResolution {
  outcome: "selected" | "no_eligible_lead" | "named_lead_unavailable" | "dual_lead_incomplete";
  policy: ForgeAaaLeadPolicyId;
  selected?: ForgeAaaLeadRoute;
  /** Dual Lead only — the independent verification seat. */
  verificationLead?: ForgeAaaLeadRoute;
  /** Full eligible rotation order for failover, best first. */
  ordered: ForgeAaaLeadRoute[];
  blockedReason?: string;
  /** Eligible substitutes offered when a named lead is unavailable (mission §3). */
  alternatives: ForgeAaaLeadRoute[];
}

const COST_PENALTY: Record<ForgeAaaLeadRoute["costClass"], number> = { free: 0, user: 5, paid: 25 };

function leadCapable(route: ForgeAaaLeadRoute): boolean {
  return route.available && route.qualifiedRoles.some((r) => r === "LEAD" || r === "PLANNER" || r === "CODER");
}

function score(route: ForgeAaaLeadRoute, evidence: Record<string, ForgeAaaLeadEvidence>, economy: boolean): number {
  const key = `${route.upstreamProviderId}/${route.upstreamModelId}`;
  const e = evidence[key];
  const quality = e?.quality ?? 0.5;
  const reliability = e?.reliability ?? 0.5;
  const base = quality * 100 + reliability * 20 - COST_PENALTY[route.costClass];
  // Economy orders by cost first; measured quality only breaks ties within a cost class.
  return economy ? -COST_PENALTY[route.costClass] * 100 + quality * 10 + reliability * 5 : base;
}

function orderRoutes(routes: ForgeAaaLeadRoute[], evidence: Record<string, ForgeAaaLeadEvidence>, economy: boolean): ForgeAaaLeadRoute[] {
  return [...routes].sort((a, b) => {
    const diff = score(b, evidence, economy) - score(a, evidence, economy);
    if (diff !== 0) return diff;
    return `${a.upstreamProviderId}/${a.upstreamModelId}`.localeCompare(`${b.upstreamProviderId}/${b.upstreamModelId}`);
  });
}

/**
 * Lead-policy resolution (mission §3). Named policies (sol-lead / opus-lead) require a
 * route bound to that identity via verified registry evidence — when absent the outcome
 * reports the named lead's actual status and the eligible alternatives instead of silently
 * substituting. Dual Lead resolves an independent second seat when two leads are eligible.
 */
export function resolveForgeAaaLead(
  policy: ForgeAaaLeadPolicyId,
  routes: readonly ForgeAaaLeadRoute[],
  evidence: Record<string, ForgeAaaLeadEvidence> = {},
): ForgeAaaLeadResolution {
  const eligible = routes.filter(leadCapable);

  if (policy === "sol-lead" || policy === "opus-lead") {
    const identity: ForgeAaaLeadIdentity = policy === "sol-lead" ? "sol" : "opus";
    const bound = eligible.find((r) => r.leadIdentity === identity);
    if (!bound) {
      return {
        outcome: "named_lead_unavailable",
        policy,
        ordered: orderRoutes(eligible, evidence, false),
        alternatives: orderRoutes(eligible, evidence, false),
        blockedReason: `Named lead "${policy}" has no verified route — provider model id/entitlement unverified.`,
      };
    }
    const ordered = [bound, ...orderRoutes(eligible.filter((r) => r !== bound), evidence, false)];
    return { outcome: "selected", policy, selected: bound, ordered, alternatives: ordered.slice(1) };
  }

  const economy = policy === "economy-lead";
  const ordered = orderRoutes(eligible, evidence, economy);
  const selected = ordered[0];
  if (!selected) {
    return { outcome: "no_eligible_lead", policy, ordered: [], alternatives: [], blockedReason: "No eligible lead-capable route in any authorized domain." };
  }
  if (policy === "dual-lead") {
    const verificationLead = ordered.find((r) => `${r.upstreamProviderId}/${r.upstreamModelId}` !== `${selected.upstreamProviderId}/${selected.upstreamModelId}`);
    if (!verificationLead) {
      return {
        outcome: "dual_lead_incomplete", policy, selected, ordered, alternatives: [],
        blockedReason: "Dual Lead requires two distinct eligible leads; only one is available.",
      };
    }
    return { outcome: "selected", policy, selected, verificationLead, ordered, alternatives: ordered.slice(2) };
  }
  return { outcome: "selected", policy, selected, ordered, alternatives: ordered.slice(1) };
}

export const FORGE_AAA_LEAD_POLICIES: readonly { id: ForgeAaaLeadPolicyId; displayName: string; description: string }[] = [
  { id: "auto", displayName: "Auto Lead", description: "Strongest eligible lead per task — measured quality, availability, and cost." },
  { id: "sol-lead", displayName: "Sol Lead", description: "Prefer GPT-6.1 Sol. Routes only when a verified binding exists." },
  { id: "opus-lead", displayName: "Opus Lead", description: "Prefer Claude Opus 5.5. Routes only when a verified binding exists." },
  { id: "dual-lead", displayName: "Dual Lead", description: "Two distinct leads: one plans/executes, the other independently verifies." },
  { id: "economy-lead", displayName: "Economy Lead", description: "Prefer lowest-cost capable routes; escalate only when necessary." },
];

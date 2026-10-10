import { createHash } from "node:crypto";

export const PERSONAL_ROUTING_SETTINGS_KEY = "codeforge:personal-provider-routing:v1";
export const PERSONAL_ROUTING_MODES = ["FREE_ONLY", "FREE_PREFERRED", "PAID_PREFERRED", "SPECIFIC_ACCOUNT", "AUTO_BEST"] as const;

export interface PersonalProviderRoutingPolicy {
  mode: (typeof PERSONAL_ROUTING_MODES)[number];
  paidEnabled: boolean;
  explicitConsent: boolean;
  limitationsAcknowledged: boolean;
  specificAccountConnectionId?: string;
  automaticTopUp: false;
}

export function defaultPersonalProviderRoutingPolicy(): PersonalProviderRoutingPolicy {
  return { mode: "FREE_ONLY", paidEnabled: false, explicitConsent: false, limitationsAcknowledged: false, automaticTopUp: false };
}

export function parsePersonalProviderRoutingPolicy(value: unknown): PersonalProviderRoutingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PERSONAL_ROUTING_POLICY_INVALID");
  const raw = value as Record<string, unknown>;
  if (!PERSONAL_ROUTING_MODES.includes(raw.mode as PersonalProviderRoutingPolicy["mode"])) throw new Error("PERSONAL_ROUTING_MODE_INVALID");
  for (const field of ["paidEnabled", "explicitConsent", "limitationsAcknowledged"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "boolean") throw new Error("PERSONAL_ROUTING_POLICY_INVALID");
  }
  if (raw.automaticTopUp !== undefined && raw.automaticTopUp !== false) throw new Error("PERSONAL_AUTOMATIC_TOP_UP_UNSUPPORTED");
  const mode = raw.mode as PersonalProviderRoutingPolicy["mode"];
  const id = raw.specificAccountConnectionId;
  if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) throw new Error("PERSONAL_ROUTING_ACCOUNT_INVALID");
  if (mode === "SPECIFIC_ACCOUNT" && !id) throw new Error("PERSONAL_ROUTING_ACCOUNT_REQUIRED");
  const paidEnabled = mode !== "FREE_ONLY" && raw.paidEnabled === true;
  if (paidEnabled && (raw.explicitConsent !== true || raw.limitationsAcknowledged !== true)) throw new Error("PERSONAL_PAID_CONSENT_REQUIRED");
  return {
    mode, paidEnabled, explicitConsent: paidEnabled && raw.explicitConsent === true,
    limitationsAcknowledged: paidEnabled && raw.limitationsAcknowledged === true,
    ...(typeof id === "string" && mode === "SPECIFIC_ACCOUNT" ? { specificAccountConnectionId: id } : {}),
    automaticTopUp: false,
  };
}

export function personalRoutingOwnerKey(ownerUserId: string): string {
  if (!ownerUserId.trim()) throw new Error("PERSONAL_ROUTING_OWNER_REQUIRED");
  return createHash("sha256").update(`personal-routing\0${ownerUserId}`).digest("hex");
}

export function readPersonalProviderRoutingPolicy(settings: Record<string, unknown>, ownerUserId: string): PersonalProviderRoutingPolicy {
  if (!ownerUserId) return defaultPersonalProviderRoutingPolicy();
  const stored = settings[PERSONAL_ROUTING_SETTINGS_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return defaultPersonalProviderRoutingPolicy();
  const raw = (stored as Record<string, unknown>)[personalRoutingOwnerKey(ownerUserId)];
  try { return raw ? parsePersonalProviderRoutingPolicy(raw) : defaultPersonalProviderRoutingPolicy(); }
  catch { return defaultPersonalProviderRoutingPolicy(); }
}

export function writePersonalProviderRoutingPolicy(settings: Record<string, unknown>, ownerUserId: string, value: unknown): Record<string, unknown> {
  const parsed = parsePersonalProviderRoutingPolicy(value);
  const stored = settings[PERSONAL_ROUTING_SETTINGS_KEY];
  return { ...settings, [PERSONAL_ROUTING_SETTINGS_KEY]: {
    ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}),
    [personalRoutingOwnerKey(ownerUserId)]: parsed,
  } };
}

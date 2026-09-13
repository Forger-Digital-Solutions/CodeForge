import {
  PROVIDER_DEFINITIONS,
  isZeroCashFreeAccess,
  type ProviderDefinition,
} from "./provider-definitions.js";

/**
 * Environment-credential discovery (R1 §18-§25).
 *
 * Detects provider credentials that already exist as ENVIRONMENT VARIABLES — never by scanning
 * files, shell history, or clipboards. The output is names + presence only; secret VALUES are
 * never copied into these records, so the result is safe to hand to a renderer, a log, or a
 * certification report. The trusted process resolves the live value at call time via
 * {@link resolveEnvironmentField}.
 */

export interface EnvironmentPresence {
  /** Presence check for one variable. Implementations must not log the value. */
  has(name: string): boolean;
}

export function presenceFromEnv(env: Readonly<Record<string, string | undefined>>, maxLength = 4096): EnvironmentPresence {
  return {
    has(name) {
      const v = env[name];
      return typeof v === "string" && v.trim().length > 0 && v.length <= maxLength;
    },
  };
}

export interface DetectedEnvironmentField {
  fieldId: string;
  label: string;
  secret: boolean;
  optional: boolean;
  /** The alias that was found (first match in declaration order), or null when absent. */
  variable: string | null;
  /** Every alias this field accepts, for display. */
  aliases: string[];
  detected: boolean;
}

export interface DetectedEnvironmentCredential {
  providerId: string;
  displayName: string;
  /** True when every required field is present in the environment. */
  complete: boolean;
  /** True when at least one field is present (partial config, e.g. Cloudflare token without account id). */
  anyDetected: boolean;
  fields: DetectedEnvironmentField[];
  /** Whether the provider's free-access class is zero-cash (candidate for ForgeAuto/Free). */
  zeroCashFreeAccess: boolean;
  /** Whether the provider is paid-only (usable for BYOK only, never ForgeAuto/Free). */
  paidOnly: boolean;
}

/**
 * Detect provider credentials present in the environment. Pure over `presence`; returns a record
 * per provider definition that declares at least one environment alias.
 */
export function detectEnvironmentCredentials(
  presence: EnvironmentPresence,
  definitions: Record<string, ProviderDefinition> = PROVIDER_DEFINITIONS,
): DetectedEnvironmentCredential[] {
  const out: DetectedEnvironmentCredential[] = [];
  for (const def of Object.values(definitions)) {
    const declared = def.connection.fields.filter((f) => f.environmentAliases.length > 0);
    if (declared.length === 0) continue;
    const fields: DetectedEnvironmentField[] = declared.map((f) => {
      const variable = f.environmentAliases.find((name) => presence.has(name)) ?? null;
      return {
        fieldId: f.id,
        label: f.label,
        secret: f.secret,
        optional: f.optional === true,
        variable,
        aliases: [...f.environmentAliases],
        detected: variable !== null,
      };
    });
    const complete = fields.every((f) => f.detected || f.optional);
    const anyDetected = fields.some((f) => f.detected);
    out.push({
      providerId: def.id,
      displayName: def.displayName,
      complete,
      anyDetected,
      fields,
      zeroCashFreeAccess: isZeroCashFreeAccess(def.freeAccess.class),
      paidOnly: def.paidOnly === true || def.freeAccess.class === "PAID_API",
    });
  }
  return out;
}

/** Global policy for consuming detected environment credentials (R1 §23). */
export type EnvironmentCredentialPolicy = "OFF" | "FREE_ROUTES_ONLY" | "ALL_ENABLED_BYOK_ROUTES";

export const DEFAULT_ENVIRONMENT_CREDENTIAL_POLICY: EnvironmentCredentialPolicy = "FREE_ROUTES_ONLY";

/** Persisted per-provider preference: which variable to read and whether it is enabled. Never the value. */
export interface EnvironmentCredentialPreference {
  providerId: string;
  /** Variable chosen per field id (or the first detected alias when omitted). */
  variables?: Record<string, string>;
  enabled: boolean;
  /** ISO time the user toggled this preference. */
  updatedAt?: string;
}

/**
 * Resolve the live value of one field from the environment for an ENABLED preference. Returns
 * undefined when the preference is disabled, the policy is OFF, or the variable is absent — an
 * environment variable that disappears makes the connection "credential unavailable", never a
 * silently retained copy.
 */
export function resolveEnvironmentField(
  env: Readonly<Record<string, string | undefined>>,
  def: ProviderDefinition,
  fieldId: string,
  preference: EnvironmentCredentialPreference | undefined,
  policy: EnvironmentCredentialPolicy,
  maxLength = 4096,
): string | undefined {
  if (policy === "OFF") return undefined;
  if (!preference || !preference.enabled || preference.providerId !== def.id) return undefined;
  const isPaid = def.paidOnly === true || def.freeAccess.class === "PAID_API";
  if (policy === "FREE_ROUTES_ONLY" && isPaid) return undefined;
  const field = def.connection.fields.find((f) => f.id === fieldId);
  if (!field) return undefined;
  const chosen = preference.variables?.[fieldId];
  const candidates = chosen && field.environmentAliases.includes(chosen) ? [chosen, ...field.environmentAliases] : field.environmentAliases;
  for (const name of candidates) {
    const v = env[name];
    if (typeof v === "string" && v.trim().length > 0 && v.length <= maxLength) return v.trim();
  }
  return undefined;
}

/**
 * Migration (R1 §187): providers whose environment credential CodeForge consumed implicitly
 * before R1 keep working without re-entry. Only these zero-unit providers are enabled by default;
 * every other detected credential starts disabled and is offered in Settings.
 */
export const LEGACY_IMPLICIT_ENV_PROVIDERS: readonly string[] = ["opencode", "openrouter", "zai"];

export function defaultEnvironmentPreferences(
  detected: DetectedEnvironmentCredential[],
  now: () => Date = () => new Date(),
): EnvironmentCredentialPreference[] {
  return detected
    .filter((d) => d.complete && LEGACY_IMPLICIT_ENV_PROVIDERS.includes(d.providerId))
    .map((d) => ({ providerId: d.providerId, enabled: true, updatedAt: now().toISOString() }));
}

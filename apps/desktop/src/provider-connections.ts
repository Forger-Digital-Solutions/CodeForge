import type { CredentialStore, ProviderAdapter, ProviderModel, ProviderCatalog, ProviderResponseObserver } from "@codeforge/providers";
import { configFieldKey, createProviderAdapterFromDefinition, InMemoryProviderCatalog } from "@codeforge/providers";
import type { ForgeZero } from "@codeforge/forge-zero";
import type {
  ConnectResult,
  EnvironmentCredentialView,
  FirstRunOffer,
  ProviderCatalogModelView,
  ProviderConnectionView,
} from "./provider-connection-types.js";
export type { ConnectResult, EnvironmentCredentialView, FirstRunOffer, ProviderCatalogModelView, ProviderConnectionView } from "./provider-connection-types.js";
import {
  DEFAULT_ENVIRONMENT_CREDENTIAL_POLICY,
  LEGACY_IMPLICIT_ENV_PROVIDERS,
  AUTH_CLASS_FRICTION,
  canonicalIdentityFor,
  detectEnvironmentCredentials,
  defaultEnvironmentPreferences,
  presenceFromEnv,
  resolveEnvironmentField,
  isZeroCashFreeAccess,
  type DetectedEnvironmentCredential,
  type EnvironmentCredentialPolicy,
  type EnvironmentCredentialPreference,
  type FreeCloudService,
  type ProviderConnectionState,
  type ProviderDefinition,
  type CredentialSource,
} from "@codeforge/model-registry";
import {
  buildGeminiFreeAcceptance,
  evaluateGeminiFreePolicy,
  type GeminiFreeAcceptanceRecord,
  type RegionResolution,
  REGION_UNKNOWN,
} from "@codeforge/legal-policy";

/**
 * Desktop provider connections (R1 §13-§31, §59-§64, §97-§99, §104-§106).
 *
 * Trusted-process authority for how a provider gets its credential:
 *
 *   explicit secure connection (OAuth / manual key, safeStorage-encrypted)
 *     > enabled environment credential (live `process.env` read, value never persisted)
 *     > nothing (connect offer)
 *
 * The renderer only ever sees variable NAMES, connection state, and catalogs. No secret value
 * crosses IPC out of this module. Pure over an injected {@link ProviderConnectionsHost} so it is
 * unit-testable without Electron.
 */

export const ENV_CREDENTIALS_KEY = "codeforge:env-credentials";
export const CREDENTIAL_SOURCES_KEY = "codeforge:provider-credential-sources";
export const PLAN_ATTESTATIONS_KEY = "codeforge:provider-plan-attestations";
export const ENABLED_MODELS_KEY = "codeforge:provider-enabled-models";
export const GEMINI_FREE_ACCEPTANCE_KEY = "codeforge:gemini-free-policy-acceptance";

export interface EnvCredentialSettings {
  policy: EnvironmentCredentialPolicy;
  preferences: Record<string, EnvironmentCredentialPreference>;
  migratedAt?: string;
}

export interface ProviderConnectionsHost {
  readSettings(): Record<string, unknown>;
  writeSettings(settings: Record<string, unknown>): void;
  /** Encrypted secret store keyed by providerId or `${providerId}:${fieldId}` (plaintext in/out). */
  secrets: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    keys(): string[];
  };
  env(): Readonly<Record<string, string | undefined>>;
  providerCatalog: ProviderCatalog;
  firewall: ForgeZero;
  freeCloud: FreeCloudService;
  /** Live free-model discovery for a registered provider (existing desktop path). */
  discoverProviderFree(providerId: string): Promise<number>;
  /** Auth state observed by discovery (401 → auth_required). */
  providerAuthState(providerId: string): "ok" | "auth_required" | "rate_limited" | undefined;
  onResponse?: ProviderResponseObserver;
  now?: () => Date;
  maxSecretLength?: number;
  /** Emit a change notification (renderer refresh). */
  notifyChanged?: () => void;
  /** Trusted server/OS-sourced Gemini identity and region. Absent means fail closed. */
  geminiPolicyContext?: () => { accountId?: string; region: RegionResolution };
}

const CONNECTABLE_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;

export class ProviderConnections {
  private readonly host: ProviderConnectionsHost;
  private readonly now: () => Date;

  constructor(host: ProviderConnectionsHost) {
    this.host = host;
    this.now = host.now ?? (() => new Date());
  }

  // --- definitions -----------------------------------------------------------------------------

  definitions(): Record<string, ProviderDefinition> {
    return this.host.freeCloud.getDefinitions();
  }

  definition(providerId: string): ProviderDefinition | undefined {
    return this.definitions()[providerId];
  }

  /** Renderer-safe provider definition list (schemas, never values). */
  listDefinitions(): Array<Pick<ProviderConnectionView, "providerId" | "displayName" | "kind" | "implemented" | "recommendedForFreeDefault" | "authClasses" | "fields" | "freeAccess" | "privacy" | "terms" | "policyMetadata" | "keyUrl" | "docsUrl" | "paidOnly" | "zeroCashFreeAccess">> {
    return Object.values(this.definitions())
      .filter((d) => d.apiStyle !== "internal")
      .map((d) => this.definitionView(d));
  }

  private definitionView(d: ProviderDefinition) {
    return {
      providerId: d.id,
      displayName: d.displayName,
      kind: d.kind,
      implemented: d.implemented,
      recommendedForFreeDefault: d.recommendedForFreeDefault,
      authClasses: d.authClasses,
      fields: d.connection.fields.map((f) => ({ id: f.id, label: f.label, secret: f.secret, optional: f.optional === true, help: f.help, environmentAliases: [...f.environmentAliases] })),
      freeAccess: d.freeAccess,
      privacy: d.privacy,
      terms: d.terms,
      policyMetadata: d.policyMetadata,
      keyUrl: d.keyUrl,
      docsUrl: d.docsUrl,
      paidOnly: d.paidOnly === true || d.freeAccess.class === "PAID_API",
      zeroCashFreeAccess: isZeroCashFreeAccess(d.freeAccess.class),
    };
  }

  // --- environment credentials ------------------------------------------------------------------

  envSettings(): EnvCredentialSettings {
    const raw = this.host.readSettings()[ENV_CREDENTIALS_KEY];
    const out: EnvCredentialSettings = { policy: DEFAULT_ENVIRONMENT_CREDENTIAL_POLICY, preferences: {} };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    const r = raw as Record<string, unknown>;
    if (r.policy === "OFF" || r.policy === "FREE_ROUTES_ONLY" || r.policy === "ALL_ENABLED_BYOK_ROUTES") out.policy = r.policy;
    if (typeof r.migratedAt === "string") out.migratedAt = r.migratedAt;
    if (typeof r.preferences === "object" && r.preferences !== null && !Array.isArray(r.preferences)) {
      for (const [providerId, pref] of Object.entries(r.preferences as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(this.definitions(), providerId)) continue;
        if (typeof pref !== "object" || pref === null) continue;
        const p = pref as Record<string, unknown>;
        const variables: Record<string, string> = {};
        if (typeof p.variables === "object" && p.variables !== null) {
          for (const [fieldId, name] of Object.entries(p.variables as Record<string, unknown>)) {
            if (typeof name === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(name)) variables[fieldId] = name;
          }
        }
        out.preferences[providerId] = {
          providerId,
          enabled: p.enabled === true,
          variables: Object.keys(variables).length > 0 ? variables : undefined,
          updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : undefined,
        };
      }
    }
    return out;
  }

  private saveEnvSettings(next: EnvCredentialSettings): void {
    const settings = this.host.readSettings();
    settings[ENV_CREDENTIALS_KEY] = next;
    this.host.writeSettings(settings);
  }

  /**
   * One-time migration (R1 §187): environment credentials CodeForge consumed implicitly before
   * R1 (OpenRouter/OpenCode/Z.AI) stay enabled; everything else starts disabled and is offered
   * in Settings. Idempotent — runs once per profile.
   */
  migrateEnvironmentPreferences(): boolean {
    const current = this.envSettings();
    if (current.migratedAt) return false;
    const detected = detectEnvironmentCredentials(presenceFromEnv(this.host.env(), this.host.maxSecretLength), this.definitions());
    for (const pref of defaultEnvironmentPreferences(detected, this.now)) {
      if (!current.preferences[pref.providerId]) current.preferences[pref.providerId] = pref;
    }
    current.migratedAt = this.now().toISOString();
    this.saveEnvSettings(current);
    return true;
  }

  detectEnvironment(): DetectedEnvironmentCredential[] {
    return detectEnvironmentCredentials(presenceFromEnv(this.host.env(), this.host.maxSecretLength), this.definitions());
  }

  listEnvironmentCredentials(): EnvironmentCredentialView[] {
    const settings = this.envSettings();
    return this.detectEnvironment()
      .filter((d) => d.anyDetected || settings.preferences[d.providerId]?.enabled)
      .map((d) => {
        const pref = settings.preferences[d.providerId];
        const def = this.definition(d.providerId);
        const paid = def?.paidOnly === true || def?.freeAccess.class === "PAID_API";
        const policyBlocked = settings.policy === "OFF" || (settings.policy === "FREE_ROUTES_ONLY" && paid);
        return {
          ...d,
          enabled: pref?.enabled === true,
          active: this.credentialSourceOf(d.providerId) === "ENVIRONMENT",
          policyBlocked,
          policyBlockedReason: settings.policy === "OFF"
            ? "Environment credentials are turned off"
            : policyBlocked
              ? "Paid provider — not used by ForgeAuto/Free (enable BYOK routes to use it)"
              : undefined,
        };
      });
  }

  getEnvironmentPolicy(): EnvironmentCredentialPolicy {
    return this.envSettings().policy;
  }

  async setEnvironmentPolicy(policy: EnvironmentCredentialPolicy): Promise<void> {
    const current = this.envSettings();
    current.policy = policy;
    this.saveEnvSettings(current);
    await this.reconcileAll();
  }

  async setEnvironmentEnabled(providerId: string, enabled: boolean, variables?: Record<string, string>): Promise<void> {
    if (!this.definition(providerId)) throw new Error("Unknown provider");
    const current = this.envSettings();
    current.preferences[providerId] = {
      providerId,
      enabled,
      variables: variables && Object.keys(variables).length > 0 ? variables : current.preferences[providerId]?.variables,
      updatedAt: this.now().toISOString(),
    };
    this.saveEnvSettings(current);
    await this.reconcile(providerId);
  }

  /** Explicit user action (R1 §62): copy the live environment value into secure storage. */
  async importEnvironmentToSecureStorage(providerId: string): Promise<{ ok: boolean; error?: string }> {
    const def = this.definition(providerId);
    if (!def) return { ok: false, error: "Unknown provider" };
    const settings = this.envSettings();
    const pref = settings.preferences[providerId] ?? { providerId, enabled: true };
    const values: Record<string, string> = {};
    for (const field of def.connection.fields) {
      const v = resolveEnvironmentField(this.host.env(), def, field.id, { ...pref, enabled: true }, "ALL_ENABLED_BYOK_ROUTES", this.host.maxSecretLength);
      if (v) values[field.id] = v;
      else if (!field.optional) return { ok: false, error: `${field.label} is not present in the environment` };
    }
    this.storeFields(def, values, "SECURE_STORAGE");
    await this.reconcile(providerId);
    return { ok: true };
  }

  // --- credential resolution --------------------------------------------------------------------

  private environmentValue(def: ProviderDefinition, fieldId: string): string | undefined {
    const settings = this.envSettings();
    return resolveEnvironmentField(this.host.env(), def, fieldId, settings.preferences[def.id], settings.policy, this.host.maxSecretLength);
  }

  /** Resolve one connection field: explicit secure storage first, then an enabled env credential. */
  resolveField(providerId: string, fieldId: string): { value: string; source: CredentialSource; variable?: string } | undefined {
    const def = this.definition(providerId);
    if (!def) return undefined;
    const stored = fieldId === "apiKey" ? this.host.secrets.get(providerId) : this.host.secrets.get(configFieldKey(providerId, fieldId)) ?? (providerId === "cloudflare-workers-ai" && fieldId === "accountId" ? this.host.secrets.get("cloudflare-account-id") : undefined);
    if (stored) return { value: stored, source: this.storedSource(providerId) };
    const envValue = this.environmentValue(def, fieldId);
    if (envValue) {
      const field = def.connection.fields.find((f) => f.id === fieldId);
      const pref = this.envSettings().preferences[providerId];
      const variable = pref?.variables?.[fieldId] ?? field?.environmentAliases.find((name) => {
        const v = this.host.env()[name];
        return typeof v === "string" && v.trim().length > 0;
      });
      return { value: envValue, source: "ENVIRONMENT", variable };
    }
    return undefined;
  }

  private storedSource(providerId: string): CredentialSource {
    const raw = this.host.readSettings()[CREDENTIAL_SOURCES_KEY];
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const v = (raw as Record<string, unknown>)[providerId];
      if (v === "OAUTH" || v === "MANUAL_BYOK" || v === "SECURE_STORAGE" || v === "DEVICE_CODE") return v;
    }
    return "SECURE_STORAGE";
  }

  private setStoredSource(providerId: string, source: CredentialSource | null): void {
    const settings = this.host.readSettings();
    const raw = settings[CREDENTIAL_SOURCES_KEY];
    const map: Record<string, string> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, string>) } : {};
    if (source) map[providerId] = source;
    else delete map[providerId];
    settings[CREDENTIAL_SOURCES_KEY] = map;
    this.host.writeSettings(settings);
  }

  credentialSourceOf(providerId: string): CredentialSource {
    const def = this.definition(providerId);
    if (!def) return "NONE";
    if (def.apiStyle === "hosted") return this.host.providerCatalog.get(providerId) ? "FDS_GATEWAY" : "NONE";
    const required = def.connection.fields.filter((f) => !f.optional);
    if (required.length === 0) return "NONE";
    const resolved = required.map((f) => this.resolveField(providerId, f.id));
    if (resolved.some((r) => !r)) return "NONE";
    if (resolved.every((r) => r!.source === "ENVIRONMENT")) return "ENVIRONMENT";
    return resolved.find((r) => r!.source !== "ENVIRONMENT")!.source;
  }

  /** Credential store view handed to provider adapters: composite of secure storage + enabled env. */
  credentialStore(): CredentialStore {
    return {
      get: (key: string): string | undefined => {
        const idx = key.indexOf(":");
        if (idx > 0) {
          const providerId = key.slice(0, idx);
          const fieldId = key.slice(idx + 1);
          return this.resolveField(providerId, fieldId)?.value;
        }
        if (key === "cloudflare-account-id") return this.resolveField("cloudflare-workers-ai", "accountId")?.value;
        return this.resolveField(key, "apiKey")?.value;
      },
      set: (key: string, value: string): void => {
        this.host.secrets.set(key, value);
      },
      delete: (key: string): boolean => {
        this.host.secrets.delete(key);
        return true;
      },
      has(key: string): boolean {
        return this.get(key) !== undefined;
      },
    };
  }

  // --- plan attestation (allowance providers with account-dependent spillover) ------------------

  planAttested(providerId: string): boolean {
    const raw = this.host.readSettings()[PLAN_ATTESTATIONS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const v = (raw as Record<string, unknown>)[providerId];
    return typeof v === "object" && v !== null && (v as { freePlan?: unknown }).freePlan === true;
  }

  geminiFreeAcceptance(): GeminiFreeAcceptanceRecord | null {
    const raw = this.host.readSettings()[GEMINI_FREE_ACCEPTANCE_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const v = raw as Record<string, unknown>;
    if (v.providerId !== "google" || v.serviceTier !== "FREE") return null;
    if (typeof v.accountId !== "string" || typeof v.policyRevision !== "string" || typeof v.acceptedAt !== "string") return null;
    if (typeof v.disclosureVersion !== "string" || typeof v.termsEffectiveAt !== "string" || typeof v.regionStatus !== "string" || typeof v.regionSource !== "string") return null;
    if (v.regionCountryCode !== null && typeof v.regionCountryCode !== "string") return null;
    return v as unknown as GeminiFreeAcceptanceRecord;
  }

  geminiFreePolicyContext(): { accountId?: string; region: RegionResolution } {
    return this.host.geminiPolicyContext?.() ?? { region: REGION_UNKNOWN };
  }

  async setGeminiFreePolicyAccepted(accepted: boolean): Promise<void> {
    const settings = this.host.readSettings();
    if (!accepted) {
      delete settings[GEMINI_FREE_ACCEPTANCE_KEY];
      this.host.writeSettings(settings);
      await this.reconcile("google");
      return;
    }
    const context = this.geminiFreePolicyContext();
    const accountId = context.accountId?.trim();
    if (!accountId) throw new Error("Gemini free routing requires a trusted project/account identity");
    const regionDecision = evaluateGeminiFreePolicy({ accountId, region: context.region, acceptance: null, now: this.now() });
    if (regionDecision.reasonCode !== "GEMINI_FREE_POLICY_NOT_ACCEPTED") throw new Error(`Gemini free routing is blocked: ${regionDecision.reasonCode}`);
    settings[GEMINI_FREE_ACCEPTANCE_KEY] = buildGeminiFreeAcceptance({ accountId, region: context.region, now: this.now() });
    this.host.writeSettings(settings);
    await this.reconcile("google");
  }

  /** Dynamic gate shared by every Google adapter and the free-cloud admission snapshot. */
  geminiPolicyGate() {
    return {
      evaluate: () => {
        const context = this.geminiFreePolicyContext();
        return evaluateGeminiFreePolicy({ accountId: context.accountId, region: context.region, acceptance: this.geminiFreeAcceptance(), now: this.now() });
      },
    };
  }

  async setPlanAttested(providerId: string, attested: boolean): Promise<void> {
    if (!this.definition(providerId)) throw new Error("Unknown provider");
    const settings = this.host.readSettings();
    const raw = settings[PLAN_ATTESTATIONS_KEY];
    const map: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    if (attested) map[providerId] = { freePlan: true, attestedAt: this.now().toISOString() };
    else delete map[providerId];
    settings[PLAN_ATTESTATIONS_KEY] = map;
    this.host.writeSettings(settings);
    await this.reconcile(providerId);
  }

  // --- enabled models (ZCode-style explicit model selection) --------------------------------------

  enabledModels(providerId: string): string[] | null {
    const raw = this.host.readSettings()[ENABLED_MODELS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const v = (raw as Record<string, unknown>)[providerId];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  }

  setEnabledModels(providerId: string, modelIds: string[] | null): void {
    if (!this.definition(providerId)) throw new Error("Unknown provider");
    const settings = this.host.readSettings();
    const raw = settings[ENABLED_MODELS_KEY];
    const map: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    if (modelIds) map[providerId] = modelIds.filter((m) => typeof m === "string" && m.length <= 200).slice(0, 500);
    else delete map[providerId];
    settings[ENABLED_MODELS_KEY] = map;
    this.host.writeSettings(settings);
    this.host.notifyChanged?.();
  }

  // --- connect / validate / disconnect ----------------------------------------------------------

  private validateFields(def: ProviderDefinition, fields: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    const max = this.host.maxSecretLength ?? 512;
    for (const field of def.connection.fields) {
      const raw = fields[field.id];
      if (raw === undefined || raw === null || raw === "") {
        if (field.optional) continue;
        throw new Error(`${field.label} is required`);
      }
      if (typeof raw !== "string" || raw.length > max || !CONNECTABLE_FIELD_RE.test(field.id)) throw new Error(`${field.label} is invalid`);
      if (/[\r\n\t]/.test(raw)) throw new Error(`${field.label} is invalid`);
      out[field.id] = raw.trim();
    }
    return out;
  }

  private storeFields(def: ProviderDefinition, values: Record<string, string>, source: CredentialSource): void {
    for (const field of def.connection.fields) {
      const v = values[field.id];
      if (!v) continue;
      if (field.id === "apiKey") this.host.secrets.set(def.id, v);
      else this.host.secrets.set(configFieldKey(def.id, field.id), v);
      if (def.id === "cloudflare-workers-ai" && field.id === "accountId") this.host.secrets.set("cloudflare-account-id", v);
    }
    this.setStoredSource(def.id, source);
  }

  /** Build a throwaway adapter over explicit values — used by Validate, never registered. */
  private ephemeralAdapter(def: ProviderDefinition, values: Record<string, string>): ProviderAdapter | undefined {
    const store: CredentialStore = {
      get: (key) => {
        if (key === def.id) return values.apiKey;
        if (key === "cloudflare-account-id") return values.accountId;
        const idx = key.indexOf(":");
        return idx > 0 ? values[key.slice(idx + 1)] : undefined;
      },
      set: () => undefined,
      delete: () => true,
      has: (key) => store.get(key) !== undefined,
    };
    return createProviderAdapterFromDefinition(def, { credentialStore: store, timeoutMs: 20_000, onResponse: this.host.onResponse, geminiFreePolicyGate: def.id === "google" ? this.geminiPolicyGate() : undefined });
  }

  private classifyCatalog(def: ProviderDefinition, models: ProviderModel[]): ProviderCatalogModelView[] {
    const enabled = this.enabledModels(def.id);
    const zeroCash = isZeroCashFreeAccess(def.freeAccess.class) && def.terms.status === "CLEARED";
    const geminiPolicy = def.id === "google" ? this.geminiPolicyGate().evaluate() : undefined;
    return models
      .filter((m) => !/whisper|embed|tts|guard|moderation|rerank|orpheus|lyria|image|veo/i.test(m.modelId))
      .map((m) => {
        let free = false;
        let freeReason = "Paid";
        if (def.paidOnly || def.freeAccess.class === "PAID_API") {
          freeReason = "Paid provider";
        } else if (m.isFree && zeroCash && (!geminiPolicy || geminiPolicy.decision === "ALLOW")) {
          free = true;
          freeReason = "$0 listed by provider";
        } else if (zeroCash && def.freeAccess.allowanceScope === "all_chat_models" && (!geminiPolicy || geminiPolicy.decision === "ALLOW")) {
          free = true;
          freeReason = `Free allowance (${def.freeAccess.class})`;
        } else if (geminiPolicy && geminiPolicy.decision !== "ALLOW") {
          freeReason = `Gemini free policy gate: ${geminiPolicy.reasonCode}`;
        } else if (zeroCash && def.freeAccess.allowanceScope === "allowlist") {
          if (def.freeAccess.paidPlanModels?.includes(m.modelId)) freeReason = "Requires paid plan";
          else if (def.freeAccess.allowanceModels?.includes(m.modelId)) {
            free = true;
            freeReason = "Free plan allocation";
          } else freeReason = "Not covered by free allocation";
        } else if (def.freeAccess.class === "PROMOTIONAL_CREDIT") {
          freeReason = "Promotional credit — not ForgeAuto/Free";
        } else if (def.freeAccess.class === "FREE_DEV_ENDPOINT") {
          freeReason = "Development endpoint — not ForgeAuto/Free";
        } else if (def.terms.status !== "CLEARED") {
          freeReason = "Legal review required";
        }
        return {
          modelId: m.modelId,
          canonicalId: canonicalIdentityFor(def.id, m.modelId, m.displayName).canonicalId,
          displayName: canonicalIdentityFor(def.id, m.modelId, m.displayName).displayName,
          free,
          freeReason,
          toolCalling: m.capabilities.toolCalling,
          contextWindow: m.contextWindow,
          enabled: enabled ? enabled.includes(m.modelId) : true,
        };
      });
  }

  /**
   * ZCode-style Validate: check the credential against the provider's cheapest non-billable
   * endpoint (`/models`) and return the classified catalog so the model dropdown can populate.
   * Nothing is persisted.
   */
  async validate(providerId: string, fields: Record<string, unknown>): Promise<ConnectResult> {
    const def = this.definition(providerId);
    if (!def || !def.implemented) return { ok: false, error: "Provider is not supported" };
    let values: Record<string, string>;
    try {
      values = this.validateFields(def, fields);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Invalid input" };
    }
    const adapter = this.ephemeralAdapter(def, values);
    if (!adapter) return { ok: false, error: "No adapter for this provider" };
    try {
      const models = await adapter.listModels();
      return { ok: true, models: this.classifyCatalog(def, models) };
    } catch (e) {
      return { ok: false, error: friendlyProviderError(e) };
    }
  }

  /** Connect: validate, persist encrypted, register adapter, discover free routes. */
  async connect(providerId: string, fields: Record<string, unknown>, source: CredentialSource = "MANUAL_BYOK"): Promise<ConnectResult> {
    const def = this.definition(providerId);
    if (!def || !def.implemented) return { ok: false, error: "Provider is not supported" };
    let values: Record<string, string>;
    try {
      values = this.validateFields(def, fields);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Invalid input" };
    }
    const probe = this.ephemeralAdapter(def, values);
    let models: ProviderModel[] = [];
    if (probe) {
      try {
        models = await probe.listModels();
      } catch (e) {
        return { ok: false, error: friendlyProviderError(e) };
      }
    }
    this.storeFields(def, values, source);
    await this.reconcile(providerId);
    const verifiedFree = await this.host.discoverProviderFree(providerId).catch(() => 0);
    this.host.notifyChanged?.();
    return { ok: true, models: this.classifyCatalog(def, models), verifiedFree };
  }

  /** Live catalog for a connected provider (renderer dropdown / advanced view). */
  async catalog(providerId: string): Promise<ConnectResult> {
    const def = this.definition(providerId);
    const adapter = this.host.providerCatalog.get(providerId);
    if (!def || !adapter) return { ok: false, error: "Provider is not connected" };
    try {
      const models = await adapter.listModels();
      return { ok: true, models: this.classifyCatalog(def, models) };
    } catch (e) {
      return { ok: false, error: friendlyProviderError(e) };
    }
  }

  async disconnect(providerId: string): Promise<void> {
    const def = this.definition(providerId);
    if (!def) throw new Error("Unknown provider");
    this.host.secrets.delete(providerId);
    for (const field of def.connection.fields) if (field.id !== "apiKey") this.host.secrets.delete(configFieldKey(providerId, field.id));
    if (providerId === "cloudflare-workers-ai") this.host.secrets.delete("cloudflare-account-id");
    this.setStoredSource(providerId, null);
    await this.reconcile(providerId);
  }

  // --- reconciliation: settings → live adapter registry + registry connection state -------------

  /** Register/unregister the adapter for a provider based on current credential resolution. */
  async reconcile(providerId: string): Promise<void> {
    const def = this.definition(providerId);
    if (!def) return;
    const source = this.credentialSourceOf(providerId);
    const catalog = this.host.providerCatalog;
    if (def.apiStyle === "hosted" || def.apiStyle === "internal") {
      this.publishConnection(def, source);
      return;
    }
    const existing = catalog.get(providerId);
    if (source === "NONE") {
      if (existing) {
        this.removeProvider(providerId);
      }
      this.publishConnection(def, source);
      this.host.notifyChanged?.();
      return;
    }
    if (!existing) {
      const adapter = createProviderAdapterFromDefinition(def, { credentialStore: this.credentialStore(), onResponse: this.host.onResponse, geminiFreePolicyGate: def.id === "google" ? this.geminiPolicyGate() : undefined });
      if (adapter) catalog.register(adapter);
    }
    this.publishConnection(def, source);
    this.host.notifyChanged?.();
  }

  /** Publish connection state for every definition without touching adapters (startup). */
  publishAll(): void {
    for (const def of Object.values(this.definitions())) {
      if (def.apiStyle === "internal") continue;
      this.publishConnection(def, def.implemented ? this.credentialSourceOf(def.id) : "NONE");
    }
  }

  async reconcileAll(): Promise<void> {
    for (const def of Object.values(this.definitions())) {
      if (!def.implemented) {
        this.publishConnection(def, "NONE");
        continue;
      }
      await this.reconcile(def.id);
    }
  }

  private removeProvider(providerId: string): void {
    const catalog = this.host.providerCatalog;
    if (catalog instanceof InMemoryProviderCatalog) catalog.adapters.delete(providerId);
    else (catalog as { adapters?: Map<string, ProviderAdapter> }).adapters?.delete(providerId);
    for (const m of this.host.firewall.allModels()) {
      if (m.providerId === providerId) this.host.firewall.unregister(m.providerId, m.modelId);
    }
  }

  private publishConnection(def: ProviderDefinition, source: CredentialSource): void {
    const connected = source !== "NONE" && (def.apiStyle === "hosted" ? !!this.host.providerCatalog.get(def.id) : !!this.host.providerCatalog.get(def.id));
    const envVariable = source === "ENVIRONMENT" ? this.resolveField(def.id, "apiKey")?.variable : undefined;
    const auth = this.host.providerAuthState(def.id);
    const geminiPolicy = def.id === "google" ? this.geminiPolicyGate().evaluate() : undefined;
    const state: ProviderConnectionState = {
      providerId: def.id,
      connected,
      credentialSource: source,
      environmentVariable: envVariable,
      authState: connected ? auth ?? "ok" : "unknown",
      planAttested: def.freeAccess.spillover === "ACCOUNT_DEPENDENT" ? this.planAttested(def.id) : true,
      freePolicyState: geminiPolicy?.decision,
      freePolicyReason: geminiPolicy?.reasonCode,
      connectOffer: connected ? undefined : this.connectOfferFor(def),
    };
    this.host.freeCloud.setConnection(state);
  }

  /** Lowest-friction way to connect this provider right now (R1 §13, §68, §71). */
  connectOfferFor(def: ProviderDefinition): ProviderConnectionState["connectOffer"] {
    if (!def.implemented || def.authClasses[0] === "UNSUPPORTED") return undefined;
    const detected = this.detectEnvironment().find((d) => d.providerId === def.id);
    const candidates: Array<NonNullable<ProviderConnectionState["connectOffer"]>> = [];
    if (def.authClasses.includes("OAUTH_PKCE")) candidates.push({ authClass: "OAUTH_PKCE", label: `${def.displayName} · one-click account connection` });
    if (detected?.complete && def.authClasses.includes("ENVIRONMENT_CREDENTIAL")) {
      const variable = detected.fields.find((f) => f.secret)?.variable ?? detected.fields[0]?.variable ?? undefined;
      candidates.push({ authClass: "ENVIRONMENT_CREDENTIAL", label: `Use existing ${variable ?? "environment credential"}`, environmentVariable: variable ?? undefined });
    }
    if (def.authClasses.includes("ASSISTED_KEY")) candidates.push({ authClass: "ASSISTED_KEY", label: `${def.displayName} · provider key required` });
    candidates.sort((a, b) => AUTH_CLASS_FRICTION[a.authClass] - AUTH_CLASS_FRICTION[b.authClass]);
    return candidates[0];
  }

  // --- views ------------------------------------------------------------------------------------

  listConnections(): ProviderConnectionView[] {
    const snap = this.host.freeCloud.snapshot();
    const envViews = new Map(this.listEnvironmentCredentials().map((e) => [e.providerId, e] as const));
    const views: ProviderConnectionView[] = [];
    for (const def of Object.values(this.definitions())) {
      if (def.apiStyle === "internal") continue;
      const conn = this.host.freeCloud.getConnection(def.id);
      const routes = snap.models.flatMap((m) => m.routes).filter((r) => r.providerId === def.id);
      const freeRoutes = routes.filter((r) => isZeroCashFreeAccess(r.freeAccessClass) && r.termsStatus === "CLEARED");
      const env = envViews.get(def.id) ?? null;
      const connected = conn?.connected === true;
      const offer = conn?.connectOffer ?? this.connectOfferFor(def);
      const sortRank = connected ? 0 : env?.complete ? 1 : offer?.authClass === "OAUTH_PKCE" ? 2 : def.recommendedForFreeDefault ? 3 : 4;
      views.push({
        ...this.definitionView(def),
        connected,
        credentialSource: conn?.credentialSource ?? "NONE",
        environmentVariable: conn?.environmentVariable,
        authState: conn?.authState ?? "unknown",
        planAttested: this.planAttested(def.id),
        planAttestationRequired: def.freeAccess.spillover === "ACCOUNT_DEPENDENT" && isZeroCashFreeAccess(def.freeAccess.class),
        connectOffer: offer,
        environment: env,
        freeRouteCount: freeRoutes.length,
        healthyRouteCount: freeRoutes.filter((r) => r.forgeAutoEligible).length,
        catalogCount: routes.length,
        sortRank,
        geminiPolicyAccepted: def.id === "google" ? this.geminiFreeAcceptance() !== null : undefined,
        geminiPolicyBlockedReason: def.id === "google" ? evaluateGeminiFreePolicy({ accountId: this.geminiFreePolicyContext().accountId, region: this.geminiFreePolicyContext().region, acceptance: this.geminiFreeAcceptance(), now: this.now() }).reasonCode : undefined,
        // The desktop host has no trusted dashboard usage source. Unknown is the only honest
        // renderer state until an account-scoped usage attestation is supplied.
        cloudflareBudgetStatus: def.id === "cloudflare-workers-ai" ? "unknown" : undefined,
      });
    }
    return views.sort((a, b) => a.sortRank - b.sortRank || a.displayName.localeCompare(b.displayName));
  }

  /** First-run decision (R1 §70-§72): the single best next action for ForgeAuto/Free. */
  firstRunOffer(): FirstRunOffer {
    const snap = this.host.freeCloud.snapshot();
    if (snap.summary.healthyFreeRoutes > 0) return { kind: "ready", models: snap.summary.verifiedFreeModels, routes: snap.summary.healthyFreeRoutes };
    const pending = this.host.freeCloud.pendingQualification().length;
    if (pending > 0 || this.host.freeCloud.isQualifying()) return { kind: "qualifying", pending };
    const detected = this.detectEnvironment().filter((d) => d.complete && d.zeroCashFreeAccess && this.definition(d.providerId)?.terms.status === "CLEARED");
    const envSettings = this.envSettings();
    const usable = detected.find((d) => !envSettings.preferences[d.providerId]?.enabled && envSettings.policy !== "OFF");
    const oauth = Object.values(this.definitions()).find((d) => d.implemented && d.recommendedForFreeDefault && d.authClasses[0] === "OAUTH_PKCE");
    if (usable) {
      const variable = usable.fields.find((f) => f.secret)?.variable ?? usable.fields[0]?.variable ?? "";
      return { kind: "environment", providerId: usable.providerId, displayName: usable.displayName, variable };
    }
    if (oauth) return { kind: "oauth", providerId: oauth.id, displayName: oauth.displayName };
    const manual = Object.values(this.definitions()).find((d) => d.implemented && d.recommendedForFreeDefault && isZeroCashFreeAccess(d.freeAccess.class));
    return manual ? { kind: "manual", providerId: manual.id, displayName: manual.displayName, keyUrl: manual.keyUrl } : { kind: "manual", providerId: "openrouter", displayName: "OpenRouter", keyUrl: "https://openrouter.ai/keys" };
  }
}

/** Product-safe wording for provider failures during connect/validate (R1 §69, §101). */
export function friendlyProviderError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (/\b401\b|\b403\b|unauthor|invalid api key|forbidden/.test(msg)) return "The provider rejected this credential. Check the key and try again.";
  if (/\b429\b|rate.?limit/.test(msg)) return "The provider is rate limiting right now. Try again in a moment.";
  if (/\b402\b|payment/.test(msg)) return "This account needs billing set up on the provider before it can be used.";
  if (/timed? ?out|timeout/.test(msg)) return "The provider did not respond in time.";
  if (/enotfound|econnrefused|fetch failed|network/.test(msg)) return "Could not reach the provider. Check your connection.";
  if (/missing_api_key|credential not configured/.test(msg)) return "No credential available for this provider.";
  return "The provider could not be validated right now.";
}

/** Providers whose legacy implicit env consumption is migrated (exported for tests/docs). */
export const LEGACY_ENV_PROVIDERS = LEGACY_IMPLICIT_ENV_PROVIDERS;

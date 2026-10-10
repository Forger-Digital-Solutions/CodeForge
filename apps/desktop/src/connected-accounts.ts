import { createHash, randomUUID } from "node:crypto";
import { openRouterCredentialFingerprint, isOpenRouterConnectionCurrent, isOpenRouterEntitlementCurrent, verifyOpenRouterEntitlement,
  type CredentialStore, type OpenRouterEntitlementReceipt, type ProviderModel } from "@codeforge/providers";
import { redactSecrets } from "@codeforge/secrets";
import type { FreeAdmissionReceipt, QuotaScopeEvidence } from "@codeforge/forge-zero";
import type { ConnectedAccountAuthMethod, ConnectedAccountPolicyPatch, ConnectedAccountPreference, ConnectedAccountResult, ConnectedAccountView } from "./connected-account-types.js";

export const CONNECTED_ACCOUNTS_KEY = "codeforge:connected-provider-accounts";
const CONNECTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");
const credentialRef = (owner: string, connectionId: string, field = "apiKey"): string =>
  `user-api-credential:${fingerprint(`${owner}\0${connectionId}\0${field === "apiKey" ? "credential" : `field:${field}`}`).slice(0, 24)}`;

export interface ConnectedAccountAuthority {
  connectionId: string;
  ownerUserId: string;
  providerId: string;
  credentialRef: string;
  credentialFingerprint: string;
  accountClass: OpenRouterEntitlementReceipt["accountClass"];
  accountIdentityHash?: string;
  quotaDomainId: string;
  quotaScopeVerified: boolean;
  enabled: boolean;
  paidSpendingEnabled: boolean;
  monthlyBudgetCents?: number;
  preference: ConnectedAccountPreference;
  verifiedAt?: string;
  recheckAt?: string;
  expiresAt?: string;
  authState: ConnectedAccountView["authState"];
  freeAdmissionVerified: boolean;
  admissionEvidence?: Omit<FreeAdmissionReceipt, "qualificationAt">;
  quotaScopeEvidence?: QuotaScopeEvidence;
  freeRequests?: OpenRouterEntitlementReceipt["freeRequests"];
}

export interface ConnectedAccountModels {
  connectionId: string;
  credentialRef: string;
  credentialFingerprint: string;
  checkedAt: string;
  models: readonly ProviderModel[];
}

export interface ConnectedAccountsHost {
  ownerUserId(): string;
  readSettings(): Record<string, unknown>;
  writeSettings(settings: Record<string, unknown>): boolean | void;
  secrets: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void };
  providerName(providerId: string): string | undefined;
  probe(providerId: string, fields: Record<string, unknown>): Promise<{ values: Record<string, string>; models: ProviderModel[] }>;
  verifyOpenRouter?: typeof verifyOpenRouterEntitlement;
  paidAccountAdmission?: (account: ConnectedAccountAuthority) => { eligible: boolean; reason?: string };
  now?: () => Date;
  notifyChanged?: () => void;
}

interface StoredAccount {
  connectionId: string;
  ownerUserId: string;
  providerId: string;
  label?: string;
  authMethod: ConnectedAccountAuthMethod;
  credentialRef: string;
  fieldRefs: Record<string, string>;
  credentialFingerprint: string;
  enabled: boolean;
  paidSpendingEnabled: boolean;
  monthlyBudgetCents?: number;
  preference: ConnectedAccountPreference;
  authState: ConnectedAccountView["authState"];
  entitlement?: OpenRouterEntitlementReceipt;
  models: ProviderModel[];
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const labelOf = (label: unknown): string | undefined => {
  if (label === undefined || label === "") return undefined;
  if (typeof label !== "string" || label.length > 120 || /[\r\n\t]/.test(label) || redactSecrets(label) !== label) throw new Error("ACCOUNT_LABEL_INVALID");
  return label.trim() || undefined;
};

export class ConnectedAccounts {
  private readonly now: () => Date;
  private readonly checkedConnections = new Set<string>();
  constructor(private readonly host: ConnectedAccountsHost) { this.now = host.now ?? (() => new Date()); }

  private records(): StoredAccount[] {
    const raw = this.host.readSettings()[CONNECTED_ACCOUNTS_KEY];
    if (!object(raw)) return [];
    return Object.values(raw).filter((value): value is Record<string, unknown> => object(value)).flatMap((value) => {
      if (typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId) || typeof value.ownerUserId !== "string" || !value.ownerUserId
        || typeof value.providerId !== "string" || !this.host.providerName(value.providerId)
        || value.credentialRef !== credentialRef(value.ownerUserId, value.connectionId) || !object(value.fieldRefs)
        || typeof value.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint)
        || !Array.isArray(value.models) || typeof value.checkedAt !== "string"
        || !["OAUTH_PKCE", "API_KEY", "ENVIRONMENT"].includes(String(value.authMethod))
        || !["AUTO", "PREFERRED", "FALLBACK", "MANUAL"].includes(String(value.preference))
        || !["ok", "auth_required", "rate_limited", "unknown"].includes(String(value.authState))) return [];
      if (Object.entries(value.fieldRefs).some(([field, ref]) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(field) || ref !== credentialRef(value.ownerUserId as string, value.connectionId as string, field))) return [];
      return [{ ...value, enabled: value.enabled === true, paidSpendingEnabled: value.paidSpendingEnabled === true } as unknown as StoredAccount];
    });
  }

  private owned(connectionId: string): StoredAccount | undefined {
    return this.records().find((record) => record.connectionId === connectionId && record.ownerUserId === this.host.ownerUserId());
  }

  private persist(record: StoredAccount): void {
    const current = this.host.readSettings();
    const raw = current[CONNECTED_ACCOUNTS_KEY];
    const next = { ...current, [CONNECTED_ACCOUNTS_KEY]: { ...(object(raw) ? raw : {}), [record.connectionId]: record } };
    if (this.host.writeSettings(next) === false) throw new Error("ACCOUNT_SETTINGS_SAVE_FAILED");
    this.host.notifyChanged?.();
  }

  private liveKey(record: StoredAccount): string | undefined {
    if (record.ownerUserId !== this.host.ownerUserId()) return undefined;
    const key = this.host.secrets.get(record.credentialRef);
    return key && fingerprint(key) === record.credentialFingerprint ? key : undefined;
  }

  authority(connectionId: string): ConnectedAccountAuthority | undefined {
    const record = this.owned(connectionId);
    if (!record) return undefined;
    const key = this.liveKey(record);
    const receipt = record.entitlement;
    const checked = this.checkedConnections.has(connectionId);
    const current = checked && !!key && !!receipt && isOpenRouterConnectionCurrent(receipt, record.ownerUserId, key, this.now());
    const freeAdmissionVerified = current && record.enabled && record.authState === "ok" && record.authMethod === "OAUTH_PKCE" && isOpenRouterEntitlementCurrent(receipt, record.ownerUserId, key!, this.now()) && !!receipt?.admissionEvidence;
    const accountIdentityHash = current ? receipt?.accountIdentityHash : undefined;
    return { connectionId, ownerUserId: record.ownerUserId, providerId: record.providerId, credentialRef: record.credentialRef,
      credentialFingerprint: record.credentialFingerprint, accountClass: current ? receipt!.accountClass : "UNKNOWN",
      accountIdentityHash, quotaDomainId: accountIdentityHash ? `${record.providerId}:${receipt?.quotaScopeEvidence?.scope === "ORG" ? "organization" : "user"}:${accountIdentityHash}` : `${record.providerId}:shared:unverified-account`,
      quotaScopeVerified: !!accountIdentityHash, enabled: record.enabled && !!key, paidSpendingEnabled: record.paidSpendingEnabled,
      monthlyBudgetCents: record.monthlyBudgetCents, preference: record.preference, verifiedAt: receipt?.verifiedAt ?? record.checkedAt,
      recheckAt: receipt?.recheckAt, expiresAt: receipt?.expiresAt, authState: key ? checked && (current || record.providerId !== "openrouter") ? record.authState : "unknown" : "auth_required",
      freeAdmissionVerified, ...(current && receipt?.admissionEvidence ? { admissionEvidence: receipt.admissionEvidence } : {}),
      ...(current && receipt?.quotaScopeEvidence ? { quotaScopeEvidence: receipt.quotaScopeEvidence } : {}), ...(current && receipt?.freeRequests ? { freeRequests: receipt.freeRequests } : {}) };
  }

  private view(record: StoredAccount): ConnectedAccountView {
    const authority = this.authority(record.connectionId)!;
    const paid = !authority.enabled ? { eligible: false, reason: "ACCOUNT_DISABLED_OR_DISCONNECTED" }
      : authority.authState !== "ok" ? { eligible: false, reason: "ACCOUNT_RECHECK_REQUIRED" }
      : !record.paidSpendingEnabled ? { eligible: false, reason: "ACCOUNT_PAID_SPENDING_DISABLED" }
      : !Number.isSafeInteger(record.monthlyBudgetCents) || (record.monthlyBudgetCents ?? 0) <= 0 ? { eligible: false, reason: "ACCOUNT_PAID_BUDGET_REQUIRED" }
      : this.host.paidAccountAdmission?.(authority) ?? { eligible: false, reason: "PAID_RUNTIME_AUTHORITY_REQUIRED" };
    return { connectionId: record.connectionId, providerId: record.providerId, providerName: this.host.providerName(record.providerId)!, label: record.label,
      maskedIdentity: authority.accountIdentityHash ? `Account ••••${authority.accountIdentityHash.slice(-8)}` : "Account identity unverified", authMethod: record.authMethod,
      connected: !!this.liveKey(record), enabled: record.enabled, authState: authority.authState,
      classification: authority.authState === "auth_required" ? "BLOCKED" : authority.accountClass === "PAID" || record.entitlement?.accountClass === "PAID" ? "PAID" : authority.freeAdmissionVerified ? "FREE_VERIFIED" : "FREE_UNVERIFIED",
      freeOnly: !record.paidSpendingEnabled, paidSpendingEnabled: record.paidSpendingEnabled, monthlyBudgetCents: record.monthlyBudgetCents,
      preference: record.preference, freeRouteCount: 0, qualifiedModels: [],
      quotaSummary: authority.freeRequests ? `${authority.freeRequests.remaining}/${authority.freeRequests.limit} provider-reported daily Free requests remaining` : undefined,
      health: authority.authState === "ok" ? "connected" : authority.authState, reason: record.reason ?? record.entitlement?.reason,
      paidDispatchEligible: paid.eligible, paidBlockReason: paid.eligible ? undefined : paid.reason };
  }

  list(): ConnectedAccountView[] { return this.records().filter((record) => record.ownerUserId === this.host.ownerUserId()).map((record) => this.view(record)); }

  models(connectionId: string): ConnectedAccountModels | undefined {
    const record = this.owned(connectionId);
    if (!record || !this.liveKey(record)) return undefined;
    return { connectionId, credentialRef: record.credentialRef, credentialFingerprint: record.credentialFingerprint, checkedAt: record.checkedAt, models: structuredClone(record.models) };
  }

  credentials(connectionId: string, mode: "FREE_ONLY" | "PERSONAL_PAID"): CredentialStore | undefined {
    const record = this.owned(connectionId);
    const allowed = (): boolean => {
      const authority = this.authority(connectionId);
      return !!authority?.enabled && authority.authState === "ok" && (mode === "FREE_ONLY" ? authority.freeAdmissionVerified : this.view(this.owned(connectionId)!).paidDispatchEligible);
    };
    if (!record || !allowed()) return undefined;
    const get = (key: string): string | undefined => {
      if (!allowed()) return undefined;
      const live = this.owned(connectionId)!;
      const field = key === live.providerId ? "apiKey" : key === "cloudflare-account-id" ? "accountId" : key.startsWith(`${live.providerId}:`) ? key.slice(live.providerId.length + 1) : undefined;
      return field && live.fieldRefs[field] ? this.host.secrets.get(live.fieldRefs[field]!) : undefined;
    };
    return { get, has: (key) => get(key) !== undefined, set: () => { throw new Error("ACCOUNT_CREDENTIAL_STORE_READ_ONLY"); }, delete: () => false };
  }

  async connect(providerId: string, fields: Record<string, unknown>, options: { label?: string; authMethod?: ConnectedAccountAuthMethod; expectedOwnerUserId?: string; replaceConnectionId?: string; preservePolicy?: boolean;
    verifiedProbe?: { values: Record<string, string>; models: ProviderModel[]; entitlement: OpenRouterEntitlementReceipt } } = {}): Promise<ConnectedAccountResult> {
    const owner = this.host.ownerUserId();
    if (!owner || (options.expectedOwnerUserId !== undefined && options.expectedOwnerUserId !== owner)) return { ok: false, error: "Sign in to the same CodeForge account before connecting." };
    try {
      const label = labelOf(options.label);
      const existing = options.replaceConnectionId ? this.owned(options.replaceConnectionId) : undefined;
      if (options.replaceConnectionId && (!existing || existing.providerId !== providerId)) return { ok: false, error: "Account connection is unavailable." };
      const { values, models } = options.verifiedProbe ?? await this.host.probe(providerId, fields);
      if (!values.apiKey) return { ok: false, error: "This provider requires supported API-key authentication." };
      const entitlement = providerId === "openrouter" ? options.verifiedProbe?.entitlement ?? await (this.host.verifyOpenRouter ?? verifyOpenRouterEntitlement)({ key: values.apiKey, ownerUserId: owner, now: this.now() }) : undefined;
      if (owner !== this.host.ownerUserId()) return { ok: false, error: "The CodeForge account changed during connection. Connect again." };
      if (entitlement && !isOpenRouterConnectionCurrent(entitlement, owner, values.apiKey, this.now())) return { ok: false, error: `OpenRouter authorization is unverified (${entitlement.reason}).` };
      if (existing?.entitlement?.accountIdentityHash && entitlement?.accountIdentityHash !== existing.entitlement.accountIdentityHash) return { ok: false, error: "This credential belongs to a different provider account. Add it as a separate account." };
      const duplicate = this.records().find((record) => record.ownerUserId === owner && record.providerId === providerId && record.credentialFingerprint === fingerprint(values.apiKey!));
      const prior = existing ?? duplicate;
      const connectionId = prior?.connectionId ?? randomUUID();
      const at = this.now().toISOString();
      const record: StoredAccount = { connectionId, ownerUserId: owner, providerId, label: label ?? prior?.label, authMethod: options.authMethod ?? prior?.authMethod ?? "API_KEY",
        credentialRef: credentialRef(owner, connectionId), fieldRefs: Object.fromEntries(Object.keys(values).map((field) => [field, credentialRef(owner, connectionId, field)])),
        credentialFingerprint: fingerprint(values.apiKey), enabled: prior?.enabled ?? true, paidSpendingEnabled: options.preservePolicy === true && prior?.credentialFingerprint === fingerprint(values.apiKey) ? prior.paidSpendingEnabled : false, preference: prior?.preference ?? "AUTO",
        monthlyBudgetCents: prior?.monthlyBudgetCents, authState: "ok", entitlement, models: structuredClone(models), checkedAt: at, createdAt: prior?.createdAt ?? at, updatedAt: at };
      const rollback = new Map<string, string | undefined>();
      try {
        for (const [field, value] of Object.entries(values)) { const ref = record.fieldRefs[field]!; rollback.set(ref, this.host.secrets.get(ref)); this.host.secrets.set(ref, value); }
        this.persist(record);
      } catch (error) { for (const [ref, value] of rollback) { if (value === undefined) this.host.secrets.delete(ref); else this.host.secrets.set(ref, value); } throw error; }
      this.checkedConnections.add(connectionId);
      return { ok: true, connection: this.view(record) };
    } catch { return { ok: false, error: "The provider account could not be validated or securely saved." }; }
  }

  update(connectionId: string, patch: ConnectedAccountPolicyPatch): ConnectedAccountView {
    const record = this.owned(connectionId);
    if (!record) throw new Error("ACCOUNT_CONNECTION_UNAVAILABLE");
    if (!object(patch) || Object.keys(patch).some((key) => !["label", "enabled", "paidSpendingEnabled", "monthlyBudgetCents", "preference"].includes(key))) throw new Error("ACCOUNT_POLICY_INVALID");
    if ((patch.enabled !== undefined && typeof patch.enabled !== "boolean") || (patch.paidSpendingEnabled !== undefined && typeof patch.paidSpendingEnabled !== "boolean")) throw new Error("ACCOUNT_POLICY_INVALID");
    if (patch.monthlyBudgetCents !== undefined && patch.monthlyBudgetCents !== null && (typeof patch.monthlyBudgetCents !== "number" || !Number.isSafeInteger(patch.monthlyBudgetCents) || patch.monthlyBudgetCents < 0)) throw new Error("ACCOUNT_BUDGET_INVALID");
    if (patch.preference !== undefined && !["AUTO", "PREFERRED", "FALLBACK", "MANUAL"].includes(String(patch.preference))) throw new Error("ACCOUNT_POLICY_INVALID");
    const valid = patch as ConnectedAccountPolicyPatch;
    const next: StoredAccount = { ...record, ...(valid.label !== undefined ? { label: labelOf(valid.label) } : {}), ...(valid.enabled !== undefined ? { enabled: valid.enabled } : {}),
      ...(valid.paidSpendingEnabled !== undefined ? { paidSpendingEnabled: valid.paidSpendingEnabled } : {}), ...(valid.preference !== undefined ? { preference: valid.preference } : {}),
      ...(valid.monthlyBudgetCents !== undefined ? { monthlyBudgetCents: valid.monthlyBudgetCents ?? undefined } : {}), updatedAt: this.now().toISOString() };
    this.persist(next); return this.view(next);
  }

  async disconnect(connectionId: string): Promise<void> {
    const record = this.owned(connectionId);
    if (!record) throw new Error("ACCOUNT_CONNECTION_UNAVAILABLE");
    const rollback = new Map(Object.values(record.fieldRefs).map((ref) => [ref, this.host.secrets.get(ref)]));
    try {
      for (const ref of rollback.keys()) this.host.secrets.delete(ref);
      this.persist({ ...record, enabled: false, paidSpendingEnabled: false, authState: "auth_required", reason: "LOCAL_CONNECTION_DISCONNECTED", updatedAt: this.now().toISOString() });
      this.checkedConnections.delete(connectionId);
    } catch (error) { for (const [ref, value] of rollback) if (value !== undefined) this.host.secrets.set(ref, value); throw error; }
  }

  async disconnectMatchingCredential(providerId: string, key: string): Promise<void> {
    for (const record of this.records().filter((entry) => entry.ownerUserId === this.host.ownerUserId() && entry.providerId === providerId && entry.credentialFingerprint === fingerprint(key))) {
      await this.disconnect(record.connectionId);
    }
  }

  async recheck(connectionId: string): Promise<ConnectedAccountResult> {
    const record = this.owned(connectionId);
    if (!record || !this.liveKey(record)) return { ok: false, error: "Reconnect this provider account." };
    const fields = Object.fromEntries(Object.entries(record.fieldRefs).map(([field, ref]) => [field, this.host.secrets.get(ref)]));
    const result = await this.connect(record.providerId, fields, { authMethod: record.authMethod, replaceConnectionId: connectionId, preservePolicy: true });
    if (!result.ok && record.ownerUserId === this.host.ownerUserId()) {
      this.checkedConnections.delete(connectionId);
      this.persist({ ...record, authState: "unknown", paidSpendingEnabled: false, reason: "ACCOUNT_RECHECK_REQUIRED", updatedAt: this.now().toISOString() });
    }
    return result;
  }

  async migrate(providerId: string, key: string, receipt: OpenRouterEntitlementReceipt, source: "OAUTH" | "MANUAL_BYOK"): Promise<void> {
    if (receipt.ownerUserId !== this.host.ownerUserId() || receipt.credentialFingerprint !== openRouterCredentialFingerprint(key)) return;
    const prior = this.records().find((record) => record.ownerUserId === receipt.ownerUserId && record.providerId === providerId && record.credentialFingerprint === receipt.credentialFingerprint);
    if (prior && this.checkedConnections.has(prior.connectionId) && prior.entitlement?.verifiedAt === receipt.verifiedAt) return;
    const { values, models } = await this.host.probe(providerId, { apiKey: key });
    await this.connect(providerId, { apiKey: key }, { authMethod: source === "OAUTH" ? "OAUTH_PKCE" : "API_KEY", expectedOwnerUserId: receipt.ownerUserId,
      ...(prior ? { replaceConnectionId: prior.connectionId, preservePolicy: true } : {}), verifiedProbe: { values, models, entitlement: receipt } });
  }
}

import { describe, expect, it } from "vitest";
import { classifyOpenRouterEntitlement, type ProviderModel } from "@codeforge/providers";
import { ConnectedAccounts, CONNECTED_ACCOUNTS_KEY, type ConnectedAccountsHost } from "../src/connected-accounts.js";

function harness() {
  let owner = "local-owner-a";
  let now = new Date("2026-10-09T12:00:00Z");
  const settings: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const identities = new Map([ ["free-key", "upstream-free"], ["paid-key-a", "upstream-paid"], ["paid-key-b", "upstream-paid"], ["paid-key-other", "upstream-other"] ]);
  let paidAllowed = false;
  const model: ProviderModel = { modelId: "fixture-model", displayName: "Fixture", isFree: false, freeStatus: "paid", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false } };
  const host: ConnectedAccountsHost = { ownerUserId: () => owner, readSettings: () => settings, writeSettings: (next) => Object.assign(settings, next),
    secrets: { get: (ref) => secrets.get(ref), set: (ref, key) => void secrets.set(ref, key), delete: (ref) => void secrets.delete(ref) }, now: () => now,
    providerName: (id) => id === "openrouter" ? "OpenRouter" : undefined,
    probe: async (_id, fields) => ({ values: { apiKey: String(fields.apiKey) }, models: [model] }),
    verifyOpenRouter: async (binding) => {
      const receipt = classifyOpenRouterEntitlement({ data: { is_free_tier: binding.key.startsWith("free"), creator_user_id: identities.get(binding.key), organization_id: null,
        free_model_daily_requests: { limit: 50, used: 1, remaining: 49 } } }, binding);
      return receipt.accountClass === "FREE_VERIFIED" ? { ...receipt, admissionEvidence: { sourceDocumentation: "fixture:oauth", termsEvidence: "fixture:terms", privacyEvidence: "fixture:privacy", priceEvidence: "fixture:zero", verifiedAt: receipt.verifiedAt, recheckAt: receipt.recheckAt } } : receipt;
    }, paidAccountAdmission: () => ({ eligible: paidAllowed, reason: paidAllowed ? undefined : "GLOBAL_PAID_DISABLED" }) };
  const accounts = new ConnectedAccounts(host);
  return { accounts, host, settings, secrets, model, identities, owner: (value: string) => { owner = value; }, clock: (value: Date) => { now = value; }, paid: (value: boolean) => { paidAllowed = value; } };
}

describe("trusted multi-account provider connections", () => {
  it("preserves two owned accounts without replacing credentials, leaking secrets, or enabling paid spend", async () => {
    const h = harness();
    const first = await h.accounts.connect("openrouter", { apiKey: "free-key" }, { authMethod: "OAUTH_PKCE", label: "Free account" });
    const second = await h.accounts.connect("openrouter", { apiKey: "paid-key-a" }, { authMethod: "OAUTH_PKCE", label: "Personal paid account" });
    expect(first.ok && second.ok).toBe(true);
    expect(first.connection?.connectionId).not.toBe(second.connection?.connectionId);
    expect(h.secrets.size).toBe(2);
    expect(h.accounts.list()).toHaveLength(2);
    expect(second.connection).toMatchObject({ classification: "PAID", freeOnly: true, paidSpendingEnabled: false, paidDispatchEligible: false, qualifiedModels: [], freeRouteCount: 0 });
    expect(h.accounts.credentials(second.connection!.connectionId, "FREE_ONLY")).toBeUndefined();
    expect(h.accounts.credentials(second.connection!.connectionId, "PERSONAL_PAID")).toBeUndefined();
    const exposed = JSON.stringify([h.accounts.list(), h.settings]);
    for (const key of ["free-key", "paid-key-a"]) expect(exposed).not.toContain(key);
    const view = JSON.stringify(h.accounts.list());
    for (const field of ["credentialRef", "credentialFingerprint", "ownerUserId", "accountIdentityHash"]) expect(view).not.toContain(field);
  });

  it("retains connection IDs and encrypted references through restart and reuses a duplicate key", async () => {
    const h = harness();
    const first = await h.accounts.connect("openrouter", { apiKey: "paid-key-a" });
    const duplicate = await h.accounts.connect("openrouter", { apiKey: "paid-key-a" });
    expect(duplicate.connection?.connectionId).toBe(first.connection?.connectionId);
    expect(h.secrets.size).toBe(1);
    expect(new ConnectedAccounts(h.host).list()[0]?.connectionId).toBe(first.connection?.connectionId);
  });

  it("requires a fresh process recheck after restart before either Free or paid credential dispatch", async () => {
    const h = harness();
    const free = (await h.accounts.connect("openrouter", { apiKey: "free-key" }, { authMethod: "OAUTH_PKCE" })).connection!.connectionId;
    const paid = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    h.accounts.update(paid, { paidSpendingEnabled: true, monthlyBudgetCents: 500 });
    h.paid(true);
    const restarted = new ConnectedAccounts(h.host);
    expect(restarted.list()).toHaveLength(2);
    expect(restarted.list().every((account) => account.connected && account.authState === "unknown" && !account.paidDispatchEligible)).toBe(true);
    expect(restarted.list().find(account => account.connectionId === paid)).toMatchObject({ classification: "PAID", authState: "unknown", paidDispatchEligible: false });
    expect(restarted.authority(paid)?.accountClass).toBe("UNKNOWN");
    expect(restarted.authority(free)?.freeAdmissionVerified).toBe(false);
    expect(restarted.credentials(free, "FREE_ONLY")).toBeUndefined();
    expect(restarted.credentials(paid, "PERSONAL_PAID")).toBeUndefined();
    expect(await restarted.recheck(free)).toMatchObject({ ok: true, connection: { connectionId: free, classification: "FREE_VERIFIED" } });
    expect(await restarted.recheck(paid)).toMatchObject({ ok: true, connection: { connectionId: paid, paidSpendingEnabled: true } });
    expect(restarted.credentials(free, "FREE_ONLY")?.get("openrouter")).toBe("free-key");
    expect(restarted.credentials(paid, "PERSONAL_PAID")?.get("openrouter")).toBe("paid-key-a");
  });

  it("refreshes migrated owner-scoped records once without losing the stable connection or account policy", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "free-key" }, { authMethod: "OAUTH_PKCE" })).connection!.connectionId;
    h.accounts.update(id, { monthlyBudgetCents: 500, preference: "PREFERRED" });
    const restarted = new ConnectedAccounts(h.host);
    let probes = 0;
    const probe = h.host.probe;
    h.host.probe = async (...args) => { probes++; return probe(...args); };
    const receipt = await h.host.verifyOpenRouter!({ key: "free-key", ownerUserId: "local-owner-a", now: new Date("2026-10-09T12:00:00Z") });
    await restarted.migrate("openrouter", "free-key", receipt, "OAUTH");
    await restarted.migrate("openrouter", "free-key", receipt, "OAUTH");
    expect(probes).toBe(1);
    expect(restarted.list()).toMatchObject([{ connectionId: id, classification: "FREE_VERIFIED", monthlyBudgetCents: 500, preference: "PREFERRED" }]);
    h.owner("different-local-owner");
    await restarted.migrate("openrouter", "free-key", receipt, "OAUTH");
    expect(probes).toBe(1);
    expect(restarted.list()).toEqual([]);
  });

  it("groups different keys by actual account, and shares a conservative domain when owner identity is absent", async () => {
    const h = harness();
    const connections = await Promise.all(["paid-key-a", "paid-key-b", "paid-key-other", "unknown-key-a", "unknown-key-b"].map((apiKey) => h.accounts.connect("openrouter", { apiKey })));
    const authority = connections.map((result) => h.accounts.authority(result.connection!.connectionId)!);
    expect(authority[0]?.quotaDomainId).toBe(authority[1]?.quotaDomainId);
    expect(authority[0]?.credentialFingerprint).not.toBe(authority[1]?.credentialFingerprint);
    expect(authority[0]?.quotaDomainId).not.toBe(authority[2]?.quotaDomainId);
    expect(authority[3]?.quotaDomainId).toBe(authority[4]?.quotaDomainId);
    expect(authority[3]?.quotaScopeVerified).toBe(false);
  });

  it("keeps paid organization quotas distinct from personal quotas without creating a Free certificate", async () => {
    const h = harness();
    h.host.verifyOpenRouter = async (binding) => classifyOpenRouterEntitlement({ data: { is_free_tier: false, organization_id: "organization-1", creator_user_id: h.identities.get(binding.key) } }, binding);
    const first = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    const second = (await h.accounts.connect("openrouter", { apiKey: "paid-key-other" })).connection!.connectionId;
    expect(h.accounts.authority(first)?.quotaDomainId).toMatch(/^openrouter:organization:[a-f0-9]{64}$/);
    expect(h.accounts.authority(first)?.quotaDomainId).toBe(h.accounts.authority(second)?.quotaDomainId);
    expect(h.accounts.authority(first)?.quotaScopeEvidence?.scope).toBe("ORG");
    expect(h.accounts.authority(first)?.freeAdmissionVerified).toBe(false);
  });

  it("requires both explicit account budget consent and trusted global admission, then invalidates a live resolver on switch/disconnect", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    h.accounts.update(id, { paidSpendingEnabled: true, monthlyBudgetCents: 500 });
    expect(h.accounts.credentials(id, "PERSONAL_PAID")).toBeUndefined();
    h.paid(true);
    const store = h.accounts.credentials(id, "PERSONAL_PAID")!;
    expect(store.get("openrouter")).toBe("paid-key-a");
    h.owner("other-owner");
    expect(h.accounts.list()).toEqual([]);
    expect(h.accounts.authority(id)).toBeUndefined();
    expect(store.get("openrouter")).toBeUndefined();
    h.owner("local-owner-a");
    await h.accounts.disconnect(id);
    expect(store.get("openrouter")).toBeUndefined();
    expect(h.accounts.list()[0]).toMatchObject({ connectionId: id, connected: false, enabled: false, paidSpendingEnabled: false, classification: "BLOCKED" });
  });

  it("refuses cross-owner operations and account changes during awaited authorization", async () => {
    const h = harness();
    const probe = h.host.probe;
    h.host.probe = async (id, fields) => { h.owner("changed-owner"); return probe(id, fields); };
    expect(await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).toMatchObject({ ok: false });
    expect(h.secrets.size).toBe(0);
    expect(h.settings[CONNECTED_ACCOUNTS_KEY]).toBeUndefined();
  });

  it("rejects reauthorization for a different upstream identity and resets spending on actual replacement", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    h.accounts.update(id, { paidSpendingEnabled: true, monthlyBudgetCents: 500 });
    expect(await h.accounts.connect("openrouter", { apiKey: "paid-key-other" }, { replaceConnectionId: id })).toMatchObject({ ok: false });
    expect(await h.accounts.connect("openrouter", { apiKey: "paid-key-b" }, { replaceConnectionId: id })).toMatchObject({ ok: true, connection: { connectionId: id, paidSpendingEnabled: false } });
  });

  it("preserves same-key recheck consent but clears it on failed/stale/revoked entitlement", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    h.accounts.update(id, { paidSpendingEnabled: true, monthlyBudgetCents: 500 });
    expect(await h.accounts.recheck(id)).toMatchObject({ ok: true, connection: { paidSpendingEnabled: true } });
    h.clock(new Date("2026-10-10T12:00:00Z"));
    expect(h.accounts.authority(id)?.accountClass).toBe("UNKNOWN");
    h.host.verifyOpenRouter = async (binding) => classifyOpenRouterEntitlement(undefined, { ...binding, status: 401 });
    expect(await h.accounts.recheck(id)).toMatchObject({ ok: false });
    expect(h.accounts.list()[0]?.paidSpendingEnabled).toBe(false);
    expect(h.accounts.credentials(id, "PERSONAL_PAID")).toBeUndefined();
  });

  it("rolls new credential storage back when settings persistence is rejected", async () => {
    const h = harness();
    h.host.writeSettings = () => false;
    expect(await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).toMatchObject({ ok: false });
    expect(h.secrets.size).toBe(0);
    expect(h.settings[CONNECTED_ACCOUNTS_KEY]).toBeUndefined();
  });

  it("preserves disconnected metadata and secrets if its transactional write is rejected", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    h.host.writeSettings = () => false;
    await expect(h.accounts.disconnect(id)).rejects.toThrow("ACCOUNT_SETTINGS_SAVE_FAILED");
    expect(h.secrets.size).toBe(1);
    expect(h.accounts.list()[0]?.connected).toBe(true);
  });

  it("keeps catalog/model metadata private and copies it so callers cannot promote qualification", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    const snapshot = h.accounts.models(id)!;
    snapshot.models[0]!.capabilities.toolCalling = false;
    expect(h.accounts.models(id)?.models[0]?.capabilities.toolCalling).toBe(true);
    expect(h.accounts.list()[0]?.qualifiedModels).toEqual([]);
  });

  it("validates policy input instead of trusting renderer ownership or malformed budget fields", async () => {
    const h = harness();
    const id = (await h.accounts.connect("openrouter", { apiKey: "paid-key-a" })).connection!.connectionId;
    for (const monthlyBudgetCents of [-1, NaN, Infinity, 1.5]) expect(() => h.accounts.update(id, { monthlyBudgetCents })).toThrow("ACCOUNT_BUDGET_INVALID");
    expect(() => h.accounts.update(id, { ownerUserId: "forged" } as never)).toThrow("ACCOUNT_POLICY_INVALID");
    expect(() => h.accounts.update(id, { label: "sk-syntheticSecretString12345" })).toThrow("ACCOUNT_LABEL_INVALID");
  });
});

import React, { useEffect, useState } from "react";
import { AddProviderFlow } from "./AddProviderFlow.js";
import { CfSelect, SettingsButton, SettingsGroup, SettingsRow, StatusBadge, Toggle } from "./settings/settings-controls.js";
import type { ProviderConnectionView } from "./provider-connections-client.js";
import {
  addProviderAccount, connectProviderAccountOAuth, disconnectProviderAccount, notifyAccountUpdated,
  parseAccountBudgetCents, qualifyProviderAccount, replaceProviderAccountCredential, setProviderRoutingPolicy, updateProviderAccount,
  useProviderAccounts, type ConnectedAccountView, type ConnectedAccountResult, type ConnectedAccountPolicyPatch, type ProviderRoutingPolicy,
} from "./provider-accounts-client.js";

export interface ConnectedAccountsPanelProps {
  providers: ProviderConnectionView[];
  accounts?: ConnectedAccountView[];
  policy?: ProviderRoutingPolicy;
  onChanged?: () => void | Promise<void>;
}

const preferences = [
  { value: "AUTO", label: "Automatic" }, { value: "PREFERRED", label: "Prefer this account" },
  { value: "FALLBACK", label: "Use as fallback" }, { value: "MANUAL", label: "Manual selection" },
];
const modes = [
  { value: "FREE_ONLY", label: "FreeOnly" }, { value: "FREE_PREFERRED", label: "Free preferred" },
  { value: "PAID_PREFERRED", label: "Paid preferred" }, { value: "SPECIFIC_ACCOUNT", label: "Specific account" },
  { value: "AUTO_BEST", label: "Auto best" },
];

export function accountEligibilityLabel(account: ConnectedAccountView): string {
  if (!account.connected) return "Disconnected";
  if (account.authState === "auth_required") return "Reauthorization required";
  if (!account.enabled) return "Disabled";
  if (account.classification === "FREE_VERIFIED") return account.freeRouteCount > 0 ? "Free verified" : "No qualified Free route";
  if (account.classification === "PAID") return "Paid account";
  if (account.classification === "BLOCKED") return "Admission blocked";
  return "Free eligibility unverified";
}

export function accountPreferencePatch(label: string, preference: ConnectedAccountPolicyPatch["preference"], paidSpendingEnabled: boolean, budget: string): ConnectedAccountPolicyPatch {
  const monthlyBudgetCents = parseAccountBudgetCents(budget);
  if (monthlyBudgetCents === undefined || (paidSpendingEnabled && (monthlyBudgetCents === null || monthlyBudgetCents === 0))) {
    throw new Error("Set a monthly limit greater than zero before allowing paid inference. Use USD with at most two decimal places.");
  }
  return { label: label.trim(), preference, paidSpendingEnabled, monthlyBudgetCents };
}

function AccountPreferences({ account, busy, save }: { account: ConnectedAccountView; busy: boolean; save: (patch: ConnectedAccountPolicyPatch) => Promise<void> }): React.ReactElement {
  const [label, setLabel] = useState(account.label ?? "");
  const [preference, setPreference] = useState(account.preference);
  const [paid, setPaid] = useState(account.paidSpendingEnabled);
  const [budget, setBudget] = useState(account.monthlyBudgetCents === undefined ? "" : (account.monthlyBudgetCents / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLabel(account.label ?? ""); setPreference(account.preference); setPaid(account.paidSpendingEnabled);
    setBudget(account.monthlyBudgetCents === undefined ? "" : (account.monthlyBudgetCents / 100).toFixed(2)); setError(null);
  }, [account.connectionId, account.label, account.preference, account.paidSpendingEnabled, account.monthlyBudgetCents]);
  const submit = async () => {
    setError(null);
    try { await save(accountPreferencePatch(label, preference, paid, budget)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Account preferences could not be saved"); }
  };
  return <details className="provider-availability" style={{ marginTop: 10 }}>
    <summary>Account preferences and spending</summary>
    <SettingsRow title="Account label" control={<input className="api-key-input" aria-label={`Label for ${account.maskedIdentity}`} value={label} maxLength={80} autoComplete="off" disabled={busy} onChange={(event) => setLabel(event.target.value)} placeholder="Optional name" />} />
    <SettingsRow title="Account preference" control={<CfSelect label={`Preference for ${account.maskedIdentity}`} value={preference} options={preferences} disabled={busy} onChange={(next) => setPreference(next as ConnectedAccountView["preference"])} />} />
    <SettingsRow title="Allow paid inference on this account" description="Off by default. Saving this permission requires a monthly limit. Global routing and runtime spending checks still apply." control={<Toggle label={`Allow paid inference for ${account.maskedIdentity}`} checked={paid} disabled={busy || !account.connected} onChange={setPaid} />} />
    <SettingsRow title="Monthly limit (USD)" description="This local budget cannot guarantee a provider-side invoice cap. Provider charges may exceed an estimate. No automatic top-up or permission for another account." control={<input className="api-key-input" aria-label={`Monthly limit for ${account.maskedIdentity}`} type="text" inputMode="decimal" value={budget} autoComplete="off" disabled={busy} onChange={(event) => setBudget(event.target.value)} placeholder="0.00" />} />
    <div className="provider-actions"><SettingsButton disabled={busy} onClick={() => void submit()}>Save account preferences</SettingsButton></div>
    {error ? <p className="provider-error" role="alert">{error}</p> : null}
  </details>;
}

function RoutingPreferences({ accounts, policy, busy, save }: { accounts: ConnectedAccountView[]; policy: ProviderRoutingPolicy; busy: boolean; save: (next: ProviderRoutingPolicy) => Promise<void> }): React.ReactElement {
  const [mode, setMode] = useState(policy.mode);
  const [paidEnabled, setPaidEnabled] = useState(policy.paidEnabled === true && policy.mode !== "FREE_ONLY");
  const [explicitConsent, setExplicitConsent] = useState(policy.explicitConsent === true && policy.paidEnabled === true && policy.mode !== "FREE_ONLY");
  const [limitationsAcknowledged, setLimitationsAcknowledged] = useState(policy.limitationsAcknowledged === true && policy.paidEnabled === true && policy.mode !== "FREE_ONLY");
  const [specific, setSpecific] = useState(policy.specificAccountConnectionId ?? "");
  useEffect(() => {
    setMode(policy.mode); setPaidEnabled(policy.paidEnabled === true && policy.mode !== "FREE_ONLY"); setSpecific(policy.specificAccountConnectionId ?? "");
    setExplicitConsent(policy.explicitConsent === true && policy.paidEnabled === true && policy.mode !== "FREE_ONLY");
    setLimitationsAcknowledged(policy.limitationsAcknowledged === true && policy.paidEnabled === true && policy.mode !== "FREE_ONLY");
  }, [policy.mode, policy.paidEnabled, policy.explicitConsent, policy.limitationsAcknowledged, policy.specificAccountConnectionId]);
  const choices = accounts.filter((account) => account.connected && account.enabled).map((account) => ({ value: account.connectionId, label: `${account.providerName} · ${account.label ?? account.maskedIdentity}` }));
  return <details className="provider-availability" style={{ marginBottom: 12 }}>
    <summary>Routing preference · {modes.find((option) => option.value === policy.mode)?.label ?? "FreeOnly"} · {policy.paidEnabled === true && policy.mode !== "FREE_ONLY" ? "paid permission stored" : "paid spending off"}</summary>
    <SettingsRow title="Routing mode" control={<CfSelect label="Connected account routing mode" value={mode} options={modes} disabled={busy} onChange={(next) => { setMode(next as ProviderRoutingPolicy["mode"]); if (next === "FREE_ONLY") { setPaidEnabled(false); setExplicitConsent(false); setLimitationsAcknowledged(false); } }} />} />
    {mode === "SPECIFIC_ACCOUNT" ? <SettingsRow title="Specific account" control={<CfSelect label="Specific connected account" value={specific} options={[{ value: "", label: "Choose an enabled account" }, ...choices]} disabled={busy} onChange={setSpecific} />} /> : null}
    <SettingsRow title="Permit paid routes for this routing preference" description="Off by default, including Auto best. Paid inference also requires explicit permission and remaining budget on the selected account." control={<Toggle label="Permit paid account routing" checked={paidEnabled} disabled={busy || mode === "FREE_ONLY"} onChange={(next) => { setPaidEnabled(next); if (!next) { setExplicitConsent(false); setLimitationsAcknowledged(false); } }} />} />
    <SettingsRow title="I authorize paid inference on accounts I explicitly enabled for spending" control={<Toggle label="Authorize personal paid inference" checked={explicitConsent} disabled={busy || !paidEnabled} onChange={setExplicitConsent} />} />
    <SettingsRow title="I understand local budgets cannot guarantee a provider-side invoice cap" description="Provider charges may exceed an estimate. Availability remains finite and authorization or privacy checks can block requests. No automatic top-up. ForgeAuto/Free never uses paid fallback." control={<Toggle label="Acknowledge paid routing limits" checked={limitationsAcknowledged} disabled={busy || !paidEnabled} onChange={setLimitationsAcknowledged} />} />
    <div className="provider-actions"><SettingsButton disabled={busy || (paidEnabled && (!explicitConsent || !limitationsAcknowledged)) || (mode === "SPECIFIC_ACCOUNT" && !choices.some((choice) => choice.value === specific))} onClick={() => void save({ mode, paidEnabled: mode !== "FREE_ONLY" && paidEnabled, explicitConsent: paidEnabled && explicitConsent, limitationsAcknowledged: paidEnabled && limitationsAcknowledged, automaticTopUp: false, ...(mode === "SPECIFIC_ACCOUNT" ? { specificAccountConnectionId: specific } : {}) })}>Save routing preference</SettingsButton></div>
    <p className="settings-note">A routing preference never enables account spending. ForgeAuto/Free continues to require verified zero-cost routes.</p>
  </details>;
}

export function ConnectedAccountsPanel(props: ConnectedAccountsPanelProps): React.ReactElement {
  const live = useProviderAccounts();
  const accounts = props.accounts ?? live.accounts;
  const policy = props.policy ?? live.policy;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ providerId?: string; connectionId?: string; label?: string } | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const changed = async () => { notifyAccountUpdated(); await live.reload(); await props.onChanged?.(); };
  const run = async (key: string, operation: () => Promise<ConnectedAccountResult>, success: string) => {
    setBusy(key); setNote(null);
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error ?? "Account operation failed");
      await changed(); setNote(success);
    } catch (error) { setNote(error instanceof Error ? error.message : "Account operation failed"); }
    finally { setBusy(null); }
  };
  const reauthorize = (account: ConnectedAccountView) => {
    if (account.authMethod === "OAUTH_PKCE") void run(account.connectionId, () => connectProviderAccountOAuth(account.providerId, { label: account.label, reauthorizeConnectionId: account.connectionId }), "Account reauthorized");
    else { setNewLabel(account.label ?? ""); setAdding({ providerId: account.providerId, connectionId: account.connectionId, label: account.label }); }
  };
  const saved = async () => { setAdding(null); setNewLabel(""); await changed(); };
  return <SettingsGroup title={`Your connected accounts (${accounts.filter((account) => account.connected).length})`}>
    <p className="settings-note" style={{ padding: "0 14px" }}>Optional personal connections can expand your pool. CodeForge does not require an external provider account. New connections default to FreeOnly with paid spending off.</p>
    <RoutingPreferences accounts={accounts} policy={policy} busy={busy !== null} save={async (next) => { await run("routing", async () => await setProviderRoutingPolicy(next), "Routing preference saved"); }} />
    {accounts.map((account) => <div className="provider-card" key={account.connectionId} data-connection-id={account.connectionId}>
      <div className="provider-card-header">
        <div className="provider-info"><h3 className="provider-name">{account.providerName}{account.label ? ` · ${account.label}` : ""}</h3><p className="provider-description">{account.maskedIdentity} · {account.authMethod === "OAUTH_PKCE" ? "Browser authorization" : account.authMethod === "ENVIRONMENT" ? "Environment credential" : "Encrypted API key"}</p></div>
        <StatusBadge kind={!account.connected || account.authState === "auth_required" ? "warn" : account.classification === "BLOCKED" ? "error" : account.classification === "FREE_VERIFIED" && account.freeRouteCount > 0 && account.enabled ? "ok" : "info"}>{accountEligibilityLabel(account)}</StatusBadge>
      </div>
      <div className="provider-models"><span className="provider-badge">{account.freeOnly ? "FreeOnly" : "Account spending permission stored"}</span><span className="provider-badge">{account.paidSpendingEnabled ? "Paid spending permission on" : "Paid spending off"}</span><span className="provider-badge">{account.qualifiedModels.length} qualified models · {account.freeRouteCount} Free routes</span></div>
      <p className="provider-description">{account.quotaSummary ?? "Quota not yet observed"} · {account.health ?? "Health not yet observed"}</p>
      {account.paidSpendingEnabled && !account.paidDispatchEligible ? <p className="settings-note">Paid inference is currently blocked by runtime spending or routing checks.</p> : null}
      {account.reason ? <p className="settings-note">{account.reason.replaceAll("_", " ")}</p> : null}
      <div className="provider-actions">
        <label className="settings-note" style={{ display: "flex", alignItems: "center", gap: 8 }}><Toggle label={`Enable ${account.providerName} ${account.maskedIdentity}`} checked={account.connected && account.enabled} disabled={busy !== null || !account.connected} onChange={(enabled) => void run(account.connectionId, () => updateProviderAccount(account.connectionId, { enabled }), enabled ? "Account enabled" : "Account disabled")} />Enabled</label>
        <SettingsButton disabled={busy !== null} onClick={() => reauthorize(account)}>{account.authMethod === "OAUTH_PKCE" ? "Reauthorize" : "Replace credential"}</SettingsButton>
        {account.classification === "FREE_VERIFIED" ? <SettingsButton disabled={busy !== null || !account.connected || !account.enabled || account.authState !== "ok"} onClick={() => void run(`qualify:${account.connectionId}`, () => qualifyProviderAccount(account.connectionId), "Free model qualification finished; check eligible models above")}>Qualify Free models</SettingsButton> : null}
        <SettingsButton disabled={busy !== null || !account.connected} onClick={() => void run(account.connectionId, () => disconnectProviderAccount(account.connectionId), "Account disconnected; saved credential deleted and spending permission reset")}>Disconnect</SettingsButton>
      </div>
      <AccountPreferences account={account} busy={busy !== null} save={(patch) => run(account.connectionId, () => updateProviderAccount(account.connectionId, patch), "Account preferences saved")} />
    </div>)}
    {accounts.length === 0 ? <p className="settings-note" style={{ padding: "0 14px" }}>No personal accounts connected. Packaged Free routes remain available when qualified capacity is healthy.</p> : null}
    <div className="provider-actions" style={{ padding: "0 14px 12px" }}><SettingsButton disabled={busy !== null} onClick={() => { setNewLabel(""); setAdding({}); }}>Add Account</SettingsButton></div>
    {adding ? <div style={{ padding: "0 14px 14px" }}>
      <SettingsRow title={adding.connectionId ? "Replace this account's credential" : "New account label"} control={<input className="api-key-input" aria-label="New account label" autoComplete="off" value={newLabel} maxLength={80} disabled={!!adding.connectionId} onChange={(event) => setNewLabel(event.target.value)} placeholder="Optional name" />} />
      <AddProviderFlow providers={adding.providerId ? props.providers.filter((provider) => provider.providerId === adding.providerId) : props.providers} initialProviderId={adding.providerId} compact onConnected={() => void saved()} onCancel={() => setAdding(null)} accountTransport={{
        connect: async (providerId, fields) => { const result = adding.connectionId ? await replaceProviderAccountCredential(adding.connectionId, fields) : await addProviderAccount(providerId, fields, newLabel.trim() || undefined); return { ok: result.ok, error: result.error, verifiedFree: result.connection?.freeRouteCount }; },
        oauth: async (providerId) => { const result = await connectProviderAccountOAuth(providerId, { label: newLabel.trim() || undefined, ...(adding.connectionId ? { reauthorizeConnectionId: adding.connectionId } : {}) }); return { ok: result.ok, error: result.error, verifiedFree: result.connection?.freeRouteCount }; },
      }} />
    </div> : null}
    {note ? <p className="settings-note" role="status">{note}</p> : null}
  </SettingsGroup>;
}

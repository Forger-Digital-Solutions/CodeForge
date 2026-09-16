import React, { useMemo, useState } from "react";
import { useSettings } from "../settings-context.js";
import { CfSelect, SettingsButton, SettingsGroup, SettingsRow, StatusBadge, Toggle } from "../settings-controls.js";
import { AddProviderFlow } from "../../AddProviderFlow.js";
import {
  attestFreePlan,
  connectOpenRouterOAuth,
  disconnectProvider,
  importEnvironmentCredential,
  notifyProviderUpdated,
  refreshEnvironment,
  setEnvironmentEnabled,
  setEnvironmentPolicy,
  setGeminiFreePolicyAccepted,
  useProviderConnections,
  type EnvironmentCredentialView,
  type FreeCloudSummaryView,
  type ProviderConnectionView,
} from "../../provider-connections-client.js";
import type { EnvironmentCredentialPolicy } from "@codeforge/model-registry";

/**
 * Provider Connections (R1 §20, §93-§96, §178-§180). Connection cards, detected environment
 * credentials with per-provider toggles, and the ZCode-style Add Provider flow. Secrets are never
 * displayed — only variable names, connection sources and counts.
 */
export interface ProvidersSectionProps {
  /** Test seams: static fixtures instead of the live bridge. */
  connections?: ProviderConnectionView[];
  environment?: EnvironmentCredentialView[];
  summary?: FreeCloudSummaryView | null;
  policy?: EnvironmentCredentialPolicy;
}

const POLICY_OPTIONS = [
  { value: "OFF", label: "Off — never use environment credentials" },
  { value: "FREE_ROUTES_ONLY", label: "Free routes only (recommended)" },
  { value: "ALL_ENABLED_BYOK_ROUTES", label: "All enabled routes (incl. BYOK / paid)" },
];

function sourceLabel(c: ProviderConnectionView): string {
  switch (c.credentialSource) {
    case "OAUTH":
      return "OAuth";
    case "ENVIRONMENT":
      return `Environment · ${c.environmentVariable ?? "detected"}`;
    case "FDS_GATEWAY":
      return "CodeForge account";
    case "MANUAL_BYOK":
    case "SECURE_STORAGE":
      return "Secure key · user provided";
    default:
      return "Not connected";
  }
}

function accessLabel(c: ProviderConnectionView): string {
  switch (c.freeAccess.class) {
    case "FREE_API":
      return "Free routes ($0 listed)";
    case "FREE_DAILY_ALLOCATION":
      return "Free daily allocation";
    case "FREE_MONTHLY_ALLOWANCE":
      return "Free monthly allowance";
    case "FREE_ACCOUNT_ENTITLEMENT":
      return "Free tier (account)";
    case "PROMOTIONAL_CREDIT":
      return "Promotional credit only — not ForgeAuto/Free";
    case "FREE_DEV_ENDPOINT":
      return "Development endpoint — not ForgeAuto/Free";
    case "PAID_API":
      return "Paid only — never in free routing";
    case "LEGAL_REVIEW_REQUIRED":
      return "Terms under review — BYOK only";
    case "FREE_PRODUCT_ONLY":
      return "No API entitlement";
    default:
      return c.freeAccess.class;
  }
}

export function ProvidersSection(props: ProvidersSectionProps = {}): React.ReactElement {
  const ctx = useSettings();
  const live = useProviderConnections();
  const connections = props.connections ?? live.connections;
  const environment = props.environment ?? live.environment;
  const summary = props.summary === undefined ? live.summary : props.summary;
  const policy = props.policy ?? live.policy;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = connections.filter((c) => c.implemented || c.connected);
    const filtered = q
      ? list.filter((c) => [c.displayName, c.providerId, c.freeAccess.class, ...c.fields.flatMap((f) => f.environmentAliases)].join(" ").toLowerCase().includes(q))
      : list;
    return showAll || q ? filtered : filtered.filter((c) => c.connected || c.environment?.complete || c.recommendedForFreeDefault || c.zeroCashFreeAccess || c.paidOnly);
  }, [connections, query, showAll]);

  const connectedCount = connections.filter((c) => c.connected).length;
  const detected = environment.filter((e) => e.anyDetected);

  const run = async (key: string, fn: () => Promise<void>, doneNote?: string) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      if (doneNote) setNote(doneNote);
      notifyProviderUpdated();
      await ctx.refreshModels();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1 className="settings-section-title">Provider Connections</h1>
      <p className="settings-section-subtitle">
        Optional providers expand CodeForge beyond the built-in Free / ForgeAuto model catalog. CodeForge Free and
        ForgeAuto/Free remain fully usable without any provider configuration where eligible free routes exist.
        Credentials stay on this device, encrypted; environment credentials are read live and never copied.
      </p>

      <SettingsGroup title="Free Cloud Models">
        <SettingsRow
          title={summary ? `${summary.verifiedFreeModels} verified free models · ${summary.healthyFreeRoutes} healthy routes` : "Registry loading…"}
          description={
            summary
              ? `${summary.connectedProviders} connected provider${summary.connectedProviders === 1 ? "" : "s"} · ${summary.coolingDown} cooling down · ${summary.primaryCodingModels} primary coding model${summary.primaryCodingModels === 1 ? "" : "s"} · ${summary.paidRoutesExcluded} paid route${summary.paidRoutesExcluded === 1 ? "" : "s"} excluded from ForgeAuto/Free${summary.pendingQualification ? ` · ${summary.pendingQualification} route${summary.pendingQualification === 1 ? "" : "s"} awaiting 8-Bit qualification` : ""}`
              : "Counts come from the live 8-Bit registry — never estimated."
          }
          control={<StatusBadge kind={summary && summary.healthyFreeRoutes > 0 ? "ok" : summary?.qualifying ? "info" : "warn"}>{summary && summary.healthyFreeRoutes > 0 ? "Ready" : summary?.qualifying ? "Qualifying…" : "No free route"}</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title={`Detected environment credentials (${detected.length})`}>
        <SettingsRow
          title="Use detected environment credentials"
          description="CodeForge looks only at environment variables that providers document (never files or history). Values never leave the trusted process; Settings shows names only."
          control={
            <CfSelect
              label="Environment credential policy"
              value={policy}
              options={POLICY_OPTIONS}
              onChange={(next) => void run("policy", () => setEnvironmentPolicy(next as EnvironmentCredentialPolicy), "Policy updated")}
            />
          }
        />
        {detected.length === 0 ? (
          <SettingsRow title="No provider credentials detected" description="Supported variables include OPENROUTER_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, ZAI_API_KEY, MISTRAL_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, and more from provider metadata." />
        ) : (
          detected.map((e) => {
            const variables = e.fields.filter((f) => f.detected).map((f) => f.variable).join(" + ");
            const missing = e.fields.filter((f) => !f.detected && !f.optional).map((f) => f.aliases[0]);
            return (
              <SettingsRow
                key={e.providerId}
                title={e.displayName}
                description={`${variables} · ${e.complete ? "Detected in environment" : `Partial — also needs ${missing.join(", ")}`}${e.paidOnly ? " · Paid provider · Not used by ForgeAuto/Free" : ""}${e.policyBlocked && !e.paidOnly ? ` · ${e.policyBlockedReason}` : ""}${e.active ? " · In use" : ""}`}
                control={
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {e.paidOnly ? <span className="settings-note">{e.enabled ? "Enabled for BYOK" : "Enable for BYOK"}</span> : null}
                    <Toggle
                      label={`Use ${e.displayName} environment credential`}
                      checked={e.enabled}
                      disabled={!e.complete || busy !== null}
                      onChange={(next) => void run(`env:${e.providerId}`, () => setEnvironmentEnabled(e.providerId, next), next ? `${e.displayName} enabled` : `${e.displayName} disabled`)}
                    />
                  </span>
                }
              />
            );
          })
        )}
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-description">Changed a variable? Refresh re-reads the process and user environment without a restart.</div>
          </div>
          <div className="settings-row-control">
            <SettingsButton disabled={busy !== null} onClick={() => void run("refresh-env", async () => { const r = await refreshEnvironment(); if (r) setNote(`Checked ${r.queried} variables · ${r.updated} newly available`); })}>
              {busy === "refresh-env" ? "Refreshing…" : "Refresh detected credentials"}
            </SettingsButton>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={`Your providers (${connectedCount} connected)`}>
        <div className="provider-search-row">
          <input
            className="model-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers…"
            aria-label="Search providers"
          />
          <label className="settings-note" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all providers
          </label>
        </div>
        {visible.map((c) => {
          const oauth = c.authClasses.includes("OAUTH_PKCE");
          const envReady = c.environment?.complete && !c.environment.enabled && !c.environment.policyBlocked;
          return (
            <div key={c.providerId} className="provider-card" data-provider-id={c.providerId}>
              <div className="provider-card-header">
                <div className="provider-info">
                  <h3 className="provider-name">{c.displayName}</h3>
                  <p className="provider-description">
                    {accessLabel(c)}
                    {c.freeAccess.quota ? ` · ${c.freeAccess.quota}` : ""}
                    {c.privacy.freeTierClass === "permissive" ? " · Free tier may use prompts to improve the provider's products" : ""}
                  </p>
                </div>
                <div className={`provider-status ${c.connected ? (c.authState === "auth_required" ? "error" : "connected") : "not_connected"}`}>
                  {c.connected ? (c.authState === "auth_required" ? "✗ Credential rejected" : "✓ Connected") : c.environment?.complete ? "● Environment credential detected" : "Not connected"}
                </div>
              </div>
              <div className="provider-models">
                <span className="provider-badge">{c.connected ? `Credential source: ${sourceLabel(c)}` : c.connectOffer ? c.connectOffer.label : "No connection method"}</span>
                {c.connected ? <span className={`provider-badge ${c.freeRouteCount > 0 ? "free" : ""}`}>{c.freeRouteCount} free route{c.freeRouteCount === 1 ? "" : "s"} · {c.healthyRouteCount} ForgeAuto-eligible</span> : null}
                {c.terms.status !== "CLEARED" ? <span className="provider-badge paid">{c.terms.status.replace(/_/g, " ").toLowerCase()}</span> : null}
              </div>
              {c.policyMetadata?.user_policy_acceptance_required ? (
                <div className="provider-availability" data-policy="gemini-free">
                  <p className="settings-note">
                    {c.geminiPolicyBlockedReason === "GEMINI_FREE_POLICY_ACCEPTED"
                      ? "Gemini Free Tier data-use notice accepted for this account and region."
                      : "Gemini Free Tier is policy-gated: a trusted project identity, eligible region, and current acknowledgment are required."}{" "}
                    <a href={c.policyMetadata.official_terms_url} target="_blank" rel="noreferrer">Read Google's Gemini API Additional Terms</a>.
                  </p>
                  <label className="settings-note" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={c.geminiPolicyAccepted === true}
                      disabled={busy !== null || c.geminiPolicyBlockedReason === "GEMINI_REGION_UNKNOWN" || c.geminiPolicyBlockedReason === "GEMINI_PAID_REQUIRED_BY_REGION"}
                      onChange={(e) => void run("gemini-policy", () => setGeminiFreePolicyAccepted(e.target.checked), e.target.checked ? "Gemini Free Tier notice accepted" : "Gemini Free Tier notice withdrawn")}
                    />
                    <span>{c.policyMetadata.user_policy_acceptance_required ? "I understand and accept the Gemini API Free Tier data-use notice." : ""}</span>
                  </label>
                </div>
              ) : null}
              {c.connected && c.planAttestationRequired ? (
                <div className="provider-availability">
                  <label className="settings-note" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Toggle
                      label={`${c.displayName} account is on the free plan`}
                      checked={c.planAttested}
                      disabled={busy !== null}
                      onChange={(next) => void run(`attest:${c.providerId}`, () => attestFreePlan(c.providerId, next), next ? "Free plan confirmed — verifying free routes" : "Free-plan confirmation removed")}
                    />
                    <span>This account is on {c.displayName}'s free plan (no payment method / paid plan). Required before ForgeAuto/Free uses its allowance — a paid plan would bill.</span>
                  </label>
                </div>
              ) : null}
              <div className="provider-actions">
                {!c.connected && oauth ? (
                  <button type="button" className="provider-btn primary" disabled={busy !== null} onClick={() => void run(`oauth:${c.providerId}`, async () => { const r = await connectOpenRouterOAuth(); if (!r.ok) throw new Error(r.error ?? "Authorization failed"); }, `${c.displayName} connected`)}>
                    {busy === `oauth:${c.providerId}` ? "Waiting for browser…" : `Connect ${c.displayName}`}
                  </button>
                ) : null}
                {!c.connected && envReady ? (
                  <button type="button" className="provider-btn save" disabled={busy !== null} onClick={() => void run(`env:${c.providerId}`, () => setEnvironmentEnabled(c.providerId, true), `${c.displayName} enabled from environment`)}>
                    Use Environment Credential
                  </button>
                ) : null}
                {!c.connected && c.fields.length > 0 ? (
                  <button type="button" className="provider-btn test" disabled={busy !== null} onClick={() => setKeyFor(keyFor === c.providerId ? null : c.providerId)}>
                    {keyFor === c.providerId ? "Cancel" : oauth || envReady ? "Add key instead" : `Connect ${c.displayName}`}
                  </button>
                ) : null}
                {c.connected && c.credentialSource === "ENVIRONMENT" ? (
                  <>
                    <button type="button" className="provider-btn test" disabled={busy !== null} onClick={() => void run(`env:${c.providerId}`, () => setEnvironmentEnabled(c.providerId, false), `${c.displayName} disabled`)}>Disable</button>
                    <button type="button" className="provider-btn test" disabled={busy !== null} title="Copies the value into CodeForge's encrypted storage so it no longer depends on the environment variable" onClick={() => void run(`import:${c.providerId}`, async () => { const r = await importEnvironmentCredential(c.providerId); if (!r.ok) throw new Error(r.error ?? "Import failed"); }, "Imported to secure storage")}>Import to secure storage</button>
                  </>
                ) : null}
                {c.connected && c.credentialSource !== "ENVIRONMENT" && c.credentialSource !== "FDS_GATEWAY" ? (
                  <button type="button" className="provider-btn delete" disabled={busy !== null} onClick={() => void run(`disconnect:${c.providerId}`, () => disconnectProvider(c.providerId), `${c.displayName} disconnected`)}>Disconnect</button>
                ) : null}
              </div>
              {keyFor === c.providerId ? (
                <div style={{ marginTop: 10 }}>
                  <AddProviderFlow providers={connections} initialProviderId={c.providerId} compact onConnected={() => { setKeyFor(null); void ctx.refreshModels(); }} onCancel={() => setKeyFor(null)} />
                </div>
              ) : null}
            </div>
          );
        })}
        {visible.length === 0 ? <div className="settings-note">No providers match “{query}”.</div> : null}
      </SettingsGroup>

      <SettingsGroup title="Add provider">
        <div style={{ padding: "0 14px 14px" }}>
          <AddProviderFlow providers={connections} onConnected={() => void ctx.refreshModels()} />
        </div>
      </SettingsGroup>

      {note ? <div className="settings-note" role="status">{note}</div> : null}
      <div className="provider-setup-note" role="note" aria-label="Free Mode note">
        <p>
          <strong>ForgeAuto/Free:</strong> only routes that 8-Bit has verified as $0 and qualified for coding are used.
          Paid providers (OpenAI, Anthropic, DeepSeek direct) are available for BYOK but never selected by ForgeAuto/Free.
          Free availability is provider-controlled and may change; routes that stop qualifying are removed automatically.
        </p>
      </div>
    </div>
  );
}

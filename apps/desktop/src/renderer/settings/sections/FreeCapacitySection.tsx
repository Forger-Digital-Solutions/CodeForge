import React, { useState } from "react";
import { useSettings } from "../settings-context.js";
import { SettingsButton, SettingsGroup, SettingsRow, StatusBadge } from "../settings-controls.js";
import { connectOpenRouterOAuth, disconnectProvider, notifyProviderUpdated, useProviderConnections, type ProviderConnectionView } from "../../provider-connections-client.js";

const candidates = [
  { id: "openrouter", name: "OpenRouter", scope: "User account", url: "https://openrouter.ai/docs/guides/overview/auth/oauth", blocker: "Sign in to a personal Free account. CodeForge checks the account tier, quota and ownership before admitting it." },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", scope: "Cloudflare account", url: "https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/", blocker: "Verification needs Account Read, Billing Read and Workers AI usage access. A token restricted to inference cannot verify the Workers Free plan. Free admission remains blocked." },
  { id: "groq", name: "Groq", scope: "Organization", url: "https://console.groq.com/docs/rate-limits", blocker: "Organization ownership, Free billing tier and current quota must be verified. A key alone is insufficient." },
  { id: "cerebras", name: "Cerebras", scope: "Account / project", url: "https://inference-docs.cerebras.ai/support/rate-limits", blocker: "The current offer is a trial. A durable Free entitlement is required." },
  { id: "puter", name: "Puter", scope: "Puter user", url: "https://docs.puter.com/Objects/monthlyusage/", blocker: "Free and purchased allowance cannot yet be distinguished. Free admission is blocked." },
] as const;

export function freeCapacityStatus(connection?: ProviderConnectionView): string {
  if (connection?.freeConnectionAttempt?.accountClass === "PAID") return "PAID ACCOUNT — NOT ELIGIBLE FOR FORGEAUTO/FREE";
  if (connection?.authState === "auth_required" || connection?.freeConnectionAttempt?.accountClass === "REVOKED") return "REAUTH REQUIRED";
  if (connection?.freeConnectionAttempt?.accountClass === "UNKNOWN" || connection?.delegatedFree?.accountClass === "UNKNOWN") return "STATUS UNKNOWN — NOT ADMITTED";
  if (connection?.delegatedFree?.accountClass === "PAID") return "PAID ACCOUNT — NOT ELIGIBLE FOR FORGEAUTO/FREE";
  if (connection?.delegatedFree?.accountClass === "FREE_VERIFIED" && connection.delegatedFree.remainingRequests === 0) return "EXHAUSTED";
  if ((connection?.freeCapacity?.admittedDomains ?? 0) > 0) return connection?.authState === "rate_limited" ? "RATE LIMITED"
    : (connection?.freeCapacity?.healthyGroups ?? 0) > 0 ? "FREE VERIFIED · HEALTHY" : "FREE VERIFIED";
  return "STATUS UNKNOWN — NOT ADMITTED";
}

export function FreeCapacitySection(props: { connections?: ProviderConnectionView[] } = {}): React.ReactElement {
  const ctx = useSettings();
  const live = useProviderConnections();
  const connections = props.connections ?? live.connections;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const kilo = connections.find((connection) => connection.providerId === "kilo-free-direct");
  const horde = connections.find((connection) => connection.providerId === "ai-horde");
  const refresh = async () => { notifyProviderUpdated(); await live.reload(); await ctx.refreshModels(); };
  const connect = async (browser: "default" | "firefox" = "default") => {
    setBusy(true); setNote("Complete OpenRouter sign-in in your browser, then return here.");
    try {
      const result = await connectOpenRouterOAuth(browser);
      setNote(result.ok ? "Account verified. Eligible models are qualified automatically; capacity appears when admission passes." : result.error ?? "Free account verification failed.");
      await refresh();
    } catch { setNote("Connection failed. Try again."); }
    finally { setBusy(false); }
  };
  const disconnect = async (providerId: string) => {
    setBusy(true);
    try { await disconnectProvider(providerId); await refresh(); setNote("Disconnected. The saved credential was deleted and its Free routes removed."); }
    catch { setNote("Disconnect failed. Try again."); }
    finally { setBusy(false); }
  };
  return <div>
    <h1 className="settings-section-title">Free Capacity</h1>
    <p className="settings-section-subtitle">Add independent Free accounts to keep working when one provider runs out. Credentials stay encrypted on this device. Free exhaustion stops execution; purchased credits, Paid Auto and BYOK require an explicit mode change.</p>
    {note ? <p className="settings-note" role="status">{note}</p> : null}
    <SettingsGroup title="Available automatically">
      <SettingsRow title="Kilo Gateway" description={`Connected automatically when capacity is available · Quota scope: network / egress. Users sharing the same or unknown egress share one quota group. ${kilo?.freeCapacity?.healthyGroups ?? 0} healthy groups.`}
        control={<StatusBadge kind={(kilo?.freeCapacity?.healthyGroups ?? 0) > 0 ? "ok" : "warn"}>{freeCapacityStatus(kilo)}</StatusBadge>} />
      <SettingsRow title="AI Horde Community" description={`Connected automatically · Quota scope: one global community pool shared by all anonymous callers — never private capacity. Public code only. ${horde?.freeCapacity?.healthyGroups ?? 0} healthy groups.`}
        control={<StatusBadge kind={(horde?.freeCapacity?.healthyGroups ?? 0) > 0 ? "ok" : "warn"}>{freeCapacityStatus(horde)}</StatusBadge>} />
    </SettingsGroup>
    <SettingsGroup title="Your Free accounts">
      {candidates.map((candidate) => {
        const connection = connections.find((item) => item.providerId === candidate.id);
        const status = freeCapacityStatus(connection);
        return <div className="provider-card" key={candidate.id} data-provider-id={candidate.id}>
          <h3 className="provider-name">{candidate.name}</h3>
          <StatusBadge kind={status.includes("HEALTHY") ? "ok" : "warn"}>{status}</StatusBadge>
          <p className="provider-description">Quota scope: {candidate.scope} · {connection?.freeCapacity?.independentGroups ?? 0} admitted groups</p>
          <p className="provider-description">{candidate.blocker}</p>
          {candidate.id === "openrouter" ? <><SettingsButton variant="primary" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect OpenRouter Free"}</SettingsButton><SettingsButton disabled={busy} onClick={() => void connect("firefox")}>Connect in Firefox</SettingsButton></>
            : <SettingsButton onClick={() => ctx.openExternal(candidate.url)}>Account requirements</SettingsButton>}
          {connection?.connected && connection.credentialSource === "OAUTH" ? <SettingsButton disabled={busy} onClick={() => void disconnect(candidate.id)}>Disconnect</SettingsButton> : null}
        </div>;
      })}
    </SettingsGroup>
  </div>;
}

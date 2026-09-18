import React, { useState } from "react";
import { AddProviderFlow } from "./AddProviderFlow.js";
import { SettingsButton, SettingsGroup, StatusBadge } from "./settings/settings-controls.js";
import {
  disconnectProvider,
  notifyProviderUpdated,
  type ProviderConnectionView,
} from "./provider-connections-client.js";

function openExternal(url: string): void {
  void window.electronAPI?.openExternal?.(url);
}

export interface OllamaUserConnectedFreePanelProps {
  connection?: ProviderConnectionView;
  onChanged?: () => void;
}

/** Compact first-class Free Cloud UX for the user's own Ollama account. */
export function OllamaUserConnectedFreePanel({ connection, onChanged }: OllamaUserConnectedFreePanelProps): React.ReactElement | null {
  const profile = connection?.userConnectedFree;
  const [flowOpen, setFlowOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!profile || !connection) return null;

  const needsReauth = profile.status === "REAUTH_REQUIRED";
  const connected = connection.connected && !needsReauth;
  const status = needsReauth ? "Reconnect Ollama" : connected ? "Connected" : "Not connected";
  const usage = profile.includedUsageRemainingUsd === undefined ? "Not observable" : `$${profile.includedUsageRemainingUsd.toFixed(2)} included remaining`;
  const reset = profile.includedUsageResetAt ? new Date(profile.includedUsageResetAt).toLocaleDateString() : "Not observable";

  const disconnect = async () => {
    setBusy(true);
    try {
      await disconnectProvider("ollama-cloud");
      notifyProviderUpdated();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Add More Free Capacity">
      <div className="provider-card ollama-user-free-card" data-provider-id="ollama-cloud" data-supply-class="USER_CONNECTED_FREE">
        <div className="provider-card-header">
          <div className="provider-info">
            <h3 className="provider-name">Ollama Cloud</h3>
            <p className="provider-description">Free account · Monthly included usage · Private cloud inference</p>
          </div>
          <div className={`provider-status ${connected ? "connected" : needsReauth ? "error" : "not_connected"}`}>
            {status}
          </div>
        </div>

        {!profile.enabled ? (
          <p className="settings-note">Internal preview: user-connected Ollama Free is behind the <code>ollamaUserConnectedFree</code> rollout flag while free-only hard-stop and terms evidence are completed.</p>
        ) : null}

        {connected ? (
          <>
            <div className="provider-models">
              <span className="provider-badge free">Free · your account</span>
              <span className="provider-badge">Usage: {usage}</span>
              <span className="provider-badge">Reset: {reset}</span>
              <span className="provider-badge">Concurrency: 1</span>
              <span className="provider-badge">Models: {profile.starterModels.length}</span>
            </div>
            <p className="settings-note">ForgeAuto/Free can use only your included Ollama allowance. Purchased credits, subscriptions, and auto-reload are never used by this connection.</p>
            <div className="provider-actions">
              <SettingsButton onClick={() => openExternal(profile.usageUrl)}>Open Ollama Usage</SettingsButton>
              <SettingsButton onClick={() => setFlowOpen(true)} disabled={busy}>Replace API key</SettingsButton>
              <SettingsButton onClick={() => void disconnect()} disabled={busy}>{busy ? "Disconnecting…" : "Disconnect"}</SettingsButton>
            </div>
          </>
        ) : (
          <>
            <p className="settings-note">Connect your own Ollama Cloud Free account to add its personal monthly allowance to this CodeForge installation. Ollama Cloud works directly over HTTPS; no local Ollama install or GPU is required.</p>
            <div className="provider-actions">
              <SettingsButton variant="primary" onClick={() => setFlowOpen(true)} disabled={!profile.enabled}>Connect Free Ollama</SettingsButton>
              <SettingsButton onClick={() => openExternal(profile.signupUrl)} disabled={!profile.enabled}>Create Free Ollama Account</SettingsButton>
              <SettingsButton onClick={() => openExternal(profile.apiKeysUrl)} disabled={!profile.enabled}>Create Ollama API Key</SettingsButton>
            </div>
          </>
        )}

        {profile.termsClassification !== "USER_CONNECTED_FREE_ALLOWED" ? <p className="settings-note">Terms status: permission review required. This connection remains an internal candidate and is not added to public ForgeAuto/Free until the design is cleared.</p> : null}
        {flowOpen ? (
          <div style={{ marginTop: 12 }}>
            <div className="settings-note">Create a key named <code>CodeForge</code>, copy it, and return here.</div>
            <AddProviderFlow
              providers={[connection]}
              initialProviderId="ollama-cloud"
              compact
              onConnected={() => { setFlowOpen(false); notifyProviderUpdated(); onChanged?.(); }}
              onCancel={() => setFlowOpen(false)}
            />
          </div>
        ) : null}
        {needsReauth ? <StatusBadge kind="warn">API key rejected — reconnect required</StatusBadge> : null}
      </div>
    </SettingsGroup>
  );
}

export default OllamaUserConnectedFreePanel;

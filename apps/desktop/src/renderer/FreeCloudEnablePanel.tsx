import React, { useEffect, useState } from "react";
import { SettingsButton } from "./settings/settings-controls.js";
import { AddProviderFlow } from "./AddProviderFlow.js";
import {
  attestFreePlan,
  connectOpenRouterOAuth,
  fetchConnections,
  fetchFreeCloudOffer,
  notifyProviderUpdated,
  setEnvironmentEnabled,
  type FirstRunOffer,
  type ProviderConnectionView,
} from "./provider-connections-client.js";

/**
 * "Enable Free Cloud Models" (R1 §68-§72, §111). One recommended, lowest-friction action; other
 * options tucked underneath. Never a raw "missing API key" — always the next thing to click.
 *
 * Two entry points share it: ForgeAuto/Free with no eligible route (first run), and a picked
 * model whose free routes are all unconnected (`target` names the model).
 */
export interface FreeCloudEnablePanelProps {
  target?: { displayName: string; providerId?: string; authClass?: string; label?: string; environmentVariable?: string; planAttestation?: boolean };
  onDone?: () => void;
  onClose?: () => void;
  onOpenSettings?: () => void;
  inline?: boolean;
}

/** Product wording for OAuth failures — the raw reason stays in diagnostics. */
export function friendlyOAuthError(raw: string | undefined): string {
  const m = (raw ?? "").toLowerCase();
  if (m.includes("state mismatch") || m.includes("csrf")) return "Authorization was rejected by a security check. Please try again from CodeForge.";
  if (m.includes("timed out")) return "Authorization timed out before the browser step was completed. Try again when ready.";
  if (m.includes("smoke")) return "Connection is unavailable in this mode.";
  return "Authorization did not complete. You can retry, or use another option below.";
}

export function FreeCloudEnablePanel({ target, onDone, onClose, onOpenSettings, inline }: FreeCloudEnablePanelProps): React.ReactElement {
  const [offer, setOffer] = useState<FirstRunOffer | null>(null);
  const [providers, setProviders] = useState<ProviderConnectionView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualProvider, setManualProvider] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [o, p] = await Promise.all([fetchFreeCloudOffer(), fetchConnections()]);
      setOffer(o);
      setProviders(p);
    })();
  }, []);

  const finish = () => {
    notifyProviderUpdated();
    onDone?.();
  };

  const runOAuth = async () => {
    setBusy("oauth");
    setError(null);
    try {
      const r = await connectOpenRouterOAuth();
      if (!r.ok) setError(friendlyOAuthError(r.error));
      else finish();
    } finally {
      setBusy(null);
    }
  };

  const runEnv = async (providerId: string) => {
    setBusy(`env:${providerId}`);
    setError(null);
    try {
      await setEnvironmentEnabled(providerId, true);
      finish();
    } catch {
      setError("Could not enable the detected credential.");
    } finally {
      setBusy(null);
    }
  };

  const runAttest = async (providerId: string) => {
    setBusy(`attest:${providerId}`);
    setError(null);
    try {
      await attestFreePlan(providerId, true);
      finish();
    } catch {
      setError("Could not record the free-plan confirmation.");
    } finally {
      setBusy(null);
    }
  };

  // Primary recommendation: the target model's own best offer when given, else the global offer.
  const targetOffer = target?.authClass && target.providerId ? { authClass: target.authClass, providerId: target.providerId, label: target.label, variable: target.environmentVariable, planAttestation: target.planAttestation } : null;
  const heading = target ? `Enable ${target.displayName}` : "Enable Free Cloud Models";
  const envOptions = providers.filter((p) => p.environment?.complete && !p.environment.enabled && !p.environment.policyBlocked && p.zeroCashFreeAccess && p.terms.status === "CLEARED");
  const oauthProvider = providers.find((p) => p.authClasses[0] === "OAUTH_PKCE" && p.implemented && !p.connected);
  const manualProviders = providers.filter((p) => p.implemented && p.zeroCashFreeAccess && p.terms.status === "CLEARED" && !p.connected && p.fields.length > 0);

  const renderPrimary = (): React.ReactElement | null => {
    if (targetOffer?.planAttestation) {
      const p = providers.find((x) => x.providerId === targetOffer.providerId);
      return (
        <div className="free-cloud-primary">
          <div className="free-cloud-primary-title">{p?.displayName ?? targetOffer.providerId} is connected · confirm the free plan</div>
          <div className="free-cloud-primary-desc">
            {p?.displayName ?? "This provider"}'s free tier depends on the account: on a paid plan the same key would be billed. CodeForge only uses this allowance after you confirm the account has no paid plan or payment method attached.
            {p?.freeAccess.quota ? ` Free tier: ${p.freeAccess.quota}.` : ""}
          </div>
          <SettingsButton variant="primary" onClick={() => void runAttest(targetOffer.providerId)} disabled={busy !== null}>
            {busy === `attest:${targetOffer.providerId}` ? "Confirming…" : "My account is on the free plan — Continue"}
          </SettingsButton>
        </div>
      );
    }
    if (targetOffer?.authClass === "OAUTH_PKCE" || (!targetOffer && offer?.kind === "oauth")) {
      const name = targetOffer ? providers.find((p) => p.providerId === targetOffer.providerId)?.displayName ?? "OpenRouter" : (offer as { displayName: string }).displayName;
      return (
        <div className="free-cloud-primary">
          <div className="free-cloud-primary-title">{name} · one-click account connection</div>
          <div className="free-cloud-primary-desc">Opens your browser to authorize CodeForge. No API key to copy. Free routes are verified before use.</div>
          <SettingsButton variant="primary" onClick={() => void runOAuth()} disabled={busy !== null}>
            {busy === "oauth" ? "Waiting for browser…" : "Connect & Continue"}
          </SettingsButton>
        </div>
      );
    }
    if (targetOffer?.authClass === "ENVIRONMENT_CREDENTIAL" || (!targetOffer && offer?.kind === "environment")) {
      const providerId = targetOffer?.providerId ?? (offer as { providerId: string }).providerId;
      const p = providers.find((x) => x.providerId === providerId);
      const variable = targetOffer?.variable ?? (offer as { variable?: string }).variable ?? p?.environment?.fields[0]?.variable ?? "environment credential";
      return (
        <div className="free-cloud-primary">
          <div className="free-cloud-primary-title">{p?.displayName ?? providerId} · existing {variable} detected</div>
          <div className="free-cloud-primary-desc">CodeForge found this credential in your environment. Its value stays in your environment — CodeForge only remembers that you enabled it.</div>
          <SettingsButton variant="primary" onClick={() => void runEnv(providerId)} disabled={busy !== null}>
            {busy === `env:${providerId}` ? "Enabling…" : "Use Environment Credential"}
          </SettingsButton>
        </div>
      );
    }
    if (offer?.kind === "qualifying") {
      return (
        <div className="free-cloud-primary">
          <div className="free-cloud-primary-title">8-Bit is qualifying your free routes</div>
          <div className="free-cloud-primary-desc">{offer.pending} route{offer.pending === 1 ? "" : "s"} still to test. ForgeAuto/Free starts automatically when the first one qualifies.</div>
        </div>
      );
    }
    if (offer?.kind === "ready" && !target) {
      return (
        <div className="free-cloud-primary">
          <div className="free-cloud-primary-title">Free Cloud Models are ready</div>
          <div className="free-cloud-primary-desc">{offer.models} verified free model{offer.models === 1 ? "" : "s"} · {offer.routes} healthy route{offer.routes === 1 ? "" : "s"}.</div>
          <SettingsButton variant="primary" onClick={finish}>Start working</SettingsButton>
        </div>
      );
    }
    const providerId = targetOffer?.providerId ?? (offer?.kind === "manual" ? offer.providerId : manualProviders[0]?.providerId);
    const p = providers.find((x) => x.providerId === providerId);
    return (
      <div className="free-cloud-primary">
        <div className="free-cloud-primary-title">{p?.displayName ?? "Provider"} · provider key required</div>
        <div className="free-cloud-primary-desc">Paste a key once. CodeForge validates it, loads the model list for you, and stores it encrypted on this device.</div>
        <SettingsButton variant="primary" onClick={() => setManualProvider(providerId ?? null)} disabled={busy !== null}>
          Connect {p?.displayName ?? "provider"}
        </SettingsButton>
      </div>
    );
  };

  return (
    <div className={inline ? "free-cloud-enable inline" : "free-cloud-enable"} role={inline ? undefined : "dialog"} aria-label={heading} data-testid="free-cloud-enable">
      <div className="free-cloud-enable-header">
        <h3 className="free-cloud-enable-title">{heading}</h3>
        {onClose ? <button type="button" className="model-details-close" aria-label="Close" onClick={onClose}>✕</button> : null}
      </div>
      <div className="free-cloud-enable-sub">
        {target ? "Best available connection:" : "ForgeAuto/Free needs one legitimate free-model connection. Recommended:"}
      </div>
      {manualProvider ? (
        <AddProviderFlow providers={providers} initialProviderId={manualProvider} compact onConnected={() => finish()} onCancel={() => setManualProvider(null)} />
      ) : (
        renderPrimary()
      )}
      {error ? <div className="provider-error" role="alert">{error}</div> : null}
      {!manualProvider ? (
        <details className="free-cloud-other">
          <summary>Other options</summary>
          <ul className="free-cloud-other-list">
            {oauthProvider && !(offer?.kind === "oauth" && !targetOffer) && targetOffer?.authClass !== "OAUTH_PKCE" ? (
              <li><button type="button" className="link-button" onClick={() => void runOAuth()} disabled={busy !== null}>Connect {oauthProvider.displayName} (one click)</button></li>
            ) : null}
            {envOptions.map((p) => (
              <li key={p.providerId}>
                <button type="button" className="link-button" onClick={() => void runEnv(p.providerId)} disabled={busy !== null}>
                  Use detected {p.environment?.fields[0]?.variable ?? "credential"} for {p.displayName}
                </button>
              </li>
            ))}
            {manualProviders.slice(0, 6).map((p) => (
              <li key={p.providerId}><button type="button" className="link-button" onClick={() => setManualProvider(p.providerId)} disabled={busy !== null}>Connect {p.displayName} with a key</button></li>
            ))}
            {onOpenSettings ? <li><button type="button" className="link-button" onClick={onOpenSettings}>Configure another provider in Settings</button></li> : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default FreeCloudEnablePanel;

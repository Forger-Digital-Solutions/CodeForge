import React, { useEffect, useMemo, useState } from "react";
import { CfSelect, SettingsButton, StatusBadge } from "./settings/settings-controls.js";
import {
  connectOpenRouterOAuth,
  connectProvider,
  notifyProviderUpdated,
  setEnabledModels,
  validateProvider,
  type ProviderCatalogModelView,
  type ProviderConnectionView,
} from "./provider-connections-client.js";

/**
 * ZCode-style provider integration (R1 §27-§30, §121):
 *
 *   Provider ▾  →  credential fields (from the provider's connection schema)  →  Validate
 *   →  model dropdown populated from the provider's live catalog  →  Save
 *
 * The user never types a model id. Secrets live in local component state only until the single
 * IPC call that submits them, then the fields are cleared (R1 §105).
 */
export interface AddProviderFlowProps {
  providers: ProviderConnectionView[];
  initialProviderId?: string;
  onConnected?: (providerId: string) => void;
  onCancel?: () => void;
  compact?: boolean;
}

type Step = "choose" | "validated" | "saving" | "done";

export function AddProviderFlow({ providers, initialProviderId, onConnected, onCancel, compact }: AddProviderFlowProps): React.ReactElement {
  const connectable = useMemo(
    () =>
      providers
        .filter((p) => p.implemented && p.authClasses[0] !== "UNSUPPORTED" && p.fields.length > 0)
        .sort((a, b) => Number(b.recommendedForFreeDefault) - Number(a.recommendedForFreeDefault) || Number(b.zeroCashFreeAccess) - Number(a.zeroCashFreeAccess) || a.displayName.localeCompare(b.displayName)),
    [providers],
  );
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? connectable[0]?.providerId ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState<Step>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderCatalogModelView[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [verifiedFree, setVerifiedFree] = useState<number | null>(null);

  const provider = connectable.find((p) => p.providerId === providerId) ?? connectable[0];

  useEffect(() => {
    if (initialProviderId && connectable.some((p) => p.providerId === initialProviderId)) setProviderId(initialProviderId);
  }, [initialProviderId, connectable]);

  useEffect(() => {
    // Switching providers discards any typed secret and the validated catalog.
    setFields({});
    setReveal({});
    setModels([]);
    setSelectedModel("");
    setEnabled(new Set());
    setError(null);
    setStep("choose");
    setVerifiedFree(null);
  }, [providerId]);

  if (!provider) {
    return <div className="settings-note">No connectable providers are available.</div>;
  }

  const requiredFilled = provider.fields.every((f) => f.optional || (fields[f.id] ?? "").trim().length > 0);
  const oauthFirst = provider.authClasses[0] === "OAUTH_PKCE";

  const runValidate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await validateProvider(provider.providerId, fields);
      if (!result.ok) {
        setError(result.error ?? "Validation failed");
        return;
      }
      const list = (result.models ?? []).slice().sort((a, b) => Number(b.free) - Number(a.free) || Number(b.toolCalling) - Number(a.toolCalling) || a.displayName.localeCompare(b.displayName));
      setModels(list);
      setEnabled(new Set(list.filter((m) => m.free && m.toolCalling).map((m) => m.modelId)));
      setSelectedModel(list.find((m) => m.free && m.toolCalling)?.modelId ?? list[0]?.modelId ?? "");
      setStep("validated");
    } finally {
      setBusy(false);
    }
  };

  const runSave = async () => {
    setBusy(true);
    setError(null);
    setStep("saving");
    try {
      const result = await connectProvider(provider.providerId, fields);
      if (!result.ok) {
        setError(result.error ?? "Could not connect");
        setStep("validated");
        return;
      }
      // Field values are cleared the moment the trusted process has them (R1 §105).
      setFields({});
      setReveal({});
      if (enabled.size > 0 && enabled.size < models.length) await setEnabledModels(provider.providerId, [...enabled]);
      else await setEnabledModels(provider.providerId, null);
      setVerifiedFree(result.verifiedFree ?? 0);
      setStep("done");
      notifyProviderUpdated();
      onConnected?.(provider.providerId);
    } finally {
      setBusy(false);
    }
  };

  const runOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectOpenRouterOAuth();
      if (!result.ok) {
        setError(result.error ?? "Authorization failed");
        return;
      }
      setVerifiedFree(result.verifiedFree ?? 0);
      setStep("done");
      notifyProviderUpdated();
      onConnected?.(provider.providerId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`add-provider-flow${compact ? " compact" : ""}`} data-testid="add-provider-flow">
      <div className="add-provider-row">
        <label className="add-provider-label">Provider</label>
        <CfSelect
          label="Provider"
          value={provider.providerId}
          options={connectable.map((p) => ({ value: p.providerId, label: `${p.displayName}${p.zeroCashFreeAccess ? " · free routes" : p.paidOnly ? " · paid" : ""}` }))}
          onChange={setProviderId}
          disabled={busy || step === "saving"}
        />
      </div>
      <div className="add-provider-meta">
        <span className={`provider-badge ${provider.zeroCashFreeAccess ? "free" : "paid"}`}>{provider.freeAccess.class.replace(/_/g, " ").toLowerCase()}</span>
        {provider.freeAccess.quota ? <span className="add-provider-quota">{provider.freeAccess.quota}</span> : null}
        {provider.privacy.freeTierClass === "permissive" ? <span className="provider-badge">free tier may train on prompts</span> : null}
      </div>

      {oauthFirst && step !== "done" ? (
        <div className="add-provider-oauth">
          <SettingsButton variant="primary" onClick={() => void runOAuth()} disabled={busy}>
            {busy ? "Waiting for browser…" : `Connect ${provider.displayName} (one click)`}
          </SettingsButton>
          <div className="settings-note">Recommended — opens your browser to authorize. No key to copy. Or paste a key below.</div>
        </div>
      ) : null}

      {step !== "done" ? (
        <>
          {provider.fields.map((field) => (
            <div className="add-provider-row" key={field.id}>
              <label className="add-provider-label" htmlFor={`add-provider-${provider.providerId}-${field.id}`}>
                {field.label}
                {field.optional ? " (optional)" : ""}
              </label>
              <div className="api-key-input-group">
                <input
                  id={`add-provider-${provider.providerId}-${field.id}`}
                  className="api-key-input"
                  type={field.secret && !reveal[field.id] ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={fields[field.id] ?? ""}
                  placeholder={field.secret ? "Paste once — stored encrypted on this device" : field.label}
                  disabled={busy || step === "saving"}
                  onChange={(e) => {
                    setFields((prev) => ({ ...prev, [field.id]: e.target.value }));
                    if (step === "validated") setStep("choose");
                  }}
                />
                {field.secret ? (
                  <button type="button" className="toggle-visibility-btn" onClick={() => setReveal((r) => ({ ...r, [field.id]: !r[field.id] }))} title={reveal[field.id] ? "Hide" : "Show"} aria-label={reveal[field.id] ? "Hide value" : "Show value"}>
                    {reveal[field.id] ? "🙈" : "👁️"}
                  </button>
                ) : null}
              </div>
              {field.help ? <div className="provider-help">{field.help}</div> : null}
            </div>
          ))}
          {provider.keyUrl ? (
            <div className="provider-help">
              Get a key at <a href={provider.keyUrl} onClick={(e) => { e.preventDefault(); void window.electronAPI?.openExternal?.(provider.keyUrl!); }}>{provider.keyUrl}</a>
            </div>
          ) : null}
          <div className="provider-actions">
            <SettingsButton onClick={() => void runValidate()} disabled={!requiredFilled || busy}>
              {busy && step === "choose" ? "Validating…" : "Validate"}
            </SettingsButton>
            {onCancel ? <SettingsButton onClick={onCancel} disabled={busy}>Cancel</SettingsButton> : null}
          </div>
        </>
      ) : null}

      {error ? <div className="provider-error" role="alert">{error}</div> : null}

      {step === "validated" || step === "saving" ? (
        <div className="add-provider-models">
          <div className="add-provider-row">
            <label className="add-provider-label">Model</label>
            <CfSelect
              label="Model"
              value={selectedModel}
              options={models.map((m) => ({ value: m.modelId, label: `${m.displayName} · ${m.free ? "Free" : m.freeReason}${m.toolCalling ? "" : " · no tools"}` }))}
              onChange={setSelectedModel}
              disabled={busy}
            />
          </div>
          <div className="settings-note">
            {models.length} model{models.length === 1 ? "" : "s"} loaded from {provider.displayName} · {models.filter((m) => m.free).length} free. Free routes are verified and qualified by 8-Bit before ForgeAuto uses them.
          </div>
          <details className="add-provider-enable">
            <summary>Enable specific models ({enabled.size === 0 || enabled.size === models.length ? "all" : enabled.size})</summary>
            <div className="add-provider-enable-list">
              {models.map((m) => (
                <label key={m.modelId} className="add-provider-enable-item">
                  <input
                    type="checkbox"
                    checked={enabled.has(m.modelId)}
                    onChange={(e) =>
                      setEnabled((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(m.modelId);
                        else next.delete(m.modelId);
                        return next;
                      })
                    }
                  />
                  <span>{m.displayName}</span>
                  <span className={`provider-badge ${m.free ? "free" : "paid"}`}>{m.free ? "Free" : m.freeReason}</span>
                </label>
              ))}
            </div>
          </details>
          <div className="provider-actions">
            <SettingsButton variant="primary" onClick={() => void runSave()} disabled={busy}>
              {step === "saving" ? "Saving…" : "Save & connect"}
            </SettingsButton>
          </div>
        </div>
      ) : null}

      {step === "done" ? (
        <div className="add-provider-done">
          <StatusBadge kind="ok">Connected</StatusBadge>
          <span className="settings-note">
            {provider.displayName} is connected{verifiedFree !== null ? ` · ${verifiedFree} verified free route${verifiedFree === 1 ? "" : "s"}` : ""}. Models appear in the picker automatically.
          </span>
          {onCancel ? <SettingsButton onClick={onCancel}>Done</SettingsButton> : null}
        </div>
      ) : null}
    </div>
  );
}

export default AddProviderFlow;

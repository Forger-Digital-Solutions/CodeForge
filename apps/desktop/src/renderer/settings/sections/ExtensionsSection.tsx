import React, { useEffect, useState } from "react";
import { useSettings, type ExtensionView } from "../settings-context.js";
import { Toggle, CfSelect, SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

/**
 * Extensions — the managed extension surface. Extensions run inside CodeForge's extension host:
 * JavaScript evaluated in a sandboxed context with no Node, filesystem, network, or process
 * access. The only capabilities an extension gets are the permissions its manifest declares,
 * surfaced here so users can see exactly what each extension can do.
 */

const PERMISSION_LABELS: Record<string, string> = {
  "settings:read": "Read its own settings",
  "settings:write": "Write its own settings",
  "commands:register": "Register commands",
  "workspace:read": "See workspace path",
  "notifications:show": "Show notifications",
  "secrets:read": "Store extension secrets",
};

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

function statusBadge(ext: ExtensionView): React.ReactElement {
  if (!ext.enabled) return <StatusBadge kind="info">Disabled</StatusBadge>;
  switch (ext.status) {
    case "active": return <StatusBadge kind="ok">Active</StatusBadge>;
    case "error": return <StatusBadge kind="error">Error</StatusBadge>;
    default: return <StatusBadge kind="info">Installed</StatusBadge>;
  }
}

function ExtensionSettingControl({ ext, def }: { ext: ExtensionView; def: ExtensionView["settings"][number] }): React.ReactElement {
  const ctx = useSettings();
  const [value, setValue] = useState<unknown>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void ctx.getExtensionSetting(ext.id, def.key).then((stored) => {
      if (active) { setValue(stored === undefined ? def.default : stored); setLoaded(true); }
    });
    return () => { active = false; };
  }, [ext.id, def.key, def.default]);

  const write = (next: unknown) => {
    setValue(next);
    void ctx.setExtensionSetting(ext.id, def.key, next);
  };

  if (!loaded) return <span className="settings-value muted">…</span>;
  if (def.type === "boolean") {
    return <Toggle label={def.label} checked={value === true} onChange={write} />;
  }
  if (def.type === "enum") {
    return (
      <CfSelect
        label={def.label}
        value={typeof value === "string" ? value : String(def.default ?? "")}
        options={(def.options ?? []).map((o) => ({ value: o, label: o }))}
        onChange={write}
      />
    );
  }
  return (
    <input
      className="settings-search-input"
      style={{ minWidth: 180 }}
      aria-label={def.label}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => write(e.target.value)}
    />
  );
}

function ExtensionCard({ ext }: { ext: ExtensionView }): React.ReactElement {
  const ctx = useSettings();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    setNote(null);
    try {
      const ok = await fn();
      if (!ok) setNote("The action was rejected by the extension host.");
    } catch {
      setNote("The action failed — see the extension status.");
    } finally {
      setBusy(false);
      void ctx.refreshExtensions();
    }
  };

  return (
    <div className="provider-card" data-extension-id={ext.id}>
      <div className="provider-card-header">
        <div className="provider-info">
          <h3 className="provider-name">
            {ext.name}
            <span className="model-pick-badge" style={{ marginLeft: 8 }}>v{ext.version}</span>
            {ext.devMode ? <span className="model-pick-badge" style={{ marginLeft: 6 }}>dev</span> : null}
          </h3>
          <p className="provider-description">{ext.description || ext.id}</p>
        </div>
        {statusBadge(ext)}
      </div>

      {ext.permissions.length > 0 ? (
        <div className="provider-models">
          {ext.permissions.map((p) => <span key={p} className="provider-badge">{permissionLabel(p)}</span>)}
        </div>
      ) : (
        <div className="provider-models"><span className="provider-badge">No permissions — runs fully isolated</span></div>
      )}

      {ext.lastError ? (
        <div className="settings-note" role="alert" style={{ color: "var(--cf-danger)" }}>
          {ext.lastError}
        </div>
      ) : null}

      {ext.enabled && ext.settings.length > 0 ? (
        <div style={{ padding: "0 14px 8px" }}>
          {ext.settings.map((def) => (
            <SettingsRow
              key={def.key}
              title={def.label}
              description={def.description}
              control={<ExtensionSettingControl ext={ext} def={def} />}
            />
          ))}
        </div>
      ) : null}

      <div className="provider-actions">
        <Toggle
          label={`Enable ${ext.name}`}
          checked={ext.enabled}
          disabled={busy}
          onChange={(next) => void run(() => ctx.setExtensionEnabled(ext.id, next))}
        />
        {confirmRemove ? (
          <>
            <SettingsButton variant="danger" disabled={busy} onClick={() => void run(() => ctx.uninstallExtension(ext.id))}>
              Confirm remove
            </SettingsButton>
            <SettingsButton disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</SettingsButton>
          </>
        ) : (
          <button type="button" className="provider-btn delete" disabled={busy} onClick={() => setConfirmRemove(true)}>
            {ext.devMode ? "Remove link" : "Uninstall"}
          </button>
        )}
      </div>
      {note ? <div className="settings-note" role="status">{note}</div> : null}
    </div>
  );
}

export function ExtensionsSection(): React.ReactElement {
  const ctx = useSettings();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void ctx.refreshExtensions();
  }, []);

  return (
    <div>
      <h1 className="settings-section-title">Extensions</h1>
      <p className="settings-section-subtitle">
        Extensions add commands and behavior through CodeForge's extension host. They run in a
        sandboxed context — no Node, filesystem, network, or shell access — and can only use the
        permissions listed on each extension below.
      </p>

      <SettingsGroup title={`Installed extensions (${ctx.extensions.length})`}>
        {ctx.extensions.length === 0 ? (
          <SettingsRow
            title="No extensions installed"
            description="CodeForge extensions are folders containing a codeforge-extension.json manifest. Load one below for development, or remove it any time — an extension that errors is contained and cannot take the app down."
          />
        ) : (
          ctx.extensions.map((ext) => <ExtensionCard key={ext.id} ext={ext} />)
        )}
      </SettingsGroup>

      <SettingsGroup title="Developer">
        <SettingsRow
          settingId="extension-dev-load"
          title="Load extension folder"
          description="Point CodeForge at a folder containing a codeforge-extension.json manifest. Developer extensions run in place from that folder and are marked “dev”."
          control={
            <SettingsButton
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setLoadError(null);
                try {
                  const result = await ctx.loadExtensionFolder();
                  if (result && !result.ok) setLoadError(result.error ?? "The folder is not a valid CodeForge extension.");
                } finally {
                  setLoading(false);
                  void ctx.refreshExtensions();
                }
              }}
            >
              {loading ? "Choose folder…" : "Load folder…"}
            </SettingsButton>
          }
        />
        {loadError ? <div className="settings-note" role="alert" style={{ color: "var(--cf-danger)" }}>{loadError}</div> : null}
      </SettingsGroup>

      <SettingsGroup title="Security model">
        <SettingsRow
          title="Sandboxed host"
          description="Extension code is evaluated inside a VM context with no Node.js APIs, no require(), no process object, and no network. It can only call the CodeForge API object it is given."
          control={<StatusBadge kind="ok">Isolated</StatusBadge>}
        />
        <SettingsRow
          title="Declared permissions"
          description="Capabilities like notifications, workspace awareness, or per-extension secrets require the extension's manifest to declare them; undeclared calls are rejected."
          control={<StatusBadge kind="ok">Enforced</StatusBadge>}
        />
        <SettingsRow
          title="No approval bypass"
          description="Extensions cannot invoke tools, run commands, approve actions, or touch model routing. Those stay inside CodeForge's existing approval and ForgeZero boundaries."
          control={<StatusBadge kind="ok">Enforced</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

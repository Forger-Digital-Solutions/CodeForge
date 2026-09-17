import React, { useState } from "react";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton } from "../settings-controls.js";

export function AdvancedSection(): React.ReactElement {
  const ctx = useSettings();
  const [confirmReset, setConfirmReset] = useState(false);

  const accessCounts = new Map<string, number>();
  for (const model of ctx.apiModels) {
    const key = model.accessClass ?? (model.costProfile?.isFree ? "FREE" : "PAID");
    accessCounts.set(key, (accessCounts.get(key) ?? 0) + 1);
  }
  const providerCounts = new Map<string, number>();
  for (const model of ctx.apiModels) {
    providerCounts.set(model.providerId, (providerCounts.get(model.providerId) ?? 0) + 1);
  }

  return (
    <div>
      <h1 className="settings-section-title">Advanced</h1>
      <p className="settings-section-subtitle">
        Diagnostics and maintenance. Normal use of CodeForge never requires anything on this page.
      </p>

      <SettingsGroup title="Runtime diagnostics">
        <SettingsRow
          title="Local API"
          description="The embedded CodeForge server uses an isolated loopback port for this CodeForge instance only."
        />
        <SettingsRow
          title="Catalog diagnostics"
          description={
            `${ctx.apiModels.length} models registered · ` +
            [...accessCounts.entries()].map(([cls, count]) => `${cls}: ${count}`).join(" · ")
          }
          control={<SettingsButton onClick={() => ctx.navigate("models")}>Models & Routing</SettingsButton>}
        />
        {ctx.apiModels.length > 0 ? (
          <SettingsRow
            title="Catalog by provider"
            description={[...providerCounts.entries()].map(([provider, count]) => `${provider}: ${count}`).join(" · ")}
          />
        ) : null}
        <SettingsRow
          title="Repository Intelligence"
          description={`Structural index state: ${ctx.repositoryIndex.state}${ctx.repositoryIndex.fileCount !== undefined ? ` (${ctx.repositoryIndex.fileCount.toLocaleString()} files)` : ""}`}
        />
      </SettingsGroup>

      <SettingsGroup title="Maintenance">
        <SettingsRow
          title="Open data folder"
          description="settings.json, the local session database, and logs live in this folder."
          control={<SettingsButton onClick={() => void ctx.openDataFolder()}>Open</SettingsButton>}
        />
        <SettingsRow
          title="Reset application preferences"
          description="Resets Settings preferences (startup, agents, appearance, notifications, privacy routing, default model) to their defaults. Provider credentials, close behavior, and workspace history are kept."
          control={
            confirmReset ? (
              <span style={{ display: "flex", gap: 8 }}>
                <SettingsButton
                  variant="danger"
                  onClick={async () => {
                    await ctx.resetPreferences();
                    setConfirmReset(false);
                  }}
                >
                  Reset preferences
                </SettingsButton>
                <SettingsButton onClick={() => setConfirmReset(false)}>Cancel</SettingsButton>
              </span>
            ) : (
              <SettingsButton variant="danger" onClick={() => setConfirmReset(true)}>
                Reset…
              </SettingsButton>
            )
          }
        />
      </SettingsGroup>
    </div>
  );
}

import React from "react";
import ProviderSetup from "../../ProviderSetup.js";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, StatusBadge } from "../settings-controls.js";

/**
 * Connected Providers. BYOK is optional expansion, deliberately placed in Integrations — never
 * the first thing a user sees. Secrets are never displayed; only connection state is.
 */
export function ProvidersSection(): React.ReactElement {
  const ctx = useSettings();

  const providerRows = [
    { providerId: "openrouter", label: "OpenRouter", note: "Free + paid models · one-click OAuth connect" },
    { providerId: "zai", label: "Z.AI", note: "Free GLM flash models + paid coding models" },
    { providerId: "google", label: "Google Gemini", note: "Free allowance tier (quota-limited)" },
    { providerId: "groq", label: "Groq", note: "Fast free developer allowance" },
    { providerId: "opencode", label: "OpenCode Zen", note: "Routed free models" },
    { providerId: "anthropic", label: "Anthropic", note: "Paid only — never in free routing" },
    { providerId: "openai", label: "OpenAI", note: "Paid only — never in free routing" },
  ];

  const connectedCount = providerRows.filter((p) => ctx.providerStatus[p.providerId]?.status === "available").length;

  return (
    <div>
      <h1 className="settings-section-title">Connected Providers</h1>
      <p className="settings-section-subtitle">
        Optional providers expand CodeForge beyond the built-in Free / ForgeAuto model catalog.
        CodeForge Free and ForgeAuto/Free remain fully usable without any provider configuration
        where eligible free routes exist. Credentials stay on this device, encrypted.
      </p>

      <SettingsGroup title={`Your providers (${connectedCount} connected)`}>
        {providerRows.map((provider) => {
          const status = ctx.providerStatus[provider.providerId];
          const connected = status?.status === "available";
          const failed = status?.status === "error";
          return (
            <SettingsRow
              key={provider.providerId}
              title={provider.label}
              description={
                failed
                  ? `${provider.note} · Connection error: ${status?.error ?? "unknown"}`
                  : provider.note
              }
              control={
                connected ? (
                  <StatusBadge kind="ok">Connected</StatusBadge>
                ) : failed ? (
                  <StatusBadge kind="error">Error</StatusBadge>
                ) : status ? (
                  <StatusBadge kind="info">Saved</StatusBadge>
                ) : (
                  <StatusBadge kind="info">Not connected</StatusBadge>
                )
              }
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Manage credentials">
        <div style={{ padding: "0 14px 14px" }}>
          <ProviderSetup />
        </div>
      </SettingsGroup>
    </div>
  );
}

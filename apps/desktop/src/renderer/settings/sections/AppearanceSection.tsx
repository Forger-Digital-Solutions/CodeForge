import React from "react";
import { useSettings } from "../settings-context.js";
import { Toggle, Segmented, SettingsGroup, SettingsRow } from "../settings-controls.js";

/**
 * Appearance. CodeForge ships dark-only — there is no fake theme picker. The two controls here
 * (interface scale, reduced motion) are applied by the workspace shell the moment they change.
 */
export function AppearanceSection(): React.ReactElement {
  const ctx = useSettings();
  return (
    <div>
      <h1 className="settings-section-title">Appearance</h1>
      <p className="settings-section-subtitle">How CodeForge looks on this computer.</p>

      <SettingsGroup title="Theme">
        <SettingsRow
          title="Theme"
          description="CodeForge ships with a single dark theme tuned for long coding sessions. Light and system themes are not available yet."
          control={<span className="settings-value muted">Dark</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="Density & motion">
        <SettingsRow
          title="Interface scale"
          description="Scales the workspace content area. Useful on high-DPI Windows displays."
          control={
            <Segmented
              label="Interface scale"
              value={ctx.settings.appearance.chatTextScale}
              options={[
                { value: "small", label: "Compact" },
                { value: "medium", label: "Default" },
                { value: "large", label: "Large" },
              ]}
              onChange={(next) => void ctx.update({ settings: { appearance: { chatTextScale: next } } })}
            />
          }
        />
        <SettingsRow
          title="Reduce motion"
          description="Minimizes non-essential animations and transitions across the app."
          control={
            <Toggle
              checked={ctx.settings.appearance.reducedMotion}
              onChange={(next) => void ctx.update({ settings: { appearance: { reducedMotion: next } } })}
              label="Reduce motion"
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}

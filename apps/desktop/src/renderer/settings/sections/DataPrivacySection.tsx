import React from "react";
import { useSettings } from "../settings-context.js";
import { CfSelect, SettingsGroup, SettingsRow, SettingsButton } from "../settings-controls.js";
import type { PrivacyRoutingMode } from "../../../app-settings.js";

export function DataPrivacySection(): React.ReactElement {
  const ctx = useSettings();

  return (
    <div>
      <h1 className="settings-section-title">Data &amp; Privacy</h1>
      <p className="settings-section-subtitle">
        How your code and data are handled, and what stays on this computer.
      </p>

      <SettingsGroup title="Code & content handling">
        <SettingsRow
          title="Provider routing"
          description="ForgeAuto only uses ForgeZero-verified $0 routes. The privacy mode below controls which free endpoints qualify: Strict excludes endpoints whose free tiers may train on or retain your prompts (for example Gemini's free tier)."
          control={
            <CfSelect
              label="Privacy routing mode"
              value={ctx.settings.privacy.routingMode}
              options={[
                { value: "STRICT", label: "Strict · no provider training/retention" },
                { value: "STANDARD", label: "Standard · normal provider retention" },
                { value: "MAXIMUM_FREE", label: "Maximum Free · allow weaker-retention free endpoints" },
              ]}
              onChange={(next) => void ctx.update({ settings: { privacy: { routingMode: next as PrivacyRoutingMode } } })}
            />
          }
        />
        <SettingsRow
          title="Connected providers"
          description="Content sent through a provider you connected yourself is governed by that provider's own policies."
          control={<SettingsButton onClick={() => ctx.navigate("providers")}>Review providers</SettingsButton>}
        />
      </SettingsGroup>

      <SettingsGroup title="Local history">
        <SettingsRow
          title="Task history"
          description="Tasks, turns, and verification evidence are stored locally in this computer's CodeForge data folder. CodeForge Cloud receives only what a Cloud feature you use needs: model requests routed through Hosted Free (relayed, not stored) and the commit bundle of a delivery you choose to publish (deleted after the push)."
        />
        <SettingsRow
          title="Clear recent projects"
          description="Removes the recent-projects list from this device. Your files and task history are not touched."
          control={<SettingsButton onClick={() => void ctx.clearRecentProjects()}>Clear list</SettingsButton>}
        />
      </SettingsGroup>

      <SettingsGroup title="Telemetry & diagnostics">
        <SettingsRow
          title="Telemetry"
          description="CodeForge collects no product telemetry — there is no analytics pipeline to turn off. Traffic leaves this device only for the model routes you use and the CodeForge Cloud services you sign in to."
          control={<span className="settings-value muted">None collected</span>}
        />
        <SettingsRow
          title="Diagnostics"
          description="Diagnostics are limited to local log output. Open the data folder to inspect what CodeForge stores on this machine."
          control={<SettingsButton onClick={() => void ctx.openDataFolder()}>Open data folder</SettingsButton>}
        />
      </SettingsGroup>
    </div>
  );
}

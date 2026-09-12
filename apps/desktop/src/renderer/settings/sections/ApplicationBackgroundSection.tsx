import React from "react";
import { useSettings } from "../settings-context.js";
import { Toggle, CfSelect, SettingsGroup, SettingsRow, StatusBadge } from "../settings-controls.js";
import type { CloseBehavior } from "../../../app-settings.js";

export function ApplicationBackgroundSection(): React.ReactElement {
  const ctx = useSettings();

  return (
    <div>
      <h1 className="settings-section-title">Application &amp; Background</h1>
      <p className="settings-section-subtitle">
        Window close behavior, background execution, and what happens to active work.
      </p>

      <SettingsGroup title="Background execution">
        <SettingsRow
          title="Keep CodeForge running in the system tray"
          description="While running in the background, the tray icon shows a live summary of active work and lets you reopen CodeForge at any time."
          control={<StatusBadge kind="ok">Always on</StatusBadge>}
        />
        <SettingsRow
          title="When tasks are active and I close CodeForge"
          description={
            ctx.closeBehavior === "tray"
              ? "CodeForge minimizes to the tray and keeps working."
              : ctx.closeBehavior === "quit-safe"
                ? "CodeForge quits safely; recoverable work is preserved for continuation."
                : "CodeForge asks what to do before closing."
          }
          control={
            <CfSelect
              label="Close behavior while tasks are active"
              value={ctx.closeBehavior}
              options={[
                { value: "ask", label: "Ask me" },
                { value: "tray", label: "Minimize to tray" },
                { value: "quit-safe", label: "Quit safely" },
              ]}
              onChange={(next) => void ctx.update({ closeBehavior: next as CloseBehavior })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Startup">
        <SettingsRow
          title="Open last workspace on startup"
          description="Reopen your most recent workspace when CodeForge launches."
          control={
            <Toggle
              checked={ctx.settings.general.openLastWorkspaceOnStartup}
              onChange={(next) => void ctx.update({ settings: { general: { openLastWorkspaceOnStartup: next } } })}
              label="Open last workspace on startup"
            />
          }
        />
        <SettingsRow
          title="Continue eligible interrupted agents"
          description="Resume durable CodeForge tasks that were persisted mid-run after an application restart. Turns are re-planned from saved facts; nothing is replayed, and paused turns always wait for you."
          control={
            <Toggle
              checked={ctx.settings.general.continueInterruptedAgents}
              onChange={(next) => void ctx.update({ settings: { general: { continueInterruptedAgents: next } } })}
              label="Continue interrupted agents"
            />
          }
        />
        <SettingsRow
          title="Start with Windows"
          description="CodeForge does not register itself to start with Windows."
          control={<StatusBadge kind="info">Not configured</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

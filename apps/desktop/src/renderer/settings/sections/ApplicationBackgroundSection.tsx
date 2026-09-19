import React from "react";
import { useSettings } from "../settings-context.js";
import { CfSelect, SettingsGroup, SettingsRow, StatusBadge, SettingsButton } from "../settings-controls.js";
import type { CloseBehavior } from "../../../app-settings.js";

/**
 * Application & Background — close behavior and OS integration. Startup workspace restore and
 * interrupted-agent recovery live in General; this page owns only how the *application* behaves
 * when it is not in the foreground.
 */
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
          settingId="system-tray"
          title="Keep CodeForge running in the system tray"
          description="While running in the background, the tray icon shows a live summary of active work and lets you reopen CodeForge at any time."
          control={<StatusBadge kind="ok">Always on</StatusBadge>}
        />
        <SettingsRow
          settingId="close-behavior"
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
          settingId="start-with-windows"
          title="Start with Windows"
          description="CodeForge does not register itself to start with Windows."
          control={<StatusBadge kind="info">Not configured</StatusBadge>}
        />
        <SettingsRow
          title="Workspace restore & agent recovery"
          description="Startup workspace restore and interrupted-agent continuation are managed in General."
          control={<SettingsButton onClick={() => ctx.navigate("general")}>Open General</SettingsButton>}
        />
      </SettingsGroup>
    </div>
  );
}

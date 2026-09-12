import React from "react";
import { useSettings } from "../settings-context.js";
import { Toggle, SettingsGroup, SettingsRow } from "../settings-controls.js";

export function NotificationsSection(): React.ReactElement {
  const ctx = useSettings();
  const prefs = ctx.settings.notifications;
  const update = (patch: Partial<typeof prefs>) => void ctx.update({ settings: { notifications: patch } });

  return (
    <div>
      <h1 className="settings-section-title">Notifications</h1>
      <p className="settings-section-subtitle">
        Operating-system notifications about agent work. Approval requests and failures always
        appear inside the app too — these are an extra signal, never the only one.
      </p>

      <SettingsGroup title="System notifications">
        <SettingsRow
          title="System notifications"
          description="Allow CodeForge to post OS notifications about agent work."
          control={<Toggle checked={prefs.enabled} onChange={(next) => update({ enabled: next })} label="System notifications" />}
        />
        <SettingsRow
          title="Agent needs approval"
          description="Notify when an agent is waiting on an approval request from you."
          control={
            <Toggle
              checked={prefs.onApprovalNeeded}
              disabled={!prefs.enabled}
              onChange={(next) => update({ onApprovalNeeded: next })}
              label="Agent needs approval notifications"
            />
          }
        />
        <SettingsRow
          title="Agent work finished"
          description="Notify when active agent work finishes and nothing is running anymore."
          control={
            <Toggle
              checked={prefs.onAgentCompleted}
              disabled={!prefs.enabled}
              onChange={(next) => update({ onAgentCompleted: next })}
              label="Agent completed notifications"
            />
          }
        />
        <SettingsRow
          title="Only when CodeForge is in the background"
          description="While you are looking at CodeForge, its own approval bars and banners are the right surface; OS toasts would be redundant."
          control={
            <Toggle
              checked={prefs.onlyWhenInBackground}
              disabled={!prefs.enabled}
              onChange={(next) => update({ onlyWhenInBackground: next })}
              label="Only notify when in background"
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}

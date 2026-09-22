import React from "react";
import { useSettings } from "../settings-context.js";
import { Toggle, SettingsGroup, SettingsRow, SettingsButton } from "../settings-controls.js";

/**
 * General — the settings that own no other home: startup/recovery behavior and pointers into the
 * pages that own the rest. Account details live in Profile & Account, indexing in Repository
 * Intelligence, routing in Models & Routing — nothing here is a second copy of another control.
 */
export function GeneralSection(): React.ReactElement {
  const ctx = useSettings();
  const account = ctx.account;

  return (
    <div>
      <h1 className="settings-section-title">General</h1>
      <p className="settings-section-subtitle">Core CodeForge behavior on this computer.</p>

      <SettingsGroup title="Account">
        <SettingsRow
          title={account ? (account.user?.displayName ?? "CodeForge account") : "Signed out"}
          description={
            account
              ? `${account.identity?.login ? `@${account.identity.login} · ` : ""}${account.planName ?? "CodeForge Free"} — manage sign-in, plan, and credentials in Profile & Account.`
              : "ForgeAuto/Free catalog browsing works without an account. Sign in to run hosted free models."
          }
          control={<SettingsButton onClick={() => ctx.navigate("profile")}>Open Profile &amp; Account</SettingsButton>}
        />
      </SettingsGroup>

      <SettingsGroup title="Startup & recovery">
        <SettingsRow
          settingId="open-last-workspace"
          title="Open last workspace on startup"
          description="Continue where you left off by reopening your most recent workspace."
          control={
            <Toggle
              checked={ctx.settings.general.openLastWorkspaceOnStartup}
              onChange={(next) => void ctx.update({ settings: { general: { openLastWorkspaceOnStartup: next } } })}
              label="Open last workspace on startup"
            />
          }
        />
        <SettingsRow
          settingId="continue-interrupted-agents"
          title="Continue interrupted CodeForge agents"
          description="Resume eligible durable tasks after an application restart. Interrupted turns are re-planned from saved facts — nothing is replayed, and approvals still apply."
          control={
            <Toggle
              checked={ctx.settings.general.continueInterruptedAgents}
              onChange={(next) => void ctx.update({ settings: { general: { continueInterruptedAgents: next } } })}
              label="Continue interrupted CodeForge agents"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Defaults">
        <SettingsRow
          settingId="default-model"
          title="Default model routing"
          description={
            ctx.defaultModelId === "auto"
              ? "ForgeAuto/Free — automatic free-model routing for every task."
              : `Pinned to a specific model (${ctx.defaultModelId}).`
          }
          control={<SettingsButton onClick={() => ctx.navigate("models")}>Change in Models & Routing</SettingsButton>}
        />
        <SettingsRow
          settingId="repo-index-enabled"
          title="Repository Intelligence"
          description={`Structural index status: ${ctx.repositoryIndex.state}${ctx.repositoryIndex.fileCount !== undefined ? ` · ${ctx.repositoryIndex.fileCount.toLocaleString()} files` : ""}.`}
          control={<SettingsButton onClick={() => ctx.navigate("repository-intelligence")}>Open Repository Intelligence</SettingsButton>}
        />
      </SettingsGroup>
    </div>
  );
}

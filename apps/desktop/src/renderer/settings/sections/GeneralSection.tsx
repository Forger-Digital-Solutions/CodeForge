import React from "react";
import { useSettings } from "../settings-context.js";
import { Avatar, Toggle, SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

export function GeneralSection(): React.ReactElement {
  const ctx = useSettings();
  const account = ctx.account;
  const displayName = account?.user?.displayName;

  return (
    <div>
      <h1 className="settings-section-title">General</h1>
      <p className="settings-section-subtitle">Core CodeForge behavior on this computer.</p>

      <SettingsGroup title="Account">
        {account ? (
          <div className="settings-row" style={{ borderTop: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Avatar url={account.user?.avatarUrl} name={displayName ?? "CodeForge"} />
              <div>
                <div className="account-name">{displayName ?? "CodeForge account"}</div>
                {account.identity?.login ? <div className="account-handle">@{account.identity.login}</div> : null}
                <div className="account-email">Plan: {account.planName ?? "CodeForge Free"} · GitHub connected ✓</div>
              </div>
            </div>
            <div className="settings-row-control">
              <SettingsButton onClick={() => ctx.navigate("profile")}>View profile</SettingsButton>
            </div>
          </div>
        ) : (
          <SettingsRow
            title="Signed out"
            description="ForgeAuto/Free catalog browsing works without an account. Sign in to run hosted free models."
            control={<SettingsButton variant="primary" onClick={() => void ctx.signIn()}>Sign in with GitHub</SettingsButton>}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Startup">
        <SettingsRow
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

      <SettingsGroup title="Interface behavior">
        <SettingsRow
          title="Repository Intelligence indexing"
          description={
            ctx.repositoryIndex.state === "INDEXING" && ctx.repositoryIndex.progress
              ? `Indexing ${ctx.repositoryIndex.progress.filesProcessed.toLocaleString()} / ${ctx.repositoryIndex.progress.filesDiscovered.toLocaleString()} files`
              : `Structural index status: ${ctx.repositoryIndex.state}`
          }
          control={
            <Toggle
              checked={ctx.repositoryIndex.enabled !== false}
              onChange={(next) => void ctx.setRepositoryIndexEnabled(next)}
              label="Repository Intelligence indexing"
            />
          }
        />
        <SettingsRow
          title="Default model routing"
          description={
            ctx.defaultModelId === "auto"
              ? "ForgeAuto/Free — automatic free-model routing for every task."
              : `Pinned to a specific model (${ctx.defaultModelId}).`
          }
          control={<SettingsButton onClick={() => ctx.navigate("models")}>Change in Models & Routing</SettingsButton>}
        />
      </SettingsGroup>

      <SettingsGroup title="ForgeZero">
        <SettingsRow
          title="Verified $0 routing protection"
          description="Every route passes the ForgeZero zero-billing firewall before execution. If free status cannot be verified, the model is not used."
          control={<StatusBadge kind="ok">Verified Free</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

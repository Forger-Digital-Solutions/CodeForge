import React, { useEffect, useState } from "react";
import { useSettings } from "../settings-context.js";
import { Avatar, SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

interface GitIdentity {
  name: string | null;
  email: string | null;
}

/**
 * Git & GitHub — detected Git configuration for the current workspace plus the connected GitHub
 * account. Git values are read-only detections from the local repository; nothing here pushes,
 * commits, or opens PRs on its own.
 */
export function GitGithubSection(): React.ReactElement {
  const ctx = useSettings();
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!window.electronAPI?.execCommand || !ctx.gitInfo.isGitRepo) return;
      try {
        const [name, email] = await Promise.all([
          window.electronAPI.execCommand({ command: "git", args: ["config", "user.name"], cwd: ctx.project.path }),
          window.electronAPI.execCommand({ command: "git", args: ["config", "user.email"], cwd: ctx.project.path }),
        ]);
        if (!active) return;
        const clean = (result: { exitCode: number; stdout: string }) => {
          const trimmed = result.stdout.trim();
          return result.exitCode === 0 && trimmed.length > 0 && trimmed.length <= 320 ? trimmed : null;
        };
        setGitIdentity({ name: clean(name), email: clean(email) });
      } catch {
        if (active) setGitIdentity({ name: null, email: null });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [ctx.project.path, ctx.gitInfo.isGitRepo]);

  const account = ctx.account;

  return (
    <div>
      <h1 className="settings-section-title">Git &amp; GitHub</h1>
      <p className="settings-section-subtitle">
        Local Git configuration for this workspace and the GitHub identity CodeForge uses for it.
      </p>

      <SettingsGroup title="Git identity (detected)">
        <SettingsRow
          title="Git user.name"
          description={gitIdentity?.name ? gitIdentity.name : "Not set in this repository's Git configuration."}
        />
        <SettingsRow
          title="Git user.email"
          description={gitIdentity?.email ? gitIdentity.email : "Not set in this repository's Git configuration."}
        />
        <SettingsRow
          title="Repository state"
          description={
            ctx.gitInfo.isGitRepo
              ? `${ctx.gitInfo.isDetached ? "Detached HEAD" : `On branch ${ctx.gitInfo.branch ?? "unknown"}`}${ctx.gitInfo.isWorktree ? " · this is a Git worktree" : ""}`
              : "This workspace is not a Git repository."
          }
          control={
            ctx.gitInfo.isGitRepo ? (
              ctx.gitInfo.isWorktree ? (
                <StatusBadge kind="info">Worktree</StatusBadge>
              ) : (
                <StatusBadge kind="ok">Repository</StatusBadge>
              )
            ) : (
              <StatusBadge kind="info">No repo</StatusBadge>
            )
          }
        />
      </SettingsGroup>

      <SettingsGroup title="GitHub account">
        {account ? (
          <>
            <div className="settings-row" style={{ borderTop: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <Avatar url={account.user?.avatarUrl} name={account.user?.displayName ?? "CodeForge"} size="sm" />
                <div style={{ minWidth: 0 }}>
                  <div className="account-name" style={{ fontSize: 13 }}>{account.user?.displayName ?? "CodeForge account"}</div>
                  <div className="account-handle">
                    {account.identity?.login ? `@${account.identity.login}` : "GitHub connected ✓"}
                    {account.identity?.email ? ` · ${account.identity.email}` : account.identity?.login ? " · Email not shared" : ""}
                  </div>
                </div>
              </div>
              <div className="settings-row-control">
                <StatusBadge kind="ok">Connected</StatusBadge>
              </div>
            </div>
            <SettingsRow
              title="Manage connection"
              description="Re-authorize CodeForge in your browser, or manage the connection from Profile & Account."
              control={<SettingsButton onClick={() => ctx.navigate("profile")}>Manage</SettingsButton>}
            />
          </>
        ) : (
          <SettingsRow
            title="GitHub not connected"
            description="Sign in with GitHub to connect repositories, hosted free models, and your account identity."
            control={
              <SettingsButton variant="primary" onClick={() => void ctx.signIn()}>
                Sign in with GitHub
              </SettingsButton>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Repository behavior">
        <SettingsRow
          title="Pushes & pull requests"
          description="CodeForge never pushes or opens pull requests on its own. Publishing certified work to GitHub is always a separate, explicit action you authorize."
          control={<StatusBadge kind="ok">Manual only</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

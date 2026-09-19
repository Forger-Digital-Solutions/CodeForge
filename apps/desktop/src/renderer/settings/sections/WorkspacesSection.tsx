import React from "react";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

/**
 * Workspaces — the open workspace and its recent-projects list. The startup toggle lives in
 * General, indexing in Repository Intelligence: this page owns only what is about *which*
 * workspace is open.
 */
export function WorkspacesSection(): React.ReactElement {
  const ctx = useSettings();

  return (
    <div>
      <h1 className="settings-section-title">Workspaces</h1>
      <p className="settings-section-subtitle">
        Where CodeForge works: the open workspace and the projects you can switch to.
      </p>

      <SettingsGroup title="Current workspace">
        <SettingsRow
          title={ctx.project.name}
          description={ctx.project.path}
          control={
            ctx.gitInfo.isGitRepo ? (
              <StatusBadge kind="ok">
                {ctx.gitInfo.isDetached ? "detached HEAD" : `branch: ${ctx.gitInfo.branch ?? "unknown"}`}
              </StatusBadge>
            ) : (
              <StatusBadge kind="info">No Git repo</StatusBadge>
            )
          }
        />
        <SettingsRow
          title="Structural index"
          description={`Repository Intelligence: ${ctx.repositoryIndex.state}${ctx.repositoryIndex.fileCount !== undefined ? ` · ${ctx.repositoryIndex.fileCount.toLocaleString()} files` : ""}.`}
          control={<SettingsButton onClick={() => ctx.navigate("repository-intelligence")}>Open Repository Intelligence</SettingsButton>}
        />
      </SettingsGroup>

      <SettingsGroup title="Recent projects">
        <div id="setting-recent-projects" data-setting-id="recent-projects" />
        {ctx.recentProjects.length === 0 ? (
          <SettingsRow title="No recent projects" description="Projects you open appear here." />
        ) : (
          ctx.recentProjects.map((project) => (
            <div key={project.path} className="model-pick-row">
              <span className="model-pick-name" title={project.path}>{project.name}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {project.path === ctx.project.path ? (
                  <StatusBadge kind="ok">Open</StatusBadge>
                ) : (
                  <SettingsButton onClick={() => void ctx.openProjectPath(project.path)}>Open</SettingsButton>
                )}
                <SettingsButton
                  title={`Remove ${project.name} from recent projects`}
                  onClick={() => void ctx.removeRecentProject(project.path)}
                >
                  Remove
                </SettingsButton>
              </span>
            </div>
          ))
        )}
        {ctx.recentProjects.length > 0 ? (
          <div className="settings-note">
            Removal only clears the entry — it never touches files. The whole list can be cleared
            from Data &amp; Privacy.
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Workspace boundaries">
        <SettingsRow
          settingId="workspace-boundary"
          title="Boundary protection"
          description="Agents can only read and write inside the open workspace. Anything outside — including through symlinks — is rejected by the runtime."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

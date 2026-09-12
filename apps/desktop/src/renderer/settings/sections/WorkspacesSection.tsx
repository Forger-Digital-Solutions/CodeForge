import React from "react";
import { useSettings } from "../settings-context.js";
import { Toggle, SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

export function WorkspacesSection(): React.ReactElement {
  const ctx = useSettings();

  return (
    <div>
      <h1 className="settings-section-title">Workspaces</h1>
      <p className="settings-section-subtitle">
        Where CodeForge works: the open workspace, recent projects, and Repository Intelligence.
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
          title="Open last workspace on startup"
          description="Reopen your most recent workspace automatically when CodeForge starts."
          control={
            <Toggle
              checked={ctx.settings.general.openLastWorkspaceOnStartup}
              onChange={(next) => void ctx.update({ settings: { general: { openLastWorkspaceOnStartup: next } } })}
              label="Open last workspace on startup"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Recent projects">
        {ctx.recentProjects.length === 0 ? (
          <SettingsRow title="No recent projects" description="Projects you open appear here." />
        ) : (
          ctx.recentProjects.map((project) => (
            <div key={project.path} className="model-pick-row">
              <span className="model-pick-name" title={project.path}>{project.name}</span>
              {project.path === ctx.project.path ? (
                <StatusBadge kind="ok">Open</StatusBadge>
              ) : (
                <SettingsButton onClick={() => void ctx.openProjectPath(project.path)}>Open</SettingsButton>
              )}
            </div>
          ))
        )}
      </SettingsGroup>

      <SettingsGroup title="Repository Intelligence">
        <SettingsRow
          title="Structural index"
          description={
            ctx.repositoryIndex.state === "INDEXING" && ctx.repositoryIndex.progress
              ? `Indexing ${ctx.repositoryIndex.progress.filesProcessed.toLocaleString()} / ${ctx.repositoryIndex.progress.filesDiscovered.toLocaleString()} files`
              : ctx.repositoryIndex.fileCount !== undefined
                ? `${ctx.repositoryIndex.state} — ${ctx.repositoryIndex.fileCount.toLocaleString()} files, ${ctx.repositoryIndex.symbolCount?.toLocaleString() ?? 0} symbols. Local only; never uploaded.`
                : `Status: ${ctx.repositoryIndex.state}`
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
          title="Rebuild index"
          description="Re-scan the workspace and rebuild the structural index from scratch."
          control={
            <SettingsButton
              disabled={ctx.repositoryIndex.enabled === false || ctx.repositoryIndex.state === "INDEXING"}
              onClick={() => void ctx.rebuildRepositoryIndex()}
            >
              Rebuild
            </SettingsButton>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Workspace boundaries">
        <SettingsRow
          title="Boundary protection"
          description="Agents can only read and write inside the open workspace. Anything outside — including through symlinks — is rejected by the runtime."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

import React from "react";
import { useSettings } from "../settings-context.js";
import { Toggle, SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Repository Intelligence — the local structural index CodeForge builds over the open workspace.
 * Everything here is scoped to the current project and never leaves this computer.
 */
export function RepositoryIntelligenceSection(): React.ReactElement {
  const ctx = useSettings();
  const index = ctx.repositoryIndex;
  const indexing = index.state === "INDEXING";

  const indexDescription = indexing && index.progress
    ? `Indexing ${index.progress.filesProcessed.toLocaleString()} / ${index.progress.filesDiscovered.toLocaleString()} files…`
    : index.fileCount !== undefined
      ? `${index.state} — ${index.fileCount.toLocaleString()} files · ${index.symbolCount?.toLocaleString() ?? 0} symbols${index.sizeBytes !== undefined ? ` · ${formatBytes(index.sizeBytes)}` : ""}. Stored locally; never uploaded.`
      : `Status: ${index.state}. Stored locally; never uploaded.`;

  return (
    <div>
      <h1 className="settings-section-title">Repository Intelligence</h1>
      <p className="settings-section-subtitle">
        A local structural index of {ctx.project.name} — files and symbols CodeForge can reason
        over without re-scanning the tree. Applies to the open workspace; the index itself stays
        on this computer.
      </p>

      <SettingsGroup title="Index">
        <SettingsRow
          settingId="repo-index-enabled"
          title="Repository Intelligence indexing"
          description="When enabled, CodeForge maintains a structural index of the open workspace for agent context. Turning it off stops indexing and removes index-derived context from new work."
          control={
            <Toggle
              checked={index.enabled !== false}
              onChange={(next) => void ctx.setRepositoryIndexEnabled(next)}
              label="Repository Intelligence indexing"
            />
          }
        />
        <SettingsRow
          title="Index status"
          description={indexDescription}
          control={
            <StatusBadge kind={index.state === "READY" ? "ok" : indexing ? "info" : index.state === "ERROR" ? "error" : index.enabled === false ? "info" : "warn"}>
              {index.enabled === false ? "Disabled" : indexing ? "Indexing…" : index.state === "READY" ? "Ready" : index.state}
            </StatusBadge>
          }
        />
        <SettingsRow
          settingId="repo-index-rebuild"
          title="Rebuild index"
          description="Re-scan the workspace and rebuild the structural index from scratch. Use after large refactors or if search results look stale."
          control={
            <SettingsButton disabled={index.enabled === false || indexing} onClick={() => void ctx.rebuildRepositoryIndex()}>
              {indexing ? "Indexing…" : "Rebuild"}
            </SettingsButton>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Scope & privacy">
        <SettingsRow
          title="Local only"
          description="The index is stored in this computer's CodeForge data folder and is never uploaded. Model requests still send only the code context the route needs."
          control={<StatusBadge kind="ok">On-device</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

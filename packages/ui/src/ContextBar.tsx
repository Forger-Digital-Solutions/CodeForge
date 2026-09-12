import React from "react";

export interface ContextBarProps {
  /** Where the next turn will actually execute — e.g. "Local", "Hosted", "CodeForge Cloud". Must
   * come from the real selected-model/runtime state, never a made-up label. */
  runtimeLabel: string;
  runtimeDetail?: string;
  workspaceName?: string;
  /** Full filesystem path, shown as a tooltip — never crammed into the chip itself. */
  workspacePath?: string;
  isGitRepo?: boolean;
  branch?: string | null;
  isDetached?: boolean;
  isWorktree?: boolean;
}

/**
 * Compact repository/runtime context row shown above the composer — "what will CodeForge act on
 * and where" at a glance. Every chip here is driven by real state passed in from the desktop shell
 * (workspace path, git branch/worktree detection, selected-model runtime) — this component renders
 * only what it's given and never fabricates a branch or worktree chip on its own.
 */
export function ContextBar({
  runtimeLabel,
  runtimeDetail,
  workspaceName,
  workspacePath,
  isGitRepo,
  branch,
  isDetached,
  isWorktree,
}: ContextBarProps): React.ReactElement {
  return (
    <div className="context-bar" role="group" aria-label="Workspace context">
      <span className="context-chip" title={runtimeDetail ?? `Execution runtime: ${runtimeLabel}`}>
        {runtimeLabel}
      </span>
      {workspaceName && (
        <span className="context-chip" title={workspacePath ? `Workspace folder: ${workspacePath}` : workspaceName}>
          {workspaceName}
        </span>
      )}
      {isGitRepo && (
        <span className="context-chip" title={isDetached ? "Detached HEAD — not on a named branch" : `Git branch: ${branch}`}>
          {isDetached ? "detached HEAD" : branch}
        </span>
      )}
      {isWorktree && (
        <span className="context-chip context-chip-worktree" title="This workspace is a linked Git worktree, not the main checkout">
          worktree
        </span>
      )}
    </div>
  );
}

export default ContextBar;

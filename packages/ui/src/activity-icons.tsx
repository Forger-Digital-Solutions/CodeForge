import React from "react";
import { resolveActivityAsset } from "./emoji-assets.js";

export type ActivityKind =
  | "search"
  | "read"
  | "reason"
  | "plan"
  | "edit"
  | "create"
  | "delete"
  | "tool"
  | "execute"
  | "fetch"
  | "build"
  | "test"
  | "verify"
  | "git"
  | "commit"
  | "error"
  | "waiting"
  | "queued"
  | "paused"
  | "approval"
  | "complete"
  | "warning"
  | "cancelled"
  | "parallel"
  | "success"
  | "generic"
  | "unknown"
  | "forge";

export type ActivityState = "active" | "completed" | "failed" | "blocked" | "pending" | "static";

const LABELS: Record<ActivityKind, string> = {
  search: "Search",
  read: "Read",
  reason: "Reasoning",
  plan: "Plan",
  edit: "Edit",
  create: "Create",
  delete: "Delete",
  tool: "Tool",
  execute: "Execute",
  fetch: "Fetch",
  build: "Build",
  test: "Test",
  verify: "Verify",
  git: "Git",
  commit: "Commit",
  error: "Error",
  waiting: "Waiting",
  queued: "Queued",
  paused: "Paused",
  approval: "Approval",
  complete: "Complete",
  warning: "Warning",
  cancelled: "Cancelled",
  parallel: "Parallel",
  success: "Success",
  generic: "Activity",
  unknown: "Activity",
  forge: "Forging",
};

export function activityLabel(kind: ActivityKind): string {
  return LABELS[kind];
}

/** Maps canonical tool names to the small semantic vocabulary used by the transcript. */
export function resolveActivityKind(toolName: string): ActivityKind {
  const name = toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/(^|_)(search|grep|find|rg)(_|$)/.test(name)) return "search";
  if (/(^|_)(read|cat|list|inspect|stat)(_|$)/.test(name)) return "read";
  if (/(^|_)(reason|think|thinking)(_|$)/.test(name)) return "reason";
  if (/(^|_)(plan|planning)(_|$)/.test(name)) return "plan";
  if (/(^|_)(create)(_|$)/.test(name)) return "create";
  if (/(^|_)(edit|patch|write|modify|update)(_|$)/.test(name)) return "edit";
  if (/(^|_)(delete|remove|trash)(_|$)/.test(name)) return "delete";
  if (/(^|_)(fetch|web|http|browse|url)(_|$)/.test(name)) return "fetch";
  if (/(^|_)(build|compile|bundle)(_|$)/.test(name)) return "build";
  if (/(^|_)(verify|validation)(_|$)/.test(name)) return "verify";
  if (/(^|_)(test|lint|typecheck)(_|$)/.test(name)) return "test";
  if (/(^|_)(git|branch|commit|checkout)(_|$)/.test(name)) return name.includes("commit") ? "commit" : "git";
  if (/(^|_)(tool|function)_?use(_|$)/.test(name)) return "tool";
  if (/(^|_)(run|exec|execute|command|shell|terminal)(_|$)/.test(name)) return "execute";
  return "generic";
}

export interface ActivityIconProps {
  kind: ActivityKind;
  state?: ActivityState;
  size?: 14 | 16 | 18 | 20 | 24;
  filePath?: string;
}

export const ActivityIcon = React.memo(function ActivityIcon({ kind, state = "static", size = 20, filePath }: ActivityIconProps) {
  return (
    <span className={`activity-icon activity-icon-${kind} activity-icon-state-${state}`} style={{ width: size, height: size }} data-activity-kind={kind} data-activity-state={state} aria-hidden="true">
      <img src={resolveActivityAsset(kind, filePath)} width={size} height={size} alt="" draggable={false} />
    </span>
  );
});

export interface ForgeWorkingIndicatorProps {
  active: boolean;
  label?: string;
}

export function ForgeWorkingIndicator({ active, label = "Forging..." }: ForgeWorkingIndicatorProps) {
  if (!active) return null;
  return (
    <div className="forge-working-indicator" data-active="true" role="status" aria-live="polite">
      <ActivityIcon kind="forge" state="active" size={20} />
      <span className="forge-working-label">{label}</span>
      <span className="sr-only">CodeForge is actively working.</span>
    </div>
  );
}

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

function IconShape({ kind }: { kind: ActivityKind }) {
  switch (kind) {
    case "search":
      return <><circle cx="10" cy="10" r="5.5" /><path d="m14.2 14.2 5 5" /></>;
    case "read":
      return <><path d="M5 3.5h9l4 4v13H5z" /><path d="M14 3.5v4h4M8 12h7M8 15.5h5" /></>;
    case "reason":
      return <><path d="M8.2 18.5c-2.2-.8-3.7-2.9-3.7-5.3 0-3.5 2.8-6.2 6.3-6.2s6.3 2.7 6.3 6.2c0 2.4-1.5 4.5-3.7 5.3" /><path d="M8 18.5h6M8.8 21h4.4M8 11.4c.5-.9 1.2-1.4 2.2-1.4 1.5 0 1.8 1.2 1.8 2.1 0 1.2-.8 1.8-1.8 2.5-.7.5-1 1-1 1.8" /></>;
    case "plan":
      return <><rect x="4.5" y="4" width="15" height="16" rx="2" /><path d="m7.5 8 1.2 1.2L11 7M12.5 8h4M7.5 13l1.2 1.2L11 12M12.5 13h4M7.5 18h9" /></>;
    case "edit":
      return <><path d="m4 17.8-.8 3 3-.8L18.7 7.5a2.1 2.1 0 0 0-3-3z" /><path d="m14.5 6.5 3 3" /></>;
    case "create":
      return <><path d="M5 3.5h9l4 4v13H5z" /><path d="M14 3.5v4h4M12 12v6M9 15h6" /></>;
    case "delete":
      return <><path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>;
    case "execute":
      return <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="m7 9 3 3-3 3M12.5 15H17" /></>;
    case "fetch":
      return <><circle cx="12" cy="12" r="8.5" /><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.2 5.1 3.2 8.5s-1 6.2-3.2 8.5c-2.2-2.3-3.2-5.1-3.2-8.5S9.8 5.8 12 3.5z" /></>;
    case "test":
      return <><path d="M9 3.5h6M10 3.5v6.2l-4.3 8.1A1.8 1.8 0 0 0 7.3 20h9.4a1.8 1.8 0 0 0 1.6-2.2L14 9.7V3.5" /><path d="M8 15h8" /></>;
    case "verify":
      return <><path d="M12 3.5 19 6v5.4c0 4.5-2.8 7.7-7 9.1-4.2-1.4-7-4.6-7-9.1V6z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>;
    case "git":
      return <><circle cx="7" cy="6" r="2" /><circle cx="17" cy="18" r="2" /><circle cx="17" cy="6" r="2" /><path d="M9 6h6M7 8v5c0 2.8 2.2 5 5 5h3M17 8v8" /></>;
    case "commit":
      return <><circle cx="12" cy="12" r="4" /><path d="M2.5 12h5.5M16 12h5.5" /></>;
    case "error":
      return <><path d="m12 3.5 9 16H3z" /><path d="M12 9v5M12 17.2v.1" /></>;
    case "waiting":
      return <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></>;
    case "parallel":
      return <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h4a4 4 0 0 1 4 4v6M8 6h4a4 4 0 0 0 4-4" /></>;
    case "success":
      return <><circle cx="12" cy="12" r="8.5" /><path d="m7.8 12 2.8 2.8 5.8-6" /></>;
    case "forge":
      return <><path className="forge-torch" d="m3.5 4.5 7.1 7.1 3.1-3.1 5.2 5.2-3.1 3.1-5.2-5.2" /><path className="forge-nozzle" d="m13.7 16.8-2 2" /><path className="forge-spark forge-spark-one" d="m19.6 18.2 1.4 1.4" /><path className="forge-spark forge-spark-two" d="m20.5 14.7 1.2-.2" /><path className="forge-spark forge-spark-three" d="m17.4 20.7.2 1.2" /></>;
    case "generic":
      return <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2" /></>;
  }
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

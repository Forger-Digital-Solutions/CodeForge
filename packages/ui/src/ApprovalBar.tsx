import React from "react";
import type { WorkItem } from "@codeforge/sessions";

interface ApprovalBarProps {
  approval: Extract<WorkItem, { kind: "approval" }>;
  onApprove: (decision: "allow_once" | "allow_session" | "deny") => void;
  onDeny: () => void;
}

function riskStyle(risk: string): { bg: string; fg: string; border: string } {
  switch (risk) {
    case "critical": return { bg: "#2b0e0e", fg: "#f87171", border: "#7f1d1d" };
    case "high": return { bg: "#2b1a00", fg: "#fbbf24", border: "#92400e" };
    case "moderate": return { bg: "#0a1e3a", fg: "#60a5fa", border: "#1e40af" };
    default: return { bg: "var(--cf-bg-overlay)", fg: "var(--cf-text-muted)", border: "var(--cf-border)" };
  }
}

const INSTALL_RE = /^(npm (install|i)\b|yarn add\b|pnpm (add|install)\b|pip install\b|bun add\b)/i;

/**
 * Descriptions arrive as `${tool}: ${operation} — ${classification}` for tool
 * approvals and as prose for plan review. Split into operation (what runs) and
 * detail (why it's being asked) — the dock leads with the operation.
 */
function describeOperation(approval: Extract<WorkItem, { kind: "approval" }>): { operation: string; detail: string } {
  const isPlan = approval.tool === "workflow" && approval.action === "execute_plan";
  if (isPlan) {
    return { operation: "Review the plan for this task", detail: approval.description };
  }
  const raw = approval.description;
  const withoutTool = raw.startsWith(`${approval.tool}:`) ? raw.slice(approval.tool.length + 1).trim() : raw;
  const dash = withoutTool.indexOf(" — ");
  if (dash > 0) {
    return { operation: withoutTool.slice(0, dash), detail: withoutTool.slice(dash + 3) };
  }
  return { operation: withoutTool, detail: "" };
}

function consequenceFor(approval: Extract<WorkItem, { kind: "approval" }>, operation: string): string {
  if (approval.tool === "workflow" && approval.action === "execute_plan") {
    return "Approving starts the plan. Individual boundary crossings still ask separately.";
  }
  if (INSTALL_RE.test(operation)) {
    return "Downloads packages from the registry and updates dependency files.";
  }
  if (/\bgit\s+push\b/i.test(operation)) {
    return "This modifies the shared remote repository.";
  }
  if (approval.action === "write") {
    return "Changes files on disk.";
  }
  if (approval.risk === "critical") {
    return "This is a sensitive or destructive action.";
  }
  if (approval.risk === "high") {
    return "This action reaches outside the routine workspace envelope.";
  }
  return "";
}

export default function ApprovalBar({ approval, onApprove, onDeny }: ApprovalBarProps) {
  const isPlan = approval.tool === "workflow" && approval.action === "execute_plan";
  // Task-scoped persistence is only meaningful where the lease will mint a
  // grant — never on high/critical (external, sensitive, destructive) actions.
  const persistentAllowed = !isPlan && approval.risk !== "high" && approval.risk !== "critical";
  const r = riskStyle(approval.risk);
  const { operation, detail } = describeOperation(approval);
  const consequence = consequenceFor(approval, operation);
  const scopeLabel = INSTALL_RE.test(operation) ? "Allow installs for this task" : "Allow for this task";

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Escape is a safe refusal — it can never approve.
    if (e.key === "Escape") {
      e.stopPropagation();
      onDeny();
    }
  };

  return (
    <div
      className="approval-bar approval-dock"
      style={{ borderColor: r.border }}
      role="region"
      aria-label="Approval needed"
      onKeyDown={onKeyDown}
    >
      <div className="approval-bar-header">
        <span className="approval-bar-title">
          {isPlan ? "Plan review" : "Approval needed"}
        </span>
        <span
          className="approval-bar-risk"
          style={{ color: r.fg, background: r.bg, border: `1px solid ${r.border}` }}
        >
          {approval.risk}
        </span>
      </div>
      <div className="approval-bar-body">
        <div className="approval-bar-action"><code>{operation}</code></div>
        {consequence && <span className="approval-bar-description">{consequence}</span>}
        {detail && <span className="approval-bar-detail">{detail}</span>}
        {approval.scope && !isPlan && (
          <div className="approval-bar-scope"><span>Scope</span><code>{approval.scope}</code></div>
        )}
        <details className="approval-technical-details">
          <summary>Details</summary>
          <code>{approval.tool} · {approval.action}</code>
        </details>
      </div>
      <div className="approval-bar-actions">
        <button className="btn-sm primary" onClick={() => onApprove("allow_once")}>
          {isPlan ? "Start now" : "Allow once"}
        </button>
        {persistentAllowed && (
          <button className="btn-sm" onClick={() => onApprove("allow_session")}>
            {scopeLabel}
          </button>
        )}
        <button className="btn-sm danger" onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

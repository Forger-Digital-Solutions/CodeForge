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

export default function ApprovalBar({ approval, onApprove, onDeny }: ApprovalBarProps) {
  const isWorkflow = approval.tool === "workflow" && approval.action === "execute_plan";
  const r = riskStyle(approval.risk);
  const actionLabel = isWorkflow ? "continue the approved implementation plan" : approval.action.replace(/_/g, " ");

  return (
    <div className="approval-bar" style={{ borderColor: r.border }}>
      <div className="approval-bar-header">
        <span className="approval-bar-title">
          Permission Required
        </span>
        <span
          className="approval-bar-risk"
          style={{ color: r.fg, background: r.bg, border: `1px solid ${r.border}` }}
        >
          {approval.risk}
        </span>
      </div>
      <div className="approval-bar-body">
        <div className="approval-bar-label">CodeForge wants to</div>
        <div className="approval-bar-action">{actionLabel}</div>
        <div className="approval-bar-label">Why</div>
        <span className="approval-bar-description">{approval.description}</span>
        {approval.scope && (
          <div className="approval-bar-scope"><span>Scope</span><code>{approval.scope}</code></div>
        )}
        {isWorkflow && (
          <span className="approval-bar-note">ForgeZero permits verified-free routes only. Denying stops this task safely.</span>
        )}
        <details className="approval-technical-details">
          <summary>Technical details</summary>
          <code>{approval.tool} · {approval.action}</code>
        </details>
      </div>
      <div className="approval-bar-actions">
        <button className="btn-sm primary" onClick={() => onApprove("allow_once")}>
          Allow once
        </button>
        <button className="btn-sm" onClick={() => onApprove("allow_session")}>
          Allow for task
        </button>
        <button className="btn-sm danger" onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

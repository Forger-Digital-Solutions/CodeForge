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

  return (
    <div className="approval-bar" style={{ borderColor: r.border }}>
      <div className="approval-bar-header">
        <span className="approval-bar-title">
          {isWorkflow ? "Plan Approval Required" : "Permission Required"}
        </span>
        <span
          className="approval-bar-risk"
          style={{ color: r.fg, background: r.bg, border: `1px solid ${r.border}` }}
        >
          {approval.risk}
        </span>
      </div>
      <div className="approval-bar-body">
        <span style={{ fontSize: 10, color: "var(--cf-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {isWorkflow ? "Plan:" : "Action:"}
        </span>{" "}
        <code>{approval.tool} · {approval.action}</code>
        <br />
        <span style={{ whiteSpace: "pre-wrap" }}>{approval.description}</span>
        {approval.scope && (
          <>
            <br />
            <span style={{ fontSize: 10, color: "var(--cf-text-muted)" }}>Scope: </span>
            <code style={{ fontSize: 11 }}>{approval.scope}</code>
          </>
        )}
        {isWorkflow && (
          <>
            <br />
            <span style={{ fontSize: 10, color: "var(--cf-text-muted)", marginTop: 4, display: "block" }}>
              Approving executes via ForgeZero-verified free models only. Deny fails safely.
            </span>
          </>
        )}
      </div>
      <div className="approval-bar-actions">
        <button className="btn-sm primary" onClick={() => onApprove("allow_once")}>
          {isWorkflow ? "Approve Plan" : "Allow Once"}
        </button>
        <button className="btn-sm" onClick={() => onApprove("allow_session")}>
          Allow for Session
        </button>
        <button className="btn-sm danger" onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

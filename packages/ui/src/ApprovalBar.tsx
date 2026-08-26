import React from "react";
import type { WorkItem } from "@codeforge/sessions";

interface ApprovalBarProps {
  approval: Extract<WorkItem, { kind: "approval" }>;
  onApprove: (decision: "allow_once" | "allow_session" | "deny") => void;
  onDeny: () => void;
}

export default function ApprovalBar({ approval, onApprove, onDeny }: ApprovalBarProps) {
  return (
    <div style={{
      position: "fixed",
      bottom: 80,
      left: "50%",
      transform: "translateX(-50%)",
      background: "var(--bg-secondary)",
      border: "1px solid var(--warning)",
      borderRadius: "var(--radius-lg)",
      padding: 14,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 1000,
      minWidth: 400,
      maxWidth: 600,
    }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--warning)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Approval Required
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.6 }}>
        <strong>Run:</strong> <code style={{ fontFamily: "var(--font-mono)", background: "var(--bg-tertiary)", padding: "2px 6px", borderRadius: "var(--radius)" }}>{approval.action}</code>
        <br />
        {approval.description}
        {approval.scope && <><br /><strong>Scope:</strong> {approval.scope}</>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="work-item-btn primary" onClick={() => onApprove("allow_once")}>Allow Once</button>
        <button className="work-item-btn" onClick={() => onApprove("allow_session")}>Allow for Session</button>
        <button className="work-item-btn danger" onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

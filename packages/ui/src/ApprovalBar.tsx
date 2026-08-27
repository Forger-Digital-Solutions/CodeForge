import React from "react";
import type { WorkItem } from "@codeforge/sessions";

interface ApprovalBarProps {
  approval: Extract<WorkItem, { kind: "approval" }>;
  onApprove: (decision: "allow_once" | "allow_session" | "deny") => void;
  onDeny: () => void;
}

function riskLabel(risk: string): { bg: string; fg: string; border: string } {
  switch (risk) {
    case "critical": return { bg: "#3a0a0a", fg: "#f87171", border: "#7f1d1d" };
    case "high": return { bg: "#3a1a00", fg: "#fbbf24", border: "#92400e" };
    case "moderate": return { bg: "#0a2040", fg: "#60a5fa", border: "#1e40af" };
    default: return { bg: "#27272a", fg: "#a1a1aa", border: "#3f3f46" };
  }
}

export default function ApprovalBar({ approval, onApprove, onDeny }: ApprovalBarProps) {
  const isWorkflow = approval.tool === "workflow" && approval.action === "execute_plan";
  const r = riskLabel(approval.risk);
  return (
    <div style={{
      position: "fixed",
      bottom: 80,
      left: "50%",
      transform: "translateX(-50%)",
      background: "var(--bg-secondary, #1e1e22)",
      border: `1px solid ${r.border}`,
      borderRadius: "var(--radius-lg, 10px)",
      padding: 14,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 1000,
      minWidth: 420,
      maxWidth: 640,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 11, color: isWorkflow ? "#f59e0b" : "var(--warning, #f59e0b)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
          {isWorkflow ? "Workflow Plan Approval Required" : "Approval Required"}
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: r.fg, background: r.bg, border: `1px solid ${r.border}`, padding: "3px 7px", borderRadius: 999 }}>{approval.risk}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary, #d4d4d8)", marginBottom: 10, lineHeight: 1.6 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted, #a1a1aa)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Action:</span>{" "}
        <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-tertiary, #27272a)", padding: "2px 6px", borderRadius: "var(--radius, 6px)", border: "1px solid var(--border-subtle, #2a2a2e)" }}>{approval.tool} · {approval.action}</code>
        <br />
        <span style={{ whiteSpace: "pre-wrap" }}>{approval.description}</span>
        {approval.scope && <><br /><span style={{ fontSize: 10, color: "var(--text-muted, #a1a1aa)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Scope:</span> <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-tertiary, #27272a)", padding: "2px 6px", borderRadius: 6, fontSize: 11 }}>{approval.scope}</code></>}
        {isWorkflow && (
          <>
            <br />
            <span style={{ fontSize: 10, color: "var(--text-muted, #a1a1aa)" }}>This plan was generated from repository inspection and context analysis. Approving executes the edit/write steps via ForgeZero-verified free models only. Deny fails safely with no changes applied.</span>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="work-item-btn primary" onClick={() => onApprove("allow_once")} title={isWorkflow ? "Approve this plan once" : "Allow once"}>{isWorkflow ? "Approve Plan" : "Allow Once"}</button>
        <button className="work-item-btn" onClick={() => onApprove("allow_session")} title="Allow for the rest of this session">Allow for Session</button>
        <button className="work-item-btn danger" onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

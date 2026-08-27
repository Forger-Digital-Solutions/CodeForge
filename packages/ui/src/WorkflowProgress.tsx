import React from "react";
import type { WorkspaceState } from "./workspace-sse.js";

interface WorkflowProgressProps {
  state: WorkspaceState;
  onCancel: () => void;
  onApprove: (decision: "allow_once" | "allow_session" | "deny") => void;
}

const PHASES: Array<{ key: string; label: string; short: string }> = [
  { key: "received", label: "Received", short: "Rcv" },
  { key: "reconnaissance", label: "Reconnaissance", short: "Reco" },
  { key: "planning", label: "Planning", short: "Plan" },
  { key: "user_input_required", label: "Awaiting Approval", short: "Appr" },
  { key: "implementing", label: "Implementing", short: "Impl" },
  { key: "testing", label: "Verifying", short: "Verify" },
  { key: "diagnosing", label: "Diagnosing", short: "Diag" },
  { key: "repairing", label: "Repairing", short: "Repair" },
  { key: "reviewing", label: "Reviewing", short: "Review" },
  { key: "validating", label: "Summarizing", short: "Sum" },
  { key: "complete", label: "Completed", short: "Done" },
];

function phaseIndex(phase: string): number {
  const direct = PHASES.findIndex((p) => p.key === phase);
  if (direct !== -1) return direct;
  const map: Record<string, string> = {
    understanding: "reconnaissance",
    inspecting: "reconnaissance",
    building_context: "reconnaissance",
    awaiting_approval: "user_input_required",
    verifying: "testing",
    summarizing: "validating",
    completed: "complete",
    failed_safely: "complete",
    cancelled: "complete",
    failed: "complete",
  };
  const mapped = map[phase];
  if (mapped) return PHASES.findIndex((p) => p.key === mapped);
  return -1;
}

function riskColor(risk: string): string {
  switch (risk) {
    case "critical": return "#ef4444";
    case "high": return "#f59e0b";
    case "moderate": return "#3b82f6";
    default: return "#6b7280";
  }
}

export default function WorkflowProgress({ state, onCancel, onApprove }: WorkflowProgressProps) {
  const { activeTaskId, workflowTasks, activePhase, workflowProgress, isRunning, workflowError, workflowActionError, workflowActionPending, pendingApproval, lastWorkflowResult, lastEvidenceId, lastCheckpointId } = state;
  const activeTask = activeTaskId ? workflowTasks.find((t) => t.taskId === activeTaskId) ?? null : null;
  const idx = phaseIndex(activePhase);
  const hasActiveWorkflow = Boolean(activeTaskId || isRunning || pendingApproval?.tool === "workflow" || workflowError || lastWorkflowResult);

  if (!hasActiveWorkflow) return null;

  const showApproval = pendingApproval && pendingApproval.tool === "workflow" && pendingApproval.action === "execute_plan";
  const isTerminal = activePhase === "complete" || activePhase === "completed" || activePhase === "failed_safely" || activePhase === "cancelled" || activePhase === "failed";

  return (
    <div
      className="workflow-progress"
      role="status"
      aria-live="polite"
      style={{
        background: "var(--bg-secondary, #1a1a1e)",
        borderBottom: "1px solid var(--border-subtle, #2a2a2e)",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Header: task title + trust badges + actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--accent, #7c5cff)", textTransform: "uppercase" }}>Autonomous Workflow</span>
            {isRunning && <span style={{ width: 8, height: 8, borderRadius: 999, background: "#22c55e", display: "inline-block", animation: "pulse 1.2s infinite" }} aria-hidden />}
            {isTerminal && activePhase === "complete" && <span style={{ fontSize: 10, background: "#062e1a", color: "#22c55e", border: "1px solid #14532d", padding: "2px 6px", borderRadius: 999 }}>✓ Verified & Completed</span>}
            {activePhase === "failed_safely" && <span style={{ fontSize: 10, background: "#2b0e0e", color: "#ef4444", border: "1px solid #7f1d1d", padding: "2px 6px", borderRadius: 999 }}>ⓧ Failed safely</span>}
            {activePhase === "cancelled" && <span style={{ fontSize: 10, background: "#27272a", color: "#a1a1aa", border: "1px solid #3f3f46", padding: "2px 6px", borderRadius: 999 }}>⊘ Cancelled</span>}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary, #e5e5e5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={activeTask?.title ?? activeTaskId ?? "Autonomous task"}>
            {activeTask?.title ? (activeTask.title.length > 80 ? activeTask.title.slice(0, 80) + "…" : activeTask.title) : (pendingApproval?.description ?? "Autonomous coding task")}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 10, color: "var(--text-muted, #a1a1aa)" }}>
            <span style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-tertiary, #27272a)", border: "1px solid var(--border-subtle, #2a2a2e)", padding: "2px 6px", borderRadius: 6 }}>{activePhase || "idle"}</span>
            {activeTaskId && <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{activeTaskId.slice(0, 8)}</span>}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>🛡 Workspace Isolated</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>⚡ ForgeZero Verified Free</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>⧖ 10m timeout</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>◉ Secrets Redacted</span>
            {lastEvidenceId && <span style={{ color: "#22c55e" }}>Evidence {lastEvidenceId.slice(0, 8)}</span>}
            {lastCheckpointId && <span style={{ color: "#60a5fa" }}>Checkpoint {lastCheckpointId.slice(0, 8)}</span>}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          {showApproval ? (
            <>
              <button className="work-item-btn primary" onClick={() => onApprove("allow_once")} title="Approve this plan for a single execution">Approve Plan</button>
              <button className="work-item-btn" onClick={() => onApprove("allow_session")} title="Approve for the rest of this session">Allow Session</button>
              <button className="work-item-btn danger" onClick={() => onApprove("deny")} title="Reject this plan and fail safely">Deny</button>
            </>
          ) : isRunning && !isTerminal ? (
            <button className="work-item-btn danger" onClick={onCancel} disabled={workflowActionPending === "cancel"}>
              {workflowActionPending === "cancel" ? "Cancelling…" : "Cancel Workflow"}
            </button>
          ) : null}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ height: 6, background: "var(--bg-tertiary, #27272a)", borderRadius: 999, overflow: "hidden", border: "1px solid var(--border-subtle, #2a2a2e)" }}>
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, Math.max(0, workflowProgress))}%`,
              background: isTerminal && activePhase === "failed_safely" ? "#ef4444" : activePhase === "cancelled" ? "#71717a" : "var(--accent, #7c5cff)",
              transition: "width 0.4s ease",
            }}
            role="progressbar"
            aria-valuenow={workflowProgress}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", paddingBottom: 2 }} className="scrollbar-thin">
          {PHASES.map((p, i) => {
            const isPast = idx >= 0 ? i < idx : false;
            const isCurrent = i === idx;
            const isFuture = idx >= 0 ? i > idx : false;
            return (
              <React.Fragment key={p.key}>
                <span
                  className={`workflow-phase-dot ${isPast ? "past" : ""} ${isCurrent ? "current" : ""} ${isFuture ? "future" : ""}`}
                  title={p.label}
                  aria-label={`${p.label} ${isCurrent ? "(current)" : isPast ? "(completed)" : ""}`}
                  style={{
                    fontSize: 10,
                    padding: "3px 7px",
                    borderRadius: 999,
                    whiteSpace: "nowrap",
                    border: "1px solid",
                    background: isCurrent ? "var(--accent, #7c5cff)" : isPast ? "#27272a" : "transparent",
                    color: isCurrent ? "white" : isPast ? "#e5e5e5" : "var(--text-muted, #a1a1aa)",
                    borderColor: isCurrent ? "var(--accent, #7c5cff)" : "var(--border-subtle, #2a2a2e)",
                    fontWeight: isCurrent ? 700 : 500,
                    opacity: isFuture ? 0.7 : 1,
                  }}
                >
                  {isPast ? "✓ " : isCurrent && isRunning ? "● " : ""}{p.short}
                </span>
                {i < PHASES.length - 1 && (
                  <span aria-hidden style={{ color: "var(--border-subtle, #2a2a2e)", fontSize: 9 }}>→</span>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Approval detail for plan */}
      {showApproval && (
        <div style={{ background: "var(--bg-tertiary, #27272a)", border: "1px solid #f59e0b55", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#f59e0b" }}>Plan Approval Required</span>
            <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 999, border: "1px solid", borderColor: riskColor(pendingApproval.risk), color: riskColor(pendingApproval.risk), background: "var(--bg-secondary, #1a1a1e)", fontWeight: 700, textTransform: "uppercase" }}>{pendingApproval.risk}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary, #d4d4d8)", lineHeight: 1.5 }}>
            <span style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-secondary, #1a1a1e)", padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border-subtle, #2a2a2e)" }}>workflow · execute_plan</span>{" "}
            {pendingApproval.description}
            {pendingApproval.scope && (
              <>
                <br />
                <span style={{ fontSize: 10, color: "var(--text-muted, #a1a1aa)" }}>Scope: </span>
                <code style={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)", background: "var(--bg-secondary, #1a1a1e)", padding: "2px 6px", borderRadius: 6 }}>{pendingApproval.scope}</code>
              </>
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted, #a1a1aa)" }}>
            CodeForge will execute only after you approve. High/critical plans always require explicit approval — moderate edits are auto-approved only for deterministic workflows and are always auditable via approval.requested / approval.resolved events.
          </div>
        </div>
      )}

      {/* Error banner */}
      {(workflowError || workflowActionError) && (
        <div style={{ background: "#2b0e0e", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 10, padding: "10px 12px", fontSize: 12, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <strong style={{ color: "#f87171" }}>Workflow Notice:</strong> {workflowError ?? workflowActionError}
            {workflowActionError?.includes("already running") || workflowActionError?.includes("A workflow is already running") ? (
              <span> — Only one workflow may run per session. Cancel or wait for completion.</span>
            ) : null}
            {workflowActionError?.includes("timed out") && <span> — The workflow exceeded the 10 minute safety timeout and was cancelled.</span>}
            {(workflowError?.includes("Workspace path") || workflowActionError?.includes("Invalid workspace")) && <span> — Check that your project folder exists and is a directory.</span>}
          </div>
        </div>
      )}

      {/* Last result summary when completed */}
      {lastWorkflowResult && !isRunning && (
        <div style={{ background: "var(--bg-tertiary, #27272a)", border: "1px solid var(--border-subtle, #2a2a2e)", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "var(--text-secondary, #d4d4d8)", whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }} className="scrollbar-thin">
          {lastWorkflowResult.slice(0, 2000)}
        </div>
      )}

      {/* Trust footer */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 10, color: "var(--text-muted, #71717a)", borderTop: "1px solid var(--border-subtle, #1a1a1e)", paddingTop: 8, marginTop: 2 }}>
        <span>✓ No paid inference (ForgeZero)</span>
        <span>✓ Workspace-bound edits only</span>
        <span>✓ Atomic writes + hash-checked</span>
        <span>✓ Secret redaction throughout</span>
        <span>✓ Deterministic mock-provider E2E proven</span>
      </div>
    </div>
  );
}

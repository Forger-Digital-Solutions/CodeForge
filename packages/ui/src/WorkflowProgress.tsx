import React, { useState } from "react";
import type { WorkspaceState } from "./workspace-sse.js";

interface WorkflowProgressProps {
  state: WorkspaceState;
  onCancel: () => void;
  onApprove: (decision: "allow_once" | "allow_session" | "deny") => void;
  expanded?: boolean;
}

export const PHASES: Array<{ key: string; label: string }> = [
  { key: "received", label: "Received" },
  { key: "reconnaissance", label: "Reconnaissance" },
  { key: "planning", label: "Planning" },
  { key: "user_input_required", label: "Approval" },
  { key: "implementing", label: "Implementing" },
  { key: "testing", label: "Verifying" },
  { key: "diagnosing", label: "Diagnosing" },
  { key: "repairing", label: "Repairing" },
  { key: "reviewing", label: "Reviewing" },
  { key: "validating", label: "Summarizing" },
  { key: "complete", label: "Completed" },
];

export function phaseIndex(phase: string): number {
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

export default function WorkflowProgress({ state, onCancel, onApprove, expanded: controlledExpanded }: WorkflowProgressProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const { activePhase, isRunning, pendingApproval, activeTaskId, workflowError, lastWorkflowResult } = state;

  const hasActiveWorkflow = Boolean(
    activeTaskId || isRunning || pendingApproval?.tool === "workflow" || workflowError || lastWorkflowResult,
  );

  if (!hasActiveWorkflow) return null;

  const idx = phaseIndex(activePhase);
  const completedCount = idx >= 0 ? Math.min(idx + 1, PHASES.length) : 0;
  const isTerminal = activePhase === "complete" || activePhase === "completed" || activePhase === "failed_safely" || activePhase === "cancelled" || activePhase === "failed";

  const showApproval = pendingApproval && pendingApproval.tool === "workflow" && pendingApproval.action === "execute_plan";

  const statusText = isTerminal
    ? activePhase === "complete" || activePhase === "completed"
      ? `Completed · ${completedCount}/${PHASES.length} stages`
      : activePhase === "failed_safely"
        ? "Failed safely"
        : activePhase === "cancelled"
          ? "Cancelled"
          : "Failed"
    : isRunning
      ? `Working · ${activePhase}`
      : `${completedCount}/${PHASES.length} stages`;

  return (
    <div className="workflow-stages" role="status" aria-live="polite">
      <button
        type="button"
        className="workflow-stages-header"
        onClick={() => setInternalExpanded(!internalExpanded)}
        aria-expanded={expanded}
      >
        <span className="activity-chevron" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
        <span>{statusText}</span>
        {isRunning && !isTerminal && (
          <span style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className="btn-sm danger"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              Cancel
            </button>
          </span>
        )}
      </button>

      {expanded && (
        <div className="workflow-stages-list">
          {PHASES.map((p, i) => {
            const isPast = idx >= 0 ? i < idx : false;
            const isCurrent = i === idx;
            const className = isPast ? "past" : isCurrent ? "current" : "future";
            return (
              <div key={p.key} className={`workflow-stage ${className}`}>
                <span className="workflow-stage-icon">
                  {isPast ? "✓" : isCurrent && isRunning ? "●" : "○"}
                </span>
                <span>{p.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/*
        The decision itself belongs to exactly one control — ApprovalBar. This panel reports that
        the workflow is parked and why, but offers no second set of buttons: rendering the same
        approval as several independent cards made one decision look like several, and left the
        user unsure which one the agent was actually waiting on.
      */}
      {showApproval && (
        <div className="workflow-awaiting" style={{ marginTop: 8 }}>
          <span className="workflow-awaiting-dot" aria-hidden="true">●</span>
          <span>
            Waiting for your decision on <code>{pendingApproval.action}</code> — see the approval
            prompt below.
          </span>
        </div>
      )}
    </div>
  );
}

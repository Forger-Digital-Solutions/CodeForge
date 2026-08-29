import React, { useState, useRef, useEffect } from "react";
import type { TurnRecord, WorkItem } from "@codeforge/sessions";
import InlineComments from "./InlineComments.js";
import DiffViewer from "./DiffViewer.js";

interface ConversationProps {
  turns: TurnRecord[];
  workItems: WorkItem[];
  displayMode: string;
  onDisplayModeChange?: (mode: "compact" | "detailed" | "debug") => void;
  isRunning?: boolean;
  /** Sends a starter prompt when the user clicks a suggestion in the empty state. */
  onSuggestedPrompt?: (text: string) => void;
  /** Short context label shown under the empty-state heading, e.g. "CodeForge · main". */
  contextLabel?: string;
}

const WorkItemRenderer = ({ item, displayMode }: { item: WorkItem; displayMode: string }) => {
  const [isCollapsed, setIsCollapsed] = useState(true);

  const toggle = () => setIsCollapsed(!isCollapsed);

  switch (item.kind) {
    case "activity": {
      const a = item as Extract<WorkItem, { kind: "activity" }>;
      const iconClass = a.status === "completed" ? "success" : a.status === "failed" ? "error" : "running";
      const iconChar = a.status === "completed" ? "✓" : a.status === "failed" ? "✕" : "●";
      return (
        <div className="activity-block">
          <button type="button" className="activity-header" onClick={toggle}>
            <span className={`activity-chevron ${!isCollapsed ? "open" : ""}`}>›</span>
            <span className={`activity-icon ${iconClass}`}>{iconChar}</span>
            <span className="activity-title">{a.title}</span>
            {a.durationMs ? <span className="activity-meta">{a.durationMs}ms</span> : null}
          </button>
          {!isCollapsed && (
            <div className="activity-body">
              {displayMode !== "compact" && a.detail && <div>{a.detail}</div>}
              {displayMode === "debug" && a.expandedDetail && (
                <div style={{ fontFamily: "var(--cf-font-mono)", fontSize: 11, marginTop: 4 }}>
                  {a.expandedDetail}
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    case "command": {
      const c = item as Extract<WorkItem, { kind: "command" }>;
      const isRunning = c.status === "running";
      const isFailed = c.status === "failed";
      return (
        <div className="activity-block">
          <button type="button" className="activity-header" onClick={toggle}>
            <span className={`activity-chevron ${!isCollapsed ? "open" : ""}`}>›</span>
            <span className={`activity-icon ${isFailed ? "error" : isRunning ? "running" : "success"}`}>
              {isFailed ? "✕" : isRunning ? "●" : "✓"}
            </span>
            <span className="activity-title">Ran {c.command}</span>
            <span className="activity-meta">
              {isRunning ? "Running" : isFailed ? `Exit ${c.exitCode ?? 1}` : "Passed"}
              {c.durationMs ? ` · ${c.durationMs}ms` : ""}
            </span>
          </button>
          {!isCollapsed && (
            <div className="activity-body">
              {c.workingDirectory && displayMode !== "compact" && (
                <div style={{ fontSize: 11, fontFamily: "var(--cf-font-mono)", color: "var(--cf-text-muted)", marginBottom: 4 }}>
                  Cwd: {c.workingDirectory}
                </div>
              )}
              {c.output && (
                <div className="command-block">
                  <div className="command-output">{c.output}</div>
                </div>
              )}
              {isFailed && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button type="button" className="btn-sm">Retry</button>
                  <button type="button" className="btn-sm">Ask Agent to Fix</button>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    case "file_change": {
      const f = item as Extract<WorkItem, { kind: "file_change" }>;
      return (
        <div className="activity-block">
          <button type="button" className="activity-header" onClick={toggle}>
            <span className={`activity-chevron ${!isCollapsed ? "open" : ""}`}>›</span>
            <span className={`activity-icon ${f.changeType === "created" ? "success" : f.changeType === "deleted" ? "error" : "running"}`}>
              {f.changeType === "created" ? "+" : f.changeType === "deleted" ? "−" : "✎"}
            </span>
            <span className="activity-title">Edited {f.path}</span>
            <span className="activity-meta">+{f.additions} −{f.deletions}</span>
          </button>
          {!isCollapsed && (
            <div className="activity-body">
              {f.diff && <DiffViewer diff={f.diff} fileName={f.path} />}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button type="button" className="btn-sm">Open File</button>
                {f.changeType !== "created" && (
                  <button type="button" className="btn-sm danger">Revert</button>
                )}
              </div>
            </div>
          )}
        </div>
      );
    }

    case "test_run": {
      const t = item as Extract<WorkItem, { kind: "test_run" }>;
      const isFailed = t.failed > 0;
      return (
        <div className="activity-block">
          <button type="button" className="activity-header" onClick={toggle}>
            <span className={`activity-chevron ${!isCollapsed ? "open" : ""}`}>›</span>
            <span className={`activity-icon ${isFailed ? "error" : "success"}`}>
              {isFailed ? "✕" : "✓"}
            </span>
            <span className="activity-title">{t.name || "Test Suite"}</span>
            <span className="activity-meta">
              {t.passed} passed{t.failed > 0 ? ` · ${t.failed} failed` : ""}
            </span>
          </button>
          {!isCollapsed && (
            <div className="activity-body">
              {t.failures && t.failures.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {t.failures.map((f, i) => (
                    <div key={i} style={{ color: "var(--cf-danger)", marginBottom: 4, fontFamily: "var(--cf-font-mono)", fontSize: 11 }}>
                      {f.test}: {f.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    case "plan": {
      const p = item as Extract<WorkItem, { kind: "plan" }>;
      return (
        <div className="plan-container">
          <div className="plan-header">
            <span className="plan-title">{p.title}</span>
            <span className="plan-status">{p.status.replace(/_/g, " ")}</span>
          </div>
          <div className="plan-steps">
            {p.steps.map((step) => (
              <div key={step.id} className="plan-step">
                <span className="plan-step-icon">
                  {step.status === "completed" ? "✓" : step.status === "active" ? "●" : step.status === "failed" ? "✕" : "○"}
                </span>
                <span>{step.description}</span>
                <span className="plan-step-status">{step.status.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
          {p.comments && p.comments.length > 0 && (
            <InlineComments
              comments={p.comments.map((c) => ({
                id: c.id,
                author: c.author,
                text: c.text,
                createdAt: new Date().toISOString(),
              }))}
              onAdd={() => {}}
            />
          )}
        </div>
      );
    }

    case "approval": {
      const a = item as Extract<WorkItem, { kind: "approval" }>;
      return (
        <div className="approval-card">
          <div className="approval-header">Approval Required</div>
          <div className="approval-body">
            <strong>Run:</strong> <code>{a.action}</code>
            <br />
            {a.description}
            {a.scope && (
              <>
                <br />
                <strong>Scope:</strong> <code>{a.scope}</code>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn-sm primary">Allow Once</button>
            <button type="button" className="btn-sm">Allow for Session</button>
            <button type="button" className="btn-sm danger">Deny</button>
          </div>
        </div>
      );
    }

    case "question": {
      const q = item as Extract<WorkItem, { kind: "question" }>;
      return (
        <div className="question-card">
          <div className="question-header">Agent Question</div>
          <div className="question-body">{q.prompt}</div>
          {q.options && q.options.length > 0 && (
            <div className="question-options">
              {q.options.map((opt) => (
                <button key={opt} type="button" className="btn-sm primary">{opt}</button>
              ))}
            </div>
          )}
        </div>
      );
    }

    case "checkpoint": {
      const c = item as Extract<WorkItem, { kind: "checkpoint" }>;
      return (
        <div className="activity-block">
          <div className="activity-header" style={{ cursor: "default" }}>
            <span className="activity-icon" style={{ color: "var(--cf-accent)" }}>◉</span>
            <span className="activity-title">Checkpoint: {c.label}</span>
            <span className="activity-meta">{c.id.slice(0, 8)}</span>
          </div>
        </div>
      );
    }

    case "evidence": {
      const e = item as Extract<WorkItem, { kind: "evidence" }>;
      return (
        <div className="activity-block">
          <div className="activity-header" style={{ cursor: "default" }}>
            <span className="activity-icon" style={{ color: "var(--cf-success)" }}>◈</span>
            <span className="activity-title">Evidence: {e.conclusion}</span>
          </div>
        </div>
      );
    }

    case "artifact": {
      const a = item as Extract<WorkItem, { kind: "artifact" }>;
      return (
        <div className="activity-block">
          <div className="activity-header" style={{ cursor: "default" }}>
            <span className="activity-icon" style={{ color: "var(--cf-accent)" }}>◆</span>
            <span className="activity-title">{a.title}</span>
            <span className="activity-meta">{a.type}</span>
          </div>
        </div>
      );
    }

    case "agent": {
      const a = item as Extract<WorkItem, { kind: "agent" }>;
      return (
        <div className="agent-card">
          <span className={`agent-status-indicator ${a.status === "working" ? "working" : a.status === "failed" ? "failed" : "idle"}`} />
          <span className="agent-card-name">{a.role}</span>
          <span className="agent-card-status">{a.status}</span>
        </div>
      );
    }

    default:
      return null;
  }
};

export default function Conversation({ turns, workItems, displayMode, onSuggestedPrompt, contextLabel }: ConversationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 50;
    setShowJumpToLatest(!isNearBottom);
  };

  const scrollToBottom = () => {
    if (!containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 120;
    if (isNearBottom) {
      scrollToBottom();
    }
  }, [turns.length, workItems.length]);

  const renderTurn = (turn: TurnRecord) => (
    <div key={turn.id} className="user-message">
      <div className="user-message-label">You</div>
      <div className="user-message-body">{turn.userMessage}</div>
    </div>
  );

  const relevantItems = workItems.filter((w) => w.kind !== "context_ref");
  const isEmpty = turns.length === 0 && relevantItems.length === 0;

  return (
    <div
      className="conversation-scroll"
      ref={containerRef}
      onScroll={handleScroll}
      style={{ position: "relative" }}
    >
      <div className="conversation-inner">
        {isEmpty ? (
          <div className="empty-state">
            <div className="empty-state-title">What should we work on?</div>
            <div className="empty-state-subtitle">
              Describe a bug to fix, feature to build, or task to accomplish.
            </div>
            {contextLabel && <div className="empty-state-context">{contextLabel}</div>}
            <div className="suggested-prompts">
              {[
                "Explain this repository structure",
                "Create an implementation plan",
                "Review the current architecture",
                "Run the test suite and report results",
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="suggested-prompt"
                  onClick={() => onSuggestedPrompt?.(prompt)}
                  disabled={!onSuggestedPrompt}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {turns.map(renderTurn)}
            {relevantItems.map((item) => (
              <WorkItemRenderer key={item.id} item={item} displayMode={displayMode} />
            ))}
          </>
        )}
      </div>
      {showJumpToLatest && (
        <button
          type="button"
          className="jump-to-latest"
          onClick={scrollToBottom}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
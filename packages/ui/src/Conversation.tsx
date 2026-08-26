import React, { useState } from "react";
import type { TurnRecord, WorkItem } from "@codeforge/sessions";
import InlineComments from "./InlineComments.js";
import DiffViewer from "./DiffViewer.js";

interface ConversationProps {
  turns: TurnRecord[];
  workItems: WorkItem[];
  displayMode: string;
  onDisplayModeChange: (mode: "compact" | "detailed" | "debug") => void;
  isRunning: boolean;
}

function renderWorkItem(item: WorkItem, displayMode: string): React.ReactNode {
  const common = { key: item.id as React.Key, className: "work-item" };

  switch (item.kind) {
    case "activity": {
      const a = item as Extract<WorkItem, { kind: "activity" }>;
      return (
        <div {...common}>
          <div className="work-item-header">
            <span className="work-item-icon">{a.status === "completed" ? "✓" : a.status === "failed" ? "✕" : "●"}</span>
            <span className="work-item-title">{a.title}</span>
            <span className="work-item-meta">{a.durationMs ? `${a.durationMs}ms` : ""}</span>
          </div>
          {displayMode !== "compact" && a.detail && (
            <div className="work-item-body">{a.detail}</div>
          )}
          {displayMode === "debug" && a.expandedDetail && (
            <div className="work-item-body" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{a.expandedDetail}</div>
          )}
        </div>
      );
    }

    case "plan": {
      const p = item as Extract<WorkItem, { kind: "plan" }>;
      return (
        <div {...common}>
          <div className="work-item-header">
            <span className="work-item-icon">◫</span>
            <span className="work-item-title">{p.title}</span>
            <span className="plan-status">{p.status}</span>
          </div>
          <div className="plan-steps">
            {p.steps.map((step) => (
              <div key={step.id} className="plan-step">
                <span className="plan-step-icon">
                  {step.status === "completed" ? "✓" : step.status === "active" ? "●" : step.status === "failed" ? "✕" : "○"}
                </span>
                <span>{step.description}</span>
                <span className="plan-step-status">{step.status}</span>
              </div>
            ))}
          </div>
          {p.comments && p.comments.length > 0 && (
            <InlineComments
              comments={p.comments.map((c) => ({ id: c.id, author: c.author, text: c.text, createdAt: new Date().toISOString() }))}
              onAdd={(text: string) => { console.warn("Comment add not implemented:", text); }}
              onResolve={(id: string) => { console.warn("Comment resolve not implemented:", id); }}
              placeholder="Add a comment..."
            />
          )}
          <div className="work-item-actions">
            <button className="work-item-btn primary">Approve</button>
            <button className="work-item-btn">Comment</button>
            <button className="work-item-btn">Request Revision</button>
            <button className="work-item-btn">Edit</button>
            <button className="work-item-btn">Run Plan</button>
          </div>
        </div>
      );
    }

    case "command": {
      const c = item as Extract<WorkItem, { kind: "command" }>;
      return (
        <div {...common}>
          <div className="work-item-header">
            <span className="work-item-icon">⌘</span>
            <span className="work-item-title">{c.command}</span>
            <span className="work-item-meta">
              {c.status === "running" ? "Running" : c.status === "failed" ? `Failed (${c.exitCode})` : "Completed"}
            </span>
          </div>
          {c.workingDirectory && displayMode !== "compact" && (
            <div className="work-item-body" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
              Working directory: {c.workingDirectory}
            </div>
          )}
          {(c.output || displayMode === "debug") && (
            <div className="command-block">
              {c.output && (
                <div className="command-output" style={{ maxHeight: displayMode === "debug" ? "400px" : "120px", overflow: "auto" }}>
                  {c.output}
                </div>
              )}
            </div>
          )}
          {c.status === "failed" && (
            <div className="work-item-actions">
              <button className="work-item-btn">Retry</button>
              <button className="work-item-btn">Ask Agent to Fix</button>
            </div>
          )}
        </div>
      );
    }

    case "file_change": {
      const f = item as Extract<WorkItem, { kind: "file_change" }>;
      return (
        <div {...common}>
          <div className="work-item-header">
            <span className="work-item-icon">
              {f.changeType === "created" ? "+" : f.changeType === "deleted" ? "−" : "✎"}
            </span>
            <span className="work-item-title">{f.path}</span>
            <span className="work-item-meta">
              +{f.additions} -{f.deletions}
            </span>
          </div>
          {f.diff && <DiffViewer diff={f.diff} fileName={f.path} />}
          <div className="work-item-actions">
            <button className="work-item-btn">Open</button>
            <button className="work-item-btn">Comment</button>
            {f.changeType !== "created" && <button className="work-item-btn danger">Revert</button>}
          </div>
        </div>
      );
    }

    case "approval": {
      const a = item as Extract<WorkItem, { kind: "approval" }>;
      return (
        <div {...common} style={{ borderColor: "var(--warning)" }}>
          <div className="approval-card">
            <div className="approval-header">Approval Required</div>
            <div className="approval-body">
              <strong>Run:</strong> <code>{a.action}</code>
              <br />
              {a.description}
              {a.scope && <><br /><strong>Scope:</strong> {a.scope}</>}
            </div>
            <div className="work-item-actions">
              <button className="work-item-btn primary">Allow Once</button>
              <button className="work-item-btn">Allow for Session</button>
              <button className="work-item-btn danger">Deny</button>
            </div>
          </div>
        </div>
      );
    }

    case "question": {
      const q = item as Extract<WorkItem, { kind: "question" }>;
      return (
        <div {...common} style={{ borderColor: "var(--accent)" }}>
          <div className="question-card">
            <div className="question-header">Agent Question</div>
            <div className="question-body">{q.prompt}</div>
            {q.options && q.options.length > 0 && (
              <div className="question-options">
                {q.options.map((opt) => (
                  <button key={opt} className="work-item-btn primary">{opt}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    case "artifact": {
      const a = item as Extract<WorkItem, { kind: "artifact" }>;
      return (
        <div {...common}>
          <div className="artifact-card">
            <div className="artifact-type">{a.type}</div>
            <div className="artifact-title">{a.title}</div>
          </div>
          <div className="work-item-actions">
            <button className="work-item-btn">Open</button>
            <button className="work-item-btn">Comment</button>
            <button className="work-item-btn">Approve</button>
            <button className="work-item-btn">Request Revision</button>
            <button className="work-item-btn">Compare</button>
            <button className="work-item-btn">Export</button>
          </div>
        </div>
      );
    }

    case "test_run": {
      const t = item as Extract<WorkItem, { kind: "test_run" }>;
      return (
        <div {...common}>
          <div className="work-item-header">
            <span className="work-item-icon">◫</span>
            <span className="work-item-title">{t.name}</span>
          </div>
          <div className="test-summary">
            <div className="test-card">
              <div className="test-card-title">Passed</div>
              <div className="test-card-value pass">{t.passed}</div>
            </div>
            <div className="test-card">
              <div className="test-card-title">Failed</div>
              <div className="test-card-value fail">{t.failed}</div>
            </div>
          </div>
          {t.failures && t.failures.length > 0 && displayMode !== "compact" && (
            <div style={{ marginTop: 10 }}>
              {t.failures.map((f, i) => (
                <div key={i} style={{ fontSize: 11, color: "var(--danger)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>
                  {f.test}: {f.message}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    case "agent": {
      const a = item as Extract<WorkItem, { kind: "agent" }>;
      return (
        <div {...common}>
          <div className="agent-card">
            <div className={`agent-status-indicator ${a.status}`} />
            <div className="agent-card-name">{a.role}</div>
            <div className="agent-card-status">{a.status}</div>
            {a.progress !== undefined && (
              <div className="agent-card-progress">
                <div className="agent-card-progress-fill" style={{ width: `${a.progress}%` }} />
              </div>
            )}
          </div>
          <div className="work-item-body" style={{ marginTop: 6, fontSize: 11 }}>{a.task}</div>
        </div>
      );
    }

    case "checkpoint": {
      const c = item as Extract<WorkItem, { kind: "checkpoint" }>;
      return (
        <div {...common}>
          <div className="checkpoint-card">
            <div className="checkpoint-id">{c.id.slice(0, 8)}</div>
            <div className="checkpoint-label">{c.label}</div>
            <div className="checkpoint-meta">
              {c.fileCount} files {c.testStatus && `· ${c.testStatus}`} {c.branch && `· ${c.branch}`}
            </div>
          </div>
          <div className="work-item-actions">
            <button className="work-item-btn">Restore Code + Conversation</button>
            <button className="work-item-btn">Restore Conversation Only</button>
            <button className="work-item-btn">Fork Session</button>
            <button className="work-item-btn">Compare</button>
          </div>
        </div>
      );
    }

    case "evidence": {
      const e = item as Extract<WorkItem, { kind: "evidence" }>;
      return (
        <div {...common}>
          <div className="evidence-item">
            <div className="evidence-conclusion">{e.conclusion}</div>
            <div className="evidence-refs">
              {e.references.map((ref, i) => (
                <div key={i} className="evidence-ref">[{ref.kind}] {ref.ref}</div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    case "context_ref": {
      const c = item as Extract<WorkItem, { kind: "context_ref" }>;
      return (
        <div {...common}>
          <div className="context-item">
            <span className="context-item-icon">{c.refType === "file" ? "📄" : c.refType === "folder" ? "📁" : "◉"}</span>
            <span className="context-item-path">{c.ref}</span>
          </div>
        </div>
      );
    }

    default:
      return <div {...common}>Unknown work item: {(item as WorkItem).kind as string}</div>;
  }
}

export default function Conversation({ turns, workItems, displayMode, onDisplayModeChange, isRunning }: ConversationProps) {
  const renderTurn = (turn: TurnRecord) => (
    <div key={turn.id}>
      <div className="user-message">
        <div className="user-message-header">User</div>
        <div className="user-message-body">{turn.userMessage}</div>
      </div>
    </div>
  );

  const relevantItems = workItems.filter((w) => w.kind !== "context_ref");

  return (
    <main className="workspace-conversation">
      <div className="workspace-conversation-scroll scrollbar-thin">
        {turns.length === 0 && workItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◫</div>
            <div className="empty-state-title">No active session</div>
            <div className="empty-state-body">Start a coding task to see structured agent activity here.</div>
            <div className="suggested-prompts">
              <button className="suggested-prompt">Explore this repository</button>
              <button className="suggested-prompt">Create an implementation plan</button>
              <button className="suggested-prompt">Review the current architecture</button>
              <button className="suggested-prompt">Run the test suite</button>
            </div>
          </div>
        ) : (
          <>
            {turns.map(renderTurn)}
            {relevantItems.map((item, _index) => renderWorkItem(item, displayMode))}
          </>
        )}
      </div>
    </main>
  );
}

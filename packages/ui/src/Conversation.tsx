import React, { useState, useRef, useEffect, useMemo } from "react";
import type { TurnRecord, WorkItem } from "@codeforge/sessions";
import type { WorkspaceEvent } from "@codeforge/protocol";
import InlineComments from "./InlineComments.js";
import DiffViewer from "./DiffViewer.js";
import { buildTimeline, type TimelineItem } from "./timeline.js";
import { parseAssistantContent, parseInlineSpans, reasoningSummary } from "./assistant-content.js";
import { describeToolTarget, summarizeToolResult, hasToolDetail } from "./tool-activity.js";

interface ConversationProps {
  turns: TurnRecord[];
  workItems: WorkItem[];
  displayMode: string;
  /** Session event stream — the authoritative source for interleaved user/assistant/tool prose. */
  events?: WorkspaceEvent[];
  onDisplayModeChange?: (mode: "compact" | "detailed" | "debug") => void;
  isRunning?: boolean;
  /** Sends a starter prompt when the user clicks a suggestion in the empty state. */
  onSuggestedPrompt?: (text: string) => void;
  /** Short context label shown under the empty-state heading, e.g. "CodeForge · main". */
  contextLabel?: string;
}

/** Inline `code` and **strong** within a prose paragraph. */
const InlineProse = ({ text }: { text: string }) => (
  <>
    {parseInlineSpans(text).map((s, i) =>
      s.kind === "code" ? (
        <code key={i} className="assistant-inline-code">{s.text}</code>
      ) : s.kind === "strong" ? (
        <strong key={i}>{s.text}</strong>
      ) : (
        <span key={i}>{s.text}</span>
      ),
    )}
  </>
);

/**
 * Assistant prose, given the structure it actually has: reasoning folded away behind a summary,
 * code as code, and the answer itself in plain sight. Reasoning starts collapsed because it is the
 * model's working, not its reply — available on demand, never competing with the answer.
 */
const AssistantProse = ({ text }: { text: string }) => {
  const blocks = parseAssistantContent(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "reasoning") return <ReasoningBlock key={i} text={b.text} open={b.open} />;
        if (b.kind === "code") {
          return (
            <div key={i} className="assistant-code">
              <div className="assistant-code-head">
                <span className="assistant-code-lang">{b.language ?? "code"}</span>
              </div>
              <pre className="assistant-code-body"><code>{b.code}</code></pre>
            </div>
          );
        }
        return (
          <p key={i} className="assistant-paragraph">
            <InlineProse text={b.text} />
          </p>
        );
      })}
    </>
  );
};

const ReasoningBlock = ({ text, open }: { text: string; open: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`assistant-reasoning${open ? " streaming" : ""}`}>
      <button type="button" className="assistant-reasoning-toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className="assistant-reasoning-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span>{reasoningSummary(text, open)}</span>
      </button>
      {expanded && <div className="assistant-reasoning-body">{text}</div>}
    </div>
  );
};

/**
 * One line of tool activity: what ran, what it ran on, and what came back — the three things a
 * user needs to follow the agent's work. Running calls animate; finished calls carry their result
 * inline and expand to the full output only on request, so a long transcript stays scannable.
 */
const ToolActivity = ({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) => {
  const [expanded, setExpanded] = useState(false);
  const running = item.status === "running";
  const bad = item.status === "failed" || item.status === "blocked";
  const iconClass = item.status === "completed" ? "success" : bad ? "error" : "running";
  const iconChar = item.status === "completed" ? "✓" : bad ? "✕" : "●";

  const target = describeToolTarget(item.toolName, item.argsJson);
  const summary = summarizeToolResult(item);
  const detail = item.error ?? item.result;
  const expandable = hasToolDetail(item);

  return (
    <div className={`activity-block${running ? " running" : ""}`}>
      <div
        className="activity-header"
        style={{ cursor: expandable ? "pointer" : "default" }}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      >
        <span className={`activity-icon ${iconClass}`}>{iconChar}</span>
        <span className="activity-title">
          {toolLabel(item.toolName)}
          {target && <span className="activity-target">{target}</span>}
        </span>
        {summary && <span className={`activity-meta${bad ? " error" : ""}`}>{summary}</span>}
        {running && <span className="activity-meta">running…</span>}
        {expandable && <span className="activity-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
      </div>
      {expanded && detail && <pre className="activity-detail">{detail}</pre>}
    </div>
  );
};

/** Renders one reconstructed timeline item: user prompt, assistant prose, or tool activity. */
const TimelineItemView = ({ item }: { item: TimelineItem }) => {
  switch (item.kind) {
    case "user":
      return (
        <div className="user-message">
          <div className="user-message-label">You</div>
          <div className="user-message-body">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="assistant-message">
          <div className="assistant-message-label">CodeForge</div>
          <div className="assistant-message-body">
            <AssistantProse text={item.text} />
            {item.streaming && <span className="assistant-cursor" aria-hidden="true">▍</span>}
          </div>
        </div>
      );
    case "tool":
      return <ToolActivity item={item} />;
    case "file":
      return (
        <div className="activity-block">
          <div className="activity-header" style={{ cursor: "default" }}>
            <span className={`activity-icon ${item.action === "written" ? "success" : "running"}`}>{item.action === "written" ? "✎" : "◇"}</span>
            <span className="activity-title">{item.action === "written" ? "Wrote" : "Read"} {item.path}</span>
            {item.detail && <span className="activity-meta">{item.detail}</span>}
          </div>
        </div>
      );
    case "command":
      return (
        <div className="activity-block">
          <div className="activity-header" style={{ cursor: "default" }}>
            <span className={`activity-icon ${item.exitCode === 0 ? "success" : "error"}`}>{item.exitCode === 0 ? "✓" : "✕"}</span>
            <span className="activity-title">Ran {item.command}</span>
            <span className="activity-meta">exit {item.exitCode}</span>
          </div>
        </div>
      );
    default:
      return null;
  }
};

function toolLabel(toolName: string): string {
  const map: Record<string, string> = {
    read_file: "Read file",
    write_file: "Wrote file",
    edit_file: "Edited file",
    run_command: "Ran command",
    search: "Searched",
    list_files: "Listed files",
  };
  return map[toolName] ?? toolName;
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

export default function Conversation({ turns, workItems, displayMode, events, onSuggestedPrompt, contextLabel }: ConversationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const timeline = useMemo(() => buildTimeline(events ?? []), [events]);

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
  }, [turns.length, workItems.length, timeline.length, events?.length]);

  const renderTurn = (turn: TurnRecord) => (
    <div key={turn.id} className="user-message">
      <div className="user-message-label">You</div>
      <div className="user-message-body">{turn.userMessage}</div>
    </div>
  );

  const relevantItems = workItems.filter((w) => w.kind !== "context_ref");
  const isEmpty = timeline.length === 0 && turns.length === 0 && relevantItems.length === 0;
  // Prefer the event-sourced timeline (correct chronological interleaving of user prompts,
  // assistant prose, and tool activity). Fall back to turns+workItems only when no events exist.
  const useTimeline = timeline.length > 0;

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
        ) : useTimeline ? (
          <>
            {timeline.map((item) => (
              <TimelineItemView key={item.id} item={item} />
            ))}
            {relevantItems
              .filter((w) => w.kind === "approval" || w.kind === "question")
              .map((item) => (
                <WorkItemRenderer key={item.id} item={item} displayMode={displayMode} />
              ))}
          </>
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
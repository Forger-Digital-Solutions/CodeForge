import React, { useState, useRef, useEffect, useMemo } from "react";
import type { TurnRecord, WorkItem } from "@codeforge/sessions";
import type { WorkspaceEvent } from "@codeforge/protocol";
import InlineComments from "./InlineComments.js";
import DiffViewer from "./DiffViewer.js";
import { buildTimeline, type TimelineItem } from "./timeline.js";
import { parseAssistantContent, parseInlineSpans, reasoningSummary } from "./assistant-content.js";
import { describeToolTarget, summarizeToolResult, hasToolDetail } from "./tool-activity.js";
import { ActivityIcon, activityLabel, resolveActivityKind, type ActivityKind, type ActivityState } from "./activity-icons.js";
import { EightBitStatusBadge } from "./EightBitStatusBadge.js";
import { deriveLatestEightBitStatus } from "./eight-bit-status.js";
import { resolveAssetUrlByName } from "./emoji-assets.js";

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

function splitActivityTarget(value?: string): { primary?: string; context?: string } {
  if (!value) return {};
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return { primary: value };
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) return { primary: value };
  return { primary: normalized.slice(slash + 1), context: normalized.slice(0, slash) };
}

interface ActivityLineProps {
  kind: ActivityKind;
  state?: ActivityState;
  filePath?: string;
  verb: string;
  target?: string;
  context?: string;
  meta?: React.ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}

/** The compact transcript primitive: icon, verb, target, context, and metadata share one baseline. */
const ActivityLine = ({ kind, state = "static", filePath, verb, target, context, meta, expandable, expanded, onToggle, children }: ActivityLineProps) => {
  const targetParts = splitActivityTarget(target);
  const content = (
    <>
      <ActivityIcon kind={kind} state={state} filePath={filePath} />
      <span className="activity-verb">{verb}</span>
      {targetParts.primary && <span className="activity-target">{targetParts.primary}</span>}
      {(context || targetParts.context) && <span className="activity-context">{context ?? targetParts.context}</span>}
      {meta && <span className="activity-meta">{meta}</span>}
      {expandable && <span className="activity-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
    </>
  );
  return (
    <div className={`activity-block${state === "active" ? " running" : ""}`}>
      {expandable ? (
        <button type="button" className="activity-header" onClick={onToggle} aria-expanded={expanded}>
          {content}
        </button>
      ) : (
        <div className="activity-header">{content}</div>
      )}
      {children}
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
  const activityState: ActivityState = item.status === "completed" ? "completed" : item.status === "blocked" ? "blocked" : bad ? "failed" : "active";
  const activityKind = resolveActivityKind(item.toolName);

  const target = describeToolTarget(item.toolName, item.argsJson);
  const summary = summarizeToolResult(item);
  const detail = item.error ?? item.result;
  const expandable = hasToolDetail(item);

  return (
    <ActivityLine
      kind={bad ? "error" : activityKind}
      state={activityState}
      verb={activityLabel(activityKind)}
      target={target}
      meta={<>{summary && <span className={bad ? "activity-meta-error" : undefined}>{summary}</span>}{running && <span>Working</span>}</>}
      expandable={expandable}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && detail && <pre className="activity-detail">{detail}</pre>}
    </ActivityLine>
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
        <ActivityLine
          kind={item.action === "written" ? "edit" : "read"}
          state="completed"
          filePath={item.path}
          verb={item.action === "written" ? "Write" : "Read"}
          target={item.path}
          meta={item.detail}
        />
      );
    case "command":
      return (
        <ActivityLine
          kind={item.exitCode === 0 ? "success" : "error"}
          state={item.exitCode === 0 ? "completed" : "failed"}
          verb="Run"
          target={item.command}
          meta={`exit ${item.exitCode}`}
        />
      );
    default:
      return null;
  }
};

const WorkItemRenderer = ({ item, displayMode }: { item: WorkItem; displayMode: string }) => {
  const [isCollapsed, setIsCollapsed] = useState(true);

  const toggle = () => setIsCollapsed(!isCollapsed);

  switch (item.kind) {
    case "activity": {
      const a = item as Extract<WorkItem, { kind: "activity" }>;
      const iconState: ActivityState = a.status === "completed" ? "completed" : a.status === "failed" ? "failed" : "active";
      return (
        <ActivityLine
          kind="generic"
          state={iconState}
          verb={activityLabel("generic")}
          target={a.title}
          meta={a.durationMs ? <span className="activity-elapsed">{a.durationMs}ms</span> : undefined}
          expandable
          expanded={!isCollapsed}
          onToggle={toggle}
        >
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
        </ActivityLine>
      );
    }

    case "command": {
      const c = item as Extract<WorkItem, { kind: "command" }>;
      const isRunning = c.status === "running";
      const isFailed = c.status === "failed";
      return (
        <ActivityLine
          kind={isFailed ? "error" : isRunning ? "execute" : "success"}
          state={isFailed ? "failed" : isRunning ? "active" : "completed"}
          verb="Run"
          target={c.command}
          meta={<>
              {isRunning ? "Running" : isFailed ? `Exit ${c.exitCode ?? 1}` : "Passed"}
              {c.durationMs ? <span className="activity-elapsed"> · {c.durationMs}ms</span> : null}
            </>}
          expandable
          expanded={!isCollapsed}
          onToggle={toggle}
        >
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
        </ActivityLine>
      );
    }

    case "file_change": {
      const f = item as Extract<WorkItem, { kind: "file_change" }>;
      const fileVerb = f.changeType === "created" ? "Create" : f.changeType === "deleted" ? "Delete" : "Edit";
      return (
        <ActivityLine
          kind={f.changeType === "created" ? "create" : f.changeType === "deleted" ? "delete" : "edit"}
          state={f.changeType === "deleted" ? "failed" : "completed"}
          filePath={f.path}
          verb={fileVerb}
          target={f.path}
          meta={<span className="activity-diff-stats">
              <span className="activity-stat activity-stat-additions">+{f.additions}</span>{" "}
              <span className="activity-stat activity-stat-deletions">−{f.deletions}</span>
            </span>}
          expandable
          expanded={!isCollapsed}
          onToggle={toggle}
        >
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
        </ActivityLine>
      );
    }

    case "test_run": {
      const t = item as Extract<WorkItem, { kind: "test_run" }>;
      const isFailed = t.failed > 0;
      return (
        <ActivityLine
          kind={isFailed ? "error" : "test"}
          state={isFailed ? "failed" : "completed"}
          verb="Test"
          target={t.name || "Test Suite"}
          meta={`${t.passed} passed${t.failed > 0 ? ` · ${t.failed} failed` : ""}`}
          expandable
          expanded={!isCollapsed}
          onToggle={toggle}
        >
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
        </ActivityLine>
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
      // This is the transcript's RECORD of an approval, not a second place to make the decision.
      // It previously rendered Allow/Deny buttons with no handlers attached — a control that looked
      // live, did nothing when pressed, and gave no hint why. The live decision has exactly one
      // home (ApprovalBar); here we show only what was asked and what was decided.
      const outcome = a.decision
        ? a.decision === "deny"
          ? { label: "Denied", kind: "error" as const, state: "failed" as const }
          : { label: a.decision === "allow_session" ? "Allowed for session" : "Allowed", kind: "complete" as const, state: "completed" as const }
        : { label: "Awaiting your decision", kind: "approval" as const, state: "pending" as const };
      return (
        <ActivityLine kind={outcome.kind} state={outcome.state} verb="Approval" target={a.tool} context={a.action} meta={outcome.label}>
          <div className="activity-body">
            {a.description}
            {a.scope && (
              <>
                <br />
                <span className="approval-record-scope">Scope: <code>{a.scope}</code></span>
              </>
            )}
          </div>
        </ActivityLine>
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
        <ActivityLine kind="git" state="completed" verb="Checkpoint" target={c.label} meta={c.id.slice(0, 8)} />
      );
    }

    case "evidence": {
      const e = item as Extract<WorkItem, { kind: "evidence" }>;
      return (
        <ActivityLine kind="verify" state="completed" verb="Evidence" target={e.conclusion} />
      );
    }

    case "artifact": {
      const a = item as Extract<WorkItem, { kind: "artifact" }>;
      return (
        <ActivityLine kind="create" state="completed" verb="Artifact" target={a.title} meta={a.type} />
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
  // 8-Bit is presentation-only here: it renders whatever the backend's last `eightbit.status`
  // event says, never influences routing/health/eligibility. See eight-bit-status.ts.
  const eightBitStatus = useMemo(() => deriveLatestEightBitStatus(events), [events]);

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
            <img className="empty-state-mark" src={resolveAssetUrlByName("8bit-idle")} width={32} height={32} alt="" aria-hidden="true" draggable={false} />
            <div className="empty-state-title">What are we forging?</div>
            <div className="empty-state-subtitle">
              Describe a task or ask about your code.
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
        {!isEmpty && eightBitStatus && (
          <div className="eight-bit-status-row">
            <EightBitStatusBadge status={eightBitStatus} />
          </div>
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

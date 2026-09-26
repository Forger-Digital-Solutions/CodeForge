import { splitMessageAttachments } from "@codeforge/protocol";
import React, { useState, useRef, useEffect, useMemo } from "react";
import type { TurnRecord, WorkItem } from "@codeforge/sessions";
import type { WorkspaceEvent } from "@codeforge/protocol";
import InlineComments from "./InlineComments.js";
import DiffViewer from "./DiffViewer.js";
import { buildTimeline, type TimelineItem } from "./timeline.js";
import { parseAssistantContent, parseInlineSpans, reasoningSummary } from "./assistant-content.js";
import { describeToolTarget, summarizeToolResult, hasToolDetail, relativeToWorkspace, formatElapsed } from "./tool-activity.js";
import { ActivityIcon, activityLabel, resolveActivityKind, type ActivityKind, type ActivityState } from "./activity-icons.js";
import { EightBitStatusBadge } from "./EightBitStatusBadge.js";
import { deriveLatestEightBitStatus } from "./eight-bit-status.js";
import { resolveAssetUrlByName } from "./emoji-assets.js";
import { stripToolProtocol } from "./assistant-content.js";
import { ActivityOverview, type ActivityOverviewData, type ActivityPeriod } from "./ActivityOverview.js";
import type { ModelSelectorItem } from "./ModelSelector.js";

/** Actual repository facts supplied by the desktop host for the idle workspace. */
export interface WorkspaceBriefData {
  repositoryName: string;
  branch?: string | null;
  repositoryState: "clean" | "changes" | "unavailable";
  indexState?: string;
  indexedFiles?: number;
  indexedSymbols?: number;
  isWorktree?: boolean;
}

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
  /** Workspace root; tool rows render paths relative to it. */
  workspacePath?: string;
  /** Real signed-in display name for the greeting; omit/undefined falls back to a neutral greeting. */
  userDisplayName?: string;
  activityOverview?: ActivityOverviewData | null;
  isActivityLoading?: boolean;
  activityPeriod?: ActivityPeriod;
  onActivityPeriodChange?: (period: ActivityPeriod) => void;
  resolveModelDisplayName?: (modelId: string) => string;
  /** Real favorited models (from the same source ModelSelector's star toggle writes to). */
  favoriteModels?: ModelSelectorItem[];
  onSelectModel?: (model: ModelSelectorItem) => void;
  /** Opens the canonical model picker — the empty state never renders a second, separate picker. */
  onOpenModelPicker?: () => void;
  workspaceBrief?: WorkspaceBriefData;
}

type ToolTimelineItem = Extract<TimelineItem, { kind: "tool" }>;
type FileTimelineItem = Extract<TimelineItem, { kind: "file" }>;
type CommandTimelineItem = Extract<TimelineItem, { kind: "command" }>;
type AssistantTimelineItem = Extract<TimelineItem, { kind: "assistant" }>;
/** The activity rows a group can fold: completed work that doesn't need attention by itself. */
type GroupableTimelineItem = ToolTimelineItem | FileTimelineItem | CommandTimelineItem;

type DisplayTimelineItem = TimelineItem | {
  kind: "tool_group";
  id: string;
  seq: number;
  /** Dominant kind when members are mixed; drives the row's icon. */
  activityKind: ActivityKind;
  /** True when members span more than one activity kind — the header reads "steps", not a single verb's noun. */
  mixed: boolean;
  /** Ordered children: the grouped activity plus any narration it bridged. */
  items: Array<GroupableTimelineItem | AssistantTimelineItem>;
};

/** Short step-narration between same-kind calls belongs inside the group, not as a peer row. */
const GROUP_BRIDGE_MAX_CHARS = 160;

function isBridgingMessage(item: TimelineItem | undefined, turnId: string): item is AssistantTimelineItem {
  if (item?.kind !== "assistant" || item.streaming || item.turnId !== turnId) return false;
  const text = item.text.trim();
  // A question is a real turn in the conversation; a one-line "now checking X" is not.
  return text.length > 0 && text.length <= GROUP_BRIDGE_MAX_CHARS && !text.endsWith("?");
}

/** The activity kind a groupable row contributes to a group's shape; undefined if not groupable. */
function groupableKind(item: TimelineItem): ActivityKind | undefined {
  if (item.kind === "tool") return item.status === "completed" ? resolveActivityKind(item.toolName) : undefined;
  // Reverted changes and failed runs are attention, not routine — they never fold into a group.
  if (item.kind === "file") {
    if (item.action === "reverted") return undefined;
    const kinds: Record<string, ActivityKind> = { read: "read", written: "edit", created: "create", modified: "edit", deleted: "delete" };
    return kinds[item.action];
  }
  if (item.kind === "command") return item.status === "completed" ? "execute" : undefined;
  return undefined;
}

/**
 * Collapse adjacent completed activity into one expandable row. Same-kind runs (read×4) fold
 * into "Explored · 4 files"; mixed work sequences (read → edit → test → read) fold into
 * "Worked · 5 steps" with a per-kind breakdown as metadata. A short narration message inside a
 * run folds into the group too. Failed, blocked, reverted and still-running items stay explicit:
 * a summary must never hide something that needs attention.
 */
export function groupConsecutiveToolActivity(items: TimelineItem[]): DisplayTimelineItem[] {
  const grouped: DisplayTimelineItem[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index]!;
    const firstKind = groupableKind(item);
    if (firstKind === undefined) {
      grouped.push(item);
      index++;
      continue;
    }
    const turnId = item.turnId;
    const members: Array<GroupableTimelineItem | AssistantTimelineItem> = [item as GroupableTimelineItem];
    const kinds = [firstKind];
    let cursor = index + 1;
    while (cursor < items.length) {
      const candidate = items[cursor]!;
      const candidateKind = groupableKind(candidate);
      if (candidateKind !== undefined) {
        members.push(candidate as GroupableTimelineItem);
        kinds.push(candidateKind);
        cursor++;
        continue;
      }
      // Bridge a brief narrating message only when more work resumes right after it.
      const next = items[cursor + 1];
      if (turnId && isBridgingMessage(candidate, turnId) && next && groupableKind(next) !== undefined) {
        members.push(candidate);
        members.push(next as GroupableTimelineItem);
        kinds.push(groupableKind(next)!);
        cursor += 2;
        continue;
      }
      break;
    }
    const distinct = new Set(kinds);
    const shouldGroup = members.length > 1 && kinds.length >= 2 && (distinct.size === 1 ? kinds.length >= 2 : kinds.length >= 3);
    if (!shouldGroup) {
      grouped.push(members[0]!);
      index++;
      continue;
    }
    const counts = new Map<ActivityKind, number>();
    for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    let dominant = kinds[0]!;
    for (const [kind, count] of counts) if (count > (counts.get(dominant) ?? 0)) dominant = kind;
    grouped.push({
      kind: "tool_group", id: `tool-group-${item.id}`, seq: item.seq,
      activityKind: dominant, mixed: distinct.size > 1, items: members,
    });
    index = cursor;
  }
  return grouped;
}

function WorkspaceBrief({ brief }: { brief: WorkspaceBriefData }): React.ReactElement {
  const repositoryState = brief.repositoryState === "clean"
    ? "Clean working tree"
    : brief.repositoryState === "changes" ? "Changes detected" : "Git status unavailable";
  const indexSummary = brief.indexedFiles === undefined
    ? brief.indexState
    : `${brief.indexedFiles.toLocaleString()} files${brief.indexedSymbols === undefined ? "" : ` · ${brief.indexedSymbols.toLocaleString()} symbols`}`;
  return (
    <section className="workspace-brief" aria-label="Selected workspace">
      <div className="workspace-brief-header">
        <span className="workspace-brief-kicker">Selected workspace</span>
        <span className={`workspace-brief-state ${brief.repositoryState}`}>{repositoryState}</span>
      </div>
      <div className="workspace-brief-name">{brief.repositoryName}</div>
      <dl className="workspace-brief-details">
        <div><dt>Branch</dt><dd>{brief.branch ?? "Detached HEAD"}{brief.isWorktree ? " · worktree" : ""}</dd></div>
        {indexSummary && <div><dt>Repository intelligence</dt><dd>{indexSummary}</dd></div>}
      </dl>
    </section>
  );
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
      <ActivityIcon kind={kind} state={state} filePath={filePath} size={16} />
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
const ToolActivity = ({ item, workspacePath, taskTerminal }: { item: ToolTimelineItem; workspacePath?: string; taskTerminal?: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  // Duplicate suppression is a healthy no-op, not an error — muted copy, neutral icon.
  const suppressed = item.status === "blocked" && (item.error ?? "").startsWith("forgegreen_duplicate");
  // A call still marked running after the run ended can never finish — say so instead of
  // leaving "Working" frozen beside a terminal outcome.
  const stalled = item.status === "running" && taskTerminal;
  const running = item.status === "running" && !stalled;
  const failed = item.status === "failed";
  const blocked = item.status === "blocked" && !suppressed;
  const activityState: ActivityState = suppressed || stalled ? "static" : failed ? "failed" : blocked ? "blocked" : running ? "active" : "completed";
  const activityKind = resolveActivityKind(item.toolName);

  const target = describeToolTarget(item.toolName, item.argsJson, workspacePath);
  // A file operation's own report ("28 lines", "written") beats a line count of the tool's raw
  // output, which includes framing the user never asked about.
  const summary = suppressed ? "Skipped — duplicate of an unchanged read"
    : stalled ? "Cancelled — the run ended first"
    : item.fileDetail ?? summarizeToolResult(item);
  const detail = item.error ?? item.result;
  const expandable = hasToolDetail(item);
  const metaClass = failed ? "activity-meta-error" : blocked ? "activity-meta-warning" : suppressed || stalled ? "activity-meta-muted" : undefined;

  return (
    <ActivityLine
      kind={failed ? "error" : activityKind}
      state={activityState}
      verb={activityLabel(activityKind)}
      target={target}
      meta={<>{summary && <span className={metaClass}>{summary}</span>}{running && <span>Working</span>}</>}
      expandable={expandable}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && detail && <pre className="activity-detail">{detail}</pre>}
    </ActivityLine>
  );
};

/** Group header verbs read as what the agent did, not the tool primitive it used. */
const GROUP_VERBS: Partial<Record<ActivityKind, string>> = {
  read: "Explored",
  search: "Searched",
  edit: "Edited",
  create: "Created",
  fetch: "Fetched",
  test: "Tested",
  verify: "Verified",
  plan: "Planned",
  execute: "Ran",
  git: "Git",
};

const GROUP_NOUNS: Partial<Record<ActivityKind, [string, string]>> = {
  read: ["file", "files"],
  search: ["search", "searches"],
  edit: ["file", "files"],
  create: ["file", "files"],
  fetch: ["request", "requests"],
  execute: ["command", "commands"],
  browser: ["page", "pages"],
};

const GROUP_BREAKDOWN_NOUN: Partial<Record<ActivityKind, [string, string]>> = {
  read: ["read", "reads"],
  search: ["search", "searches"],
  edit: ["edit", "edits"],
  create: ["file", "files"],
  delete: ["delete", "deletes"],
  execute: ["command", "commands"],
  fetch: ["fetch", "fetches"],
  browser: ["page", "pages"],
  test: ["test", "tests"],
  verify: ["check", "checks"],
  build: ["build", "builds"],
  git: ["git op", "git ops"],
};

const ToolGroupActivity = ({ item, workspacePath, taskTerminal }: { item: Extract<DisplayTimelineItem, { kind: "tool_group" }>; workspacePath?: string; taskTerminal?: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const groupable = item.items.filter((child): child is GroupableTimelineItem => child.kind !== "assistant");
  const stepCount = groupable.length;
  const [singular, plural] = GROUP_NOUNS[item.activityKind] ?? ["operation", "operations"];
  const target = item.mixed
    ? `${stepCount} steps`
    : `${stepCount} ${stepCount === 1 ? singular : plural}`;
  // Mixed work gets a compact breakdown ("2 reads · 1 edit"); same-kind groups just say Completed.
  const breakdown = item.mixed
    ? [...groupable.reduce((acc, child) => {
        const kind = groupableKind(child as TimelineItem) ?? "tool";
        acc.set(kind, (acc.get(kind) ?? 0) + 1);
        return acc;
      }, new Map<ActivityKind, number>()).entries()]
        .slice(0, 3)
        .map(([kind, count]) => `${count} ${(GROUP_BREAKDOWN_NOUN[kind] ?? ["step", "steps"])[count === 1 ? 0 : 1]}`)
        .join(" · ")
    : "Completed";
  // Elapsed comes from real event timestamps; only shown when the span is meaningful.
  const first = groupable[0];
  const last = groupable[groupable.length - 1];
  const elapsedMs = first && last ? Date.parse(last.ts) - Date.parse(first.ts) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : undefined;
  return (
    <ActivityLine
      kind={item.activityKind}
      state="completed"
      verb={item.mixed ? "Worked" : GROUP_VERBS[item.activityKind] ?? activityLabel(item.activityKind)}
      target={target}
      meta={<>{breakdown}{elapsed && <span className="activity-elapsed"> · {elapsed}</span>}</>}
      expandable
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {expanded && (
        <div className="activity-group-detail">
          {item.items.map((child) => {
            if (child.kind === "tool") return <ToolActivity key={child.id} item={child} workspacePath={workspacePath} taskTerminal={taskTerminal} />;
            if (child.kind === "command") return <CommandActivity key={child.id} item={child} taskTerminal={taskTerminal} />;
            if (child.kind === "file") {
              const present = FILE_ACTION_PRESENT[child.action];
              return <FileActivity key={child.id} item={child} workspacePath={workspacePath} kind={present.kind} verb={present.verb} hasDiff={Boolean(child.diff)} />;
            }
            return <div key={child.id} className="activity-group-note">{child.text}</div>;
          })}
        </div>
      )}
    </ActivityLine>
  );
};

const CommandActivity = ({ item, taskTerminal }: { item: Extract<TimelineItem, { kind: "command" }>; taskTerminal?: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const running = item.status === "running";
  // A command still marked running after the run ended was interrupted — never "Passed".
  const stalled = running && taskTerminal;
  const passed = item.status === "completed";
  const failed = item.status === "failed";
  const result = stalled
    ? "Cancelled — the run ended first"
    : running ? "Running" : passed ? "Passed" : `Failed · exit ${item.exitCode ?? "?"}`;
  const duration = item.durationMs !== undefined ? formatElapsed(item.durationMs) : undefined;
  const expandable = Boolean(item.output) || running;
  const head = (
    <>
      <ActivityIcon kind={failed || stalled ? "error" : "execute"} state={failed || stalled ? "failed" : running ? "active" : "completed"} size={16} />
      <span className="command-activity-copy">
        <span className="command-activity-label">Run command</span>
        <code className="command-activity-command">{item.command}</code>
      </span>
      <span className={`command-activity-result ${failed || stalled ? "failed" : running ? "running" : "passed"}`}>
        {result}{duration ? ` · ${duration}` : ""}
      </span>
      {expandable && <span className="activity-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
    </>
  );
  return (
    <div className={`command-activity ${failed ? "failed" : running ? "running" : "passed"}`}>
      {expandable ? (
        <button type="button" className="command-activity-head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {head}
        </button>
      ) : (
        <div className="command-activity-head">{head}</div>
      )}
      {expanded && (
        <div className="command-activity-detail">
          <div className="command-activity-prompt">{item.workingDirectory ? `${item.workingDirectory} ` : ""}$ {item.command}</div>
          {item.output ? <pre>{item.output}</pre> : <div className="command-activity-empty">{running ? "No output yet." : "No command output was recorded."}</div>}
          {item.exitCode !== undefined && <div className="command-activity-exit">Exit code {item.exitCode}</div>}
        </div>
      )}
    </div>
  );
};

/** The user's own words, with any attached files folded back into collapsible chips. */
const UserMessage = ({ text }: { text: string }) => {
  const { text: body, attachments } = splitMessageAttachments(text);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="user-message">
      <div className="user-message-label">You</div>
      <div className="user-message-body">{body}</div>
      {attachments.length > 0 && (
        <div className="user-message-attachments" role="list" aria-label="Attached files">
          {attachments.map((a, i) => (
            <button key={`${a.name}-${i}`} type="button" role="listitem" className="user-message-attachment" aria-expanded={open === `${a.name}-${i}`} onClick={() => setOpen((v) => (v === `${a.name}-${i}` ? null : `${a.name}-${i}`))} title="Show attached text">
              <span aria-hidden="true">⎘</span>{a.name}<span className="activity-meta">{a.content.length.toLocaleString()} chars</span>
            </button>
          ))}
        </div>
      )}
      {open !== null && (() => { const idx = attachments.findIndex((a, i) => `${a.name}-${i}` === open); return idx >= 0 ? <pre className="user-message-attachment-body">{attachments[idx]!.content.slice(0, 20_000)}</pre> : null; })()}
    </div>
  );
};

/** Renders one reconstructed timeline item: user prompt, assistant prose, or tool activity. */
const TimelineItemView = ({ item, workspacePath, taskTerminal, showSpeaker }: { item: TimelineItem; workspacePath?: string; taskTerminal?: boolean; showSpeaker?: boolean }) => {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return (
        <div className="assistant-message">
          {showSpeaker !== false && <div className="assistant-message-label">CodeForge</div>}
          <div className="assistant-message-body">
            <AssistantProse text={item.text} />
            {item.streaming && <span className="assistant-cursor" aria-hidden="true">▍</span>}
          </div>
        </div>
      );
    case "tool":
      return <ToolActivity item={item} workspacePath={workspacePath} taskTerminal={taskTerminal} />;
    case "system":
      return <ActivityLine kind="plan" state="completed" verb="CodeForge" target={item.text} />;
    case "phase": {
      const kinds = { testing: "test", repairing: "execute", reviewing: "verify", outcome: "complete" } as const;
      const verbs = { testing: "Verify", repairing: "Repair", reviewing: "Review" } as const;
      const outcomeState = item.phase !== "outcome" || item.text === "Done" ? "completed" : item.text === "Stopped" ? "blocked" : "failed";
      if (item.phase === "outcome") {
        // The outcome word is the row's subject: "Blocked — no forward progress", not
        // "CodeForge Blocked". The rationale rides along as attached metadata.
        return <ActivityLine kind="complete" state={outcomeState} verb={item.text} meta={item.detail} />;
      }
      const verb = verbs[item.phase];
      // Event copy already leads with the verb ("Verification · attempt 1", "Review") —
      // strip that stem so the row reads "Verify · attempt 1" instead of "Verify Verification…".
      const target = item.text.replace(/^(Verification|Repairing|Review)\b/, "").replace(/^[·\s:—-]+/, "") || undefined;
      return <ActivityLine kind={kinds[item.phase]} state={outcomeState} verb={verb} target={target} meta={item.detail} />;
    }
    case "file": {
      const filePresent = FILE_ACTION_PRESENT[item.action];
      const hasDiff = Boolean(item.diff) || item.additions !== undefined || item.deletions !== undefined;
      return (
        <FileActivity item={item} workspacePath={workspacePath} kind={filePresent.kind} verb={filePresent.verb} hasDiff={hasDiff} />
      );
    }
    case "command":
      return <CommandActivity item={item} taskTerminal={taskTerminal} />;
    case "steer":
      // A steering message is the user's own words mid-run — visually a user row, labelled so it
      // reads as course-correction rather than a new task.
      return (
        <div className="user-message user-message-steer">
          <div className="user-message-label">You · steering</div>
          <div className="user-message-body">{item.text}</div>
        </div>
      );
    case "subagent":
      return <SubagentActivity item={item} taskTerminal={taskTerminal} />;
    case "notice": {
      const spec = NOTICE_PRESENT[item.notice];
      return (
        <div className={`activity-notice ${item.notice}`}>
          <ActivityLine kind={spec.kind} state={spec.state} verb={spec.verb} target={item.text} meta={item.detail} />
        </div>
      );
    }
    default:
      return null;
  }
};

/** How a file row reads per recorded action — verbs describe what happened, not the mechanism. */
const FILE_ACTION_PRESENT: Record<Extract<TimelineItem, { kind: "file" }>["action"], { kind: ActivityKind; verb: string }> = {
  read: { kind: "read", verb: "Read" },
  written: { kind: "edit", verb: "Write" },
  created: { kind: "create", verb: "Create" },
  modified: { kind: "edit", verb: "Edit" },
  deleted: { kind: "delete", verb: "Delete" },
  reverted: { kind: "warning", verb: "Revert" },
};

const NOTICE_PRESENT: Record<Extract<TimelineItem, { kind: "notice" }>["notice"], { kind: ActivityKind; verb: string; state: ActivityState }> = {
  capacity_wait: { kind: "waiting", verb: "Parked", state: "pending" },
  route_switch: { kind: "fetch", verb: "Route", state: "completed" },
  checkpoint: { kind: "git", verb: "Checkpoint", state: "completed" },
};

/**
 * A file row: what changed and by how much. Proposed changes carry a unified diff that expands
 * on request — the Changes tab stays the full source of truth, the feed shows the shape of it.
 */
const FileActivity = ({ item, workspacePath, kind, verb, hasDiff }: { item: Extract<TimelineItem, { kind: "file" }>; workspacePath?: string; kind: ActivityKind; verb: string; hasDiff: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const reverted = item.action === "reverted";
  return (
    <ActivityLine
      kind={kind}
      state={reverted ? "failed" : "completed"}
      filePath={item.path}
      verb={verb}
      target={relativeToWorkspace(item.path, workspacePath)}
      meta={<>
        {(item.additions !== undefined || item.deletions !== undefined) && (
          <span className="activity-diff-stats">
            {item.additions !== undefined && <span className="activity-stat activity-stat-additions">+{item.additions}</span>}
            {item.deletions !== undefined && <span className="activity-stat activity-stat-deletions">−{item.deletions}</span>}
          </span>
        )}
        {item.detail && <span>{item.detail}</span>}
      </>}
      expandable={hasDiff && Boolean(item.diff)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && item.diff && <div className="activity-body"><DiffViewer diff={item.diff} fileName={item.path} initialOpen /></div>}
    </ActivityLine>
  );
};

/** A delegated worker: role, task, live progress, and how it ended — one row per agent. */
const SubagentActivity = ({ item, taskTerminal }: { item: Extract<TimelineItem, { kind: "subagent" }>; taskTerminal?: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  // A worker still "running" after the run ended was interrupted — honest copy beats a frozen Working.
  const interrupted = (item.status === "running" || item.status === "queued" || item.status === "waiting") && taskTerminal;
  const state: ActivityState = interrupted
    ? "static"
    : item.status === "completed" ? "completed"
    : item.status === "failed" ? "failed"
    : item.status === "blocked" ? "blocked"
    : item.status === "cancelled" ? "blocked"
    : item.status === "queued" || item.status === "waiting" ? "pending"
    : "active";
  const meta = interrupted
    ? "Interrupted — the run ended"
    : item.status === "running" ? (item.progress ?? "Working")
    : item.status === "queued" ? "Queued"
    : item.status === "waiting" ? (item.progress ?? "Waiting")
    : item.status === "blocked" ? (item.error ?? "Blocked")
    : item.status === "failed" ? (item.error ?? "Failed")
    : item.status === "cancelled" ? "Cancelled"
    : (item.result ? shortenSingleLine(item.result) : "Finished");
  const percent = item.percent !== undefined && (item.status === "running" || item.status === "waiting") ? ` · ${item.percent}%` : "";
  const hasDetail = item.progressLog.length > 1 || Boolean(item.result || item.error) || item.artifacts.length > 0;
  return (
    <ActivityLine
      kind="subagent"
      state={state}
      verb={item.role || "Subagent"}
      target={item.task || displayId(item.agentId)}
      meta={`${meta}${percent}`}
      expandable={hasDetail}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && (
        <div className="activity-body">
          {item.progressLog.length > 0 && (
            <div className="subagent-progress-log">
              {item.progressLog.map((line, i) => <div key={i} className="subagent-progress-line">{line}</div>)}
            </div>
          )}
          {item.result && item.status === "completed" && <div className="subagent-result">{item.result}</div>}
          {item.error && <div className="subagent-error">{item.error}</div>}
          {item.artifacts.length > 0 && (
            <div className="subagent-artifacts">
              {item.artifacts.map((ref) => <code key={ref} className="subagent-artifact">{ref}</code>)}
            </div>
          )}
        </div>
      )}
    </ActivityLine>
  );
};

function shortenSingleLine(text: string, max = 120): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function displayId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

const WorkItemRenderer = ({ item, displayMode, taskTerminal = false }: { item: WorkItem; displayMode: string; taskTerminal?: boolean }) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [approvalExpanded, setApprovalExpanded] = useState(false);

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
      // A generated plan is intent, not a receipt. Once the owning task is terminal, queued
      // planning rows must not imply that CodeForge completed (or will still execute) them. The
      // durable inspection/verification records are the authoritative terminal evidence.
      if (taskTerminal && p.status !== "completed") {
        return <ActivityLine kind="plan" state="completed" verb="Plan" target="Archived with terminal workflow result" meta="See executed activity and verification" />;
      }
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
        : taskTerminal
          ? { label: "Cancelled — the run ended before a decision", kind: "approval" as const, state: "blocked" as const }
          : { label: "Awaiting your decision", kind: "approval" as const, state: "pending" as const };
      const workflowApproval = a.tool === "workflow" && a.action === "execute_plan";
      const target = workflowApproval ? "Implementation plan" : a.action.replace(/_/g, " ");
      const resolvedSummary = workflowApproval
        ? `${outcome.label} · CodeForge ${a.decision === "deny" ? "stopped safely" : "continued the task"}`
        : outcome.label;
      return (
        <ActivityLine kind={outcome.kind} state={outcome.state} verb="Approval" target={target} meta={resolvedSummary} expandable={Boolean(a.decision)} expanded={approvalExpanded} onToggle={() => setApprovalExpanded((value) => !value)}>
          {(!a.decision || approvalExpanded) && <div className="activity-body">
            {a.description}
            {a.scope && (
              <>
                <br />
                <span className="approval-record-scope">Scope: <code>{a.scope}</code></span>
              </>
            )}
          </div>}
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

export default function Conversation({
  turns,
  workItems,
  displayMode,
  events,
  onSuggestedPrompt,
  isRunning,
  contextLabel,
  workspacePath,
  userDisplayName,
  activityOverview,
  isActivityLoading,
  activityPeriod = "all",
  onActivityPeriodChange,
  resolveModelDisplayName,
  favoriteModels,
  onSelectModel,
  onOpenModelPicker,
  workspaceBrief,
}: ConversationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const timeline = useMemo(() => buildTimeline(events ?? []), [events]);
  // 8-Bit is presentation-only here: it renders whatever the backend's last `eightbit.status`
  // event says, never influences routing/health/eligibility. See eight-bit-status.ts.
  const eightBitStatus = useMemo(() => deriveLatestEightBitStatus(events), [events]);

  // Presentation normalization: strip raw tool protocol from assistant messages before rendering
  const sanitizedTimeline = useMemo(() => {
    return timeline.map(item => {
      if (item.kind === "assistant" && item.text) {
        return { ...item, text: stripToolProtocol(item.text) };
      }
      return item;
    });
  }, [timeline]);
  const displayTimeline = useMemo(() => groupConsecutiveToolActivity(sanitizedTimeline), [sanitizedTimeline]);

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
  const isEmpty = sanitizedTimeline.length === 0 && turns.length === 0 && relevantItems.length === 0;
  // Prefer the event-sourced timeline (correct chronological interleaving of user prompts,
  // assistant prose, and tool activity). Fall back to turns+workItems only when no events exist.
  const useTimeline = displayTimeline.length > 0;

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
            <div className="empty-state-title">{userDisplayName ? `What's next, ${userDisplayName}?` : "What are we forging next?"}</div>
            <div className="empty-state-subtitle">
              Start with a repository-aware task, or ask CodeForge to inspect the codebase.
            </div>
            {contextLabel && <div className="empty-state-context">{contextLabel}</div>}
            {workspaceBrief && <WorkspaceBrief brief={workspaceBrief} />}

            {activityOverview !== undefined && activityOverview?.hasAnyHistory && (
              <ActivityOverview
                overview={activityOverview}
                isLoading={isActivityLoading}
                period={activityPeriod}
                onPeriodChange={(p) => onActivityPeriodChange?.(p)}
                resolveModelDisplayName={resolveModelDisplayName}
              />
            )}

            <div className="empty-state-favorites">
              <div className="empty-state-favorites-label">Favorite models</div>
              <div className="empty-state-favorites-list">
                {favoriteModels?.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className="empty-state-model-btn"
                    onClick={() => onSelectModel?.(model)}
                    disabled={!onSelectModel}
                  >
                    {model.displayName}
                  </button>
                ))}
                <button type="button" className="empty-state-model-btn" onClick={onOpenModelPicker} disabled={!onOpenModelPicker}>
                  + Add favorite
                </button>
              </div>
            </div>

            <div className="suggested-prompts">
              {[
                "Explain this repository",
                "Review the architecture",
                "Create an implementation plan",
                "Run the test suite",
                "Find TODOs in this workspace",
                "Review current changes",
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
            {displayTimeline.map((item, index) => (
              item.kind === "tool_group"
                ? <ToolGroupActivity key={item.id} item={item} workspacePath={workspacePath} taskTerminal={!isRunning && turns.length > 0} />
                : <TimelineItemView
                    key={item.id}
                    item={item}
                    workspacePath={workspacePath}
                    taskTerminal={!isRunning && turns.length > 0}
                    // The speaker label earns its space once per run of prose — a "CodeForge"
                    // caption on every message between tool rows is chrome, not information.
                    showSpeaker={item.kind !== "assistant" || displayTimeline[index - 1]?.kind !== "assistant"}
                  />
            ))}
            {relevantItems
              .filter((w) => w.kind === "approval" || w.kind === "question")
              .map((item) => (
                <WorkItemRenderer key={item.id} item={item} displayMode={displayMode} taskTerminal={!isRunning && turns.length > 0} />
              ))}
          </>
        ) : (
          <>
            {turns.map(renderTurn)}
            {relevantItems.map((item) => (
              <WorkItemRenderer key={item.id} item={item} displayMode={displayMode} taskTerminal={!isRunning && turns.length > 0} />
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

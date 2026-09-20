import React from "react";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { SessionRecord, WorkItem, TurnRecord } from "@codeforge/sessions";
import FileExplorer from "./FileExplorer.js";
import RunInspection from "./RunInspection.js";
import { projectSessionChanges, projectSessionCommands, projectSessionVerification } from "./session-activity.js";
import { displayAgentId, displayModelId } from "./error-copy.js";

function isWorkItemKind<K extends WorkItem["kind"]>(
  item: WorkItem,
  kind: K,
): item is Extract<WorkItem, { kind: K }> {
  return item.kind === kind;
}

interface InspectorProps {
  activeTab: string;
  onTabSelect: (tab: string) => void;
  session: SessionRecord | null;
  workItems: WorkItem[];
  turns: TurnRecord[];
  events?: WorkspaceEvent[];
  isRunning: boolean;
  /** Canonical run status word (from `presentRun`); falls back to the running flag. */
  statusLabel?: string;
  workspacePath?: string;
  activeTaskId?: string | null;
  startFailure?: { code: string; message: string };
  /** Server http origin for FileExplorer — "" when the page itself is served by the API. */
  apiBase?: string;
}

// "commands" (not "terminal") — this panel shows executed-command history, not an interactive
// PTY. Naming it Terminal misrepresented the functionality; renamed for honesty (recovery brief).
const TABS = ["changes", "run", "commands", "files", "evidence", "overview"];
const TAB_LABELS: Record<string, string> = {
  changes: "Changes",
  run: "Run",
  commands: "Commands",
  files: "Files",
  evidence: "Evidence",
  overview: "Overview",
};

export default function Inspector({ activeTab, onTabSelect, session, workItems, events = [], isRunning, statusLabel, workspacePath, activeTaskId, startFailure, apiBase = "" }: InspectorProps) {
  const safeTab = TABS.includes(activeTab) ? activeTab : "changes";
  const tabsRef = React.useRef<HTMLDivElement>(null);
  const [tabFade, setTabFade] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const measure = () =>
      setTabFade({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { el.removeEventListener("scroll", measure); observer.disconnect(); };
  }, []);

  const renderTabContent = () => {
    switch (safeTab) {
      case "changes":
        return renderChanges(workItems, events);
      case "run":
        return <RunInspection events={events} workItems={workItems} preferredRunId={activeTaskId} startFailure={startFailure} />;
      case "commands":
        return renderCommands(workItems, events, !isRunning);
      case "files":
        return renderFiles(workspacePath, apiBase);
      case "evidence":
        return renderEvidence(workItems);
      case "overview":
        return renderOverview(session, workItems, events, isRunning, statusLabel);
      default:
        return null;
    }
  };

  return (
    <aside className="workspace-inspector">
      <div className={`inspector-tabs${tabFade.left ? " can-scroll-left" : ""}${tabFade.right ? " can-scroll-right" : ""}`} ref={tabsRef}>
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`inspector-tab ${safeTab === tab ? "active" : ""}`}
            onClick={() => onTabSelect(tab)}
            role="tab"
            aria-selected={safeTab === tab}
            ref={safeTab === tab ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
          >
            {TAB_LABELS[tab] ?? tab}
          </button>
        ))}
      </div>
      <div className="inspector-content">{renderTabContent()}</div>
    </aside>
  );
}

function renderOverview(session: SessionRecord | null, workItems: WorkItem[], events: WorkspaceEvent[], isRunning: boolean, statusLabel?: string) {
  const changes = projectSessionChanges(events, workItems);
  const verification = projectSessionVerification(events, workItems);

  if (!session) {
    return <div className="panel-empty">No active session.</div>;
  }

  return (
    <div>
      <div className="overview-section">
        <div className="overview-label">Task</div>
        <div className="overview-value" style={{ fontWeight: 600 }}>{session.taskTitle || session.title}</div>
      </div>
      <div className="overview-section">
        <div className="overview-row">
          <span className="overview-row-label">Status</span>
          <span className="overview-row-value" style={{ color: isRunning ? "var(--cf-success)" : "var(--cf-text-secondary)" }}>
            {statusLabel ?? (isRunning ? "Running" : "Idle")}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-row-label">Agent</span>
          <span className="overview-row-value" title={session.currentAgentId}>{displayAgentId(session.currentAgentId)}</span>
        </div>
        <div className="overview-row">
          <span className="overview-row-label">Model</span>
          <span className="overview-row-value" title={session.currentModelId}>{displayModelId(session.currentModelId)}</span>
        </div>
        {session.branch && (
          <div className="overview-row">
            <span className="overview-row-label">Branch</span>
            <span className="overview-row-value" style={{ fontFamily: "var(--cf-font-mono)", fontSize: 11 }}>{session.branch}</span>
          </div>
        )}
        <div className="overview-row">
          <span className="overview-row-label">Files changed</span>
          <span className="overview-row-value">{changes.length}</span>
        </div>
        <div className="overview-row">
          <span className="overview-row-label">Tests</span>
          <span className="overview-row-value">
            {verification ? (
              <>
                {verification.passed > 0 && <span style={{ color: "var(--cf-success)" }}>{verification.passed} passed</span>}
                {verification.failed > 0 && <span style={{ color: "var(--cf-danger)", marginLeft: verification.passed > 0 ? 8 : 0 }}>{verification.failed} failed</span>}
                {verification.passed === 0 && verification.failed === 0 && (verification.skipped > 0 ? `${verification.skipped} skipped` : "—")}
              </>
            ) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function renderChanges(workItems: WorkItem[], events: WorkspaceEvent[]) {
  const changes = projectSessionChanges(events, workItems);
  if (changes.length === 0) {
    return <div className="panel-empty">No changes yet.</div>;
  }
  const totalAdd = changes.reduce((s, c) => s + c.additions, 0);
  const totalDel = changes.reduce((s, c) => s + c.deletions, 0);
  return (
    <div>
      <div className="changes-summary">
        {changes.length} {changes.length === 1 ? "file" : "files"} · +{totalAdd} −{totalDel}
      </div>
      <div className="changes-list">
        {changes.map((c) => (
          <div key={c.id} className="change-item">
            <span className={`change-icon ${c.changeType === "created" ? "add" : c.changeType === "deleted" ? "delete" : "modify"}`}>
              {c.changeType === "created" ? "+" : c.changeType === "deleted" ? "−" : "✎"}
            </span>
            <span className="change-path">{c.path}</span>
            <span className="change-stats">+{c.additions} −{c.deletions}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderCommands(workItems: WorkItem[], events: WorkspaceEvent[], sessionTerminal: boolean) {
  const commands = projectSessionCommands(events, workItems, sessionTerminal);
  if (commands.length === 0) {
    return <div className="panel-empty">No commands run yet.</div>;
  }
  return (
    <div>
      {commands.map((c) => (
        <div key={c.id} className="terminal-entry">
          <div className="terminal-cmd">
            <span className={`terminal-cmd-icon ${c.status === "running" ? "running" : c.status === "failed" ? "error" : c.status === "interrupted" ? "error" : "success"}`}>
              {c.status === "running" ? "●" : c.status === "failed" ? "✕" : c.status === "interrupted" ? "◌" : "✓"}
            </span>
            <span>{c.command || "(command not recorded)"}</span>
            {c.status === "interrupted" && <span style={{ marginLeft: "auto", color: "var(--cf-text-muted)" }}>did not finish</span>}
            {c.status !== "interrupted" && c.durationMs !== undefined && <span style={{ marginLeft: "auto", color: "var(--cf-text-muted)" }}>{c.durationMs}ms</span>}
          </div>
          {c.output && (
            <div className="command-block">
              <div className="command-output" style={{ maxHeight: 150, overflow: "auto" }}>{c.output}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function renderEvidence(workItems: WorkItem[]) {
  const evidence = workItems.filter((w) => w.kind === "evidence") as WorkItem[];
  const checkpoints = workItems.filter((w) => isWorkItemKind(w, "checkpoint"));

  if (evidence.length === 0 && checkpoints.length === 0) {
    return <div className="panel-empty">No evidence or checkpoints yet.</div>;
  }

  return (
    <div>
      {checkpoints.length > 0 && (
        <>
          <div className="overview-label" style={{ marginBottom: 6 }}>Checkpoints</div>
          {checkpoints.map((c) => (
            <div key={c.id} className="checkpoint-item">
              <div className="checkpoint-id">{c.id.slice(0, 8)}</div>
              <div className="checkpoint-label">{c.label}</div>
              <div className="checkpoint-meta">
                {c.fileCount} {c.fileCount === 1 ? "file" : "files"} {c.testStatus && `· ${c.testStatus}`} {c.branch && `· ${c.branch}`}
              </div>
            </div>
          ))}
        </>
      )}
      {evidence.length > 0 && (
        <>
          <div className="overview-label" style={{ marginBottom: 6, marginTop: checkpoints.length > 0 ? 12 : 0 }}>Evidence</div>
          {evidence.map((e) => {
            const ee = e as unknown as { id: string; conclusion: string; references: { kind: string; ref: string }[] };
            return (
              <div key={ee.id} className="evidence-item">
                <div className="evidence-conclusion">{ee.conclusion}</div>
                <div className="evidence-refs">
                  {ee.references.map((ref, i) => (
                    <div key={i} className="evidence-ref">[{ref.kind}] {ref.ref}</div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function renderFiles(workspacePath: string | null | undefined, apiBase: string) {
  if (!workspacePath) {
    return <div className="panel-empty">No workspace path set. Open a project to view files.</div>;
  }
  return <FileExplorer rootPath={workspacePath} apiBase={apiBase} />;
}

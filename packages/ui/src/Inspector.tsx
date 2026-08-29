import React, { useState } from "react";
import type { SessionRecord, WorkItem, TurnRecord } from "@codeforge/sessions";
import FileExplorer from "./FileExplorer.js";

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
  isRunning: boolean;
  workspacePath?: string;
}

const TABS = ["changes", "terminal", "files", "evidence", "overview"];

export default function Inspector({ activeTab, onTabSelect, session, workItems, turns, isRunning, workspacePath }: InspectorProps) {
  const safeTab = TABS.includes(activeTab) ? activeTab : "changes";

  const renderTabContent = () => {
    switch (safeTab) {
      case "changes":
        return renderChanges(workItems);
      case "terminal":
        return renderTerminal(workItems);
      case "files":
        return renderFiles(workspacePath);
      case "evidence":
        return renderEvidence(workItems);
      case "overview":
        return renderOverview(session, workItems, isRunning);
      default:
        return null;
    }
  };

  return (
    <aside className="workspace-inspector">
      <div className="inspector-tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`inspector-tab ${safeTab === tab ? "active" : ""}`}
            onClick={() => onTabSelect(tab)}
            role="tab"
            aria-selected={safeTab === tab}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="inspector-content">{renderTabContent()}</div>
    </aside>
  );
}

function renderOverview(session: SessionRecord | null, workItems: WorkItem[], isRunning: boolean) {
  const changes = workItems.filter((w) => isWorkItemKind(w, "file_change"));
  const tests = workItems.filter((w) => isWorkItemKind(w, "test_run"));
  const totalPassed = tests.reduce((sum, t) => sum + t.passed, 0);
  const totalFailed = tests.reduce((sum, t) => sum + t.failed, 0);

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
            {isRunning ? "Running" : "Idle"}
          </span>
        </div>
        <div className="overview-row">
          <span className="overview-row-label">Agent</span>
          <span className="overview-row-value">{session.currentAgentId || "—"}</span>
        </div>
        <div className="overview-row">
          <span className="overview-row-label">Model</span>
          <span className="overview-row-value">{session.currentModelId || "—"}</span>
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
            {totalPassed > 0 && <span style={{ color: "var(--cf-success)" }}>{totalPassed} passed</span>}
            {totalFailed > 0 && <span style={{ color: "var(--cf-danger)", marginLeft: totalPassed > 0 ? 8 : 0 }}>{totalFailed} failed</span>}
            {totalPassed === 0 && totalFailed === 0 && "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function renderChanges(workItems: WorkItem[]) {
  const changes = workItems.filter((w) => isWorkItemKind(w, "file_change"));
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

function renderTerminal(workItems: WorkItem[]) {
  const commands = workItems.filter((w) => isWorkItemKind(w, "command"));
  if (commands.length === 0) {
    return <div className="panel-empty">No commands yet.</div>;
  }
  return (
    <div>
      {commands.map((c) => (
        <div key={c.id} className="terminal-entry">
          <div className="terminal-cmd">
            <span className={`terminal-cmd-icon ${c.status === "running" ? "running" : c.status === "failed" ? "error" : "success"}`}>
              {c.status === "running" ? "●" : c.status === "failed" ? "✕" : "✓"}
            </span>
            <span>{c.command}</span>
            {c.durationMs && <span style={{ marginLeft: "auto", color: "var(--cf-text-muted)" }}>{c.durationMs}ms</span>}
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

function renderFiles(workspacePath?: string | null) {
  if (!workspacePath) {
    return <div className="panel-empty">No workspace path set. Open a project to view files.</div>;
  }
  return <FileExplorer rootPath={workspacePath} />;
}

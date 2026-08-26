import React from "react";
import type { SessionRecord, WorkItem, TurnRecord } from "@codeforge/sessions";
import { isWorkItemKind } from "@codeforge/sessions";

interface InspectorProps {
  activeTab: string;
  onTabSelect: (tab: string) => void;
  session: SessionRecord | null;
  workItems: WorkItem[];
  turns: TurnRecord[];
  isRunning: boolean;
}

const TABS = [
  "overview",
  "plan",
  "changes",
  "terminal",
  "tests",
  "artifacts",
  "agents",
  "context",
  "evidence",
];

export default function Inspector({ activeTab, onTabSelect, session, workItems, turns, isRunning }: InspectorProps) {
  const renderTabContent = () => {
    switch (activeTab) {
      case "overview":
        return renderOverview(session, workItems, isRunning);
      case "plan":
        return renderPlan(workItems);
      case "changes":
        return renderChanges(workItems);
      case "terminal":
        return renderTerminal(workItems);
      case "tests":
        return renderTests(workItems);
      case "artifacts":
        return renderArtifacts(workItems);
      case "agents":
        return renderAgents(workItems);
      case "context":
        return renderContext(workItems);
      case "evidence":
        return renderEvidence(workItems);
      default:
        return null;
    }
  };

  return (
    <aside className="workspace-inspector">
      <div className="workspace-inspector-tabs scrollbar-thin">
        {TABS.map((tab) => (
          <div
            key={tab}
            className={`workspace-inspector-tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => onTabSelect(tab)}
          >
            {tab}
          </div>
        ))}
      </div>
      <div className="workspace-inspector-content scrollbar-thin">{renderTabContent()}</div>
    </aside>
  );
}

function renderOverview(session: SessionRecord | null, workItems: WorkItem[], isRunning: boolean) {
  const agents = workItems.filter((w) => isWorkItemKind(w, "agent"));
  const changes = workItems.filter((w) => isWorkItemKind(w, "file_change"));
  const tests = workItems.filter((w) => isWorkItemKind(w, "test_run"));
  const totalPassed = tests.reduce((sum, t) => sum + t.passed, 0);
  const totalFailed = tests.reduce((sum, t) => sum + t.failed, 0);
  const activeAgents = agents.filter((a) => a.status === "working").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {session && (
        <div style={{ padding: 12, background: "var(--bg-tertiary)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Task</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{session.taskTitle || session.title}</div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Status</span>
              <span style={{ color: isRunning ? "var(--success)" : "var(--text-secondary)" }}>{isRunning ? "Running" : "Idle"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Agent</span>
              <span>{session.currentAgentId || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Model</span>
              <span>{session.currentModelId || "—"}</span>
            </div>
            {session.branch && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-muted)" }}>Branch</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{session.branch}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Files</span>
              <span>{changes.length} changed</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Tests</span>
              <span>
                {totalPassed > 0 && <span style={{ color: "var(--success)" }}>{totalPassed} passed</span>}
                {totalFailed > 0 && <span style={{ color: "var(--danger)", marginLeft: 8 }}>{totalFailed} failed</span>}
                {totalPassed === 0 && totalFailed === 0 && "—"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>Agents</span>
              <span>{agents.filter((a) => (a as unknown as { status: string }).status === "working").length} active</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderPlan(workItems: WorkItem[]) {
  const plans = workItems.filter((w) => w.kind === "plan") as WorkItem[];
  if (plans.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No plans yet.</div>;
  }
  return plans.map((plan) => {
    const p = plan as unknown as {
      id: string;
      title: string;
      status: string;
      steps: { id: string; description: string; status: string }[];
    };
    return (
      <div key={p.id} className="plan-container">
        <div className="plan-header">
          <span className="plan-title">{p.title}</span>
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
      </div>
    );
  });
}

function renderChanges(workItems: WorkItem[]) {
  const changes = workItems.filter((w) => isWorkItemKind(w, "file_change"));
  if (changes.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No changes yet.</div>;
  }
  const totalAdd = changes.reduce((s, c) => s + c.additions, 0);
  const totalDel = changes.reduce((s, c) => s + c.deletions, 0);
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
        +{totalAdd} -{totalDel} · {changes.length} files
      </div>
      <div className="changes-list">
        {changes.map((c) => (
          <div key={c.id} className="change-item">
            <span className="change-icon">
              {c.changeType === "created" ? "+" : c.changeType === "deleted" ? "−" : "✎"}
            </span>
            <span className="change-path">{c.path}</span>
            <span className="change-stats">+{c.additions} -{c.deletions}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderTerminal(workItems: WorkItem[]) {
  const commands = workItems.filter((w) => isWorkItemKind(w, "command"));
  if (commands.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No commands yet.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {commands.map((c) => (
        <div key={c.id}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
            {c.command} {c.status === "running" ? "● Running" : c.status === "failed" ? `✕ Exit ${c.exitCode}` : "✓ Completed"} {c.durationMs ? `· ${c.durationMs}ms` : ""}
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

function renderTests(workItems: WorkItem[]) {
  const tests = workItems.filter((w) => isWorkItemKind(w, "test_run"));
  if (tests.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No tests yet.</div>;
  }
  const totalPassed = tests.reduce((s, t) => s + t.passed, 0);
  const totalFailed = tests.reduce((s, t) => s + t.failed, 0);
  return (
    <div>
      <div className="test-summary" style={{ marginBottom: 12 }}>
        <div className="test-card">
          <div className="test-card-title">Passed</div>
          <div className="test-card-value pass">{totalPassed}</div>
        </div>
        <div className="test-card">
          <div className="test-card-title">Failed</div>
          <div className="test-card-value fail">{totalFailed}</div>
        </div>
      </div>
      {tests.map((t) => (
        <div key={t.id} className="test-run">
          <div className="test-run-header">
            <span className="test-run-name">{t.name}</span>
            <span className={`test-run-status ${t.failed > 0 ? "fail" : "pass"}`}>{t.passed}/{t.passed + t.failed}</span>
          </div>
          {t.failures && t.failures.length > 0 && (
            <div className="test-failures">
              {t.failures.map((f, i) => (
                <div key={i} className="test-failure">{f.test}: {f.message}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function renderArtifacts(workItems: WorkItem[]) {
  const artifacts = workItems.filter((w) => isWorkItemKind(w, "artifact"));
  if (artifacts.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No artifacts yet.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {artifacts.map((a) => (
        <div key={a.id} className="artifact-card">
          <div className="artifact-type">{a.type}</div>
          <div className="artifact-title">{a.title}</div>
        </div>
      ))}
    </div>
  );
}

function renderAgents(workItems: WorkItem[]) {
  const agents = workItems.filter((w) => isWorkItemKind(w, "agent"));
  if (agents.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No agents active.</div>;
  }
  return (
    <div className="agent-grid">
      {agents.map((a) => (
        <div key={a.id} className="agent-card">
          <div className={`agent-status-indicator ${a.status}`} />
          <div className="agent-card-name">{a.role}</div>
          <div className="agent-card-status">{a.status}</div>
          {a.progress !== undefined && (
            <div className="agent-card-progress">
              <div className="agent-card-progress-fill" style={{ width: `${a.progress}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function renderContext(workItems: WorkItem[]) {
  const refs = workItems.filter((w) => isWorkItemKind(w, "context_ref"));
  if (refs.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No context references yet.</div>;
  }
  return (
    <div className="context-list">
      {refs.map((r) => (
        <div key={r.id} className="context-item">
          <span className="context-item-icon">{r.refType === "file" ? "📄" : r.refType === "folder" ? "📁" : "◉"}</span>
          <span className="context-item-path">{r.ref}</span>
        </div>
      ))}
    </div>
  );
}

function renderEvidence(workItems: WorkItem[]) {
  const evidence = workItems.filter((w) => w.kind === "evidence") as WorkItem[];
  if (evidence.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No evidence records yet.</div>;
  }
  return (
    <div>
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
    </div>
  );
}

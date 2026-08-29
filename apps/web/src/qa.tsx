/**
 * Visual QA harness — renders the real @codeforge/ui components with mock
 * data across every meaningful workspace state, so the desktop UI can be
 * reviewed in a browser without the Electron shell or the live server.
 *
 * Not shipped: excluded from the production web entry (index.html -> main.tsx).
 * Navigate with ?scenario=<name>. Scenario list is rendered in the top bar.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import {
  Navigation,
  Conversation,
  Inspector,
  Composer,
  Header,
  ModelSelector,
  ApprovalBar,
  QuestionBar,
} from "@codeforge/ui";
import "../../../packages/ui/src/workspace.css";
import "../../../apps/desktop/src/renderer/styles.css";

const noop = () => {};
const now = new Date().toISOString();

const sampleModels = [
  { id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free Model" },
  { id: "opencode/qwen-2.5-coder", displayName: "Qwen 2.5 Coder 32B", tier: "free", description: "Free" },
  { id: "openrouter/deepseek-v3", displayName: "DeepSeek V3", tier: "free", description: "Free" },
  { id: "codeforge/topaz", displayName: "Topaz", tier: "gems_paid", entitlementStatus: "requires_subscription" },
  { id: "codeforge/garnet", displayName: "Garnet", tier: "gems_paid", entitlementStatus: "requires_subscription" },
] as any;

const project = { name: "codeforge-web", path: "G:\\CodeForge" };

function ForgeZeroPopover() {
  const rows = [
    "Provider: Qwen 2.5 Coder (Available)",
    "Zero Billing · Verified Free",
    "Workspace Boundary Isolated",
    "Secrets Redaction Active",
    "Safety Timeout Enforced (10m)",
  ];
  return (
    <div className="forgezero-popover" onClick={(e) => e.stopPropagation()}>
      <div className="forgezero-popover-title">ForgeZero Trust Status</div>
      {rows.map((r) => (
        <div className="forgezero-popover-row" key={r}>
          <span className="forgezero-popover-icon">✓</span>
          <span className="forgezero-popover-label">{r}</span>
        </div>
      ))}
    </div>
  );
}

function Shell({ children, forgeZeroOpen }: { children: React.ReactNode; forgeZeroOpen?: boolean }) {
  return (
    <div className="workspace-shell">
      <header className="workspace-shell-header">
        <div className="header-left">
          <button className="header-back" title="Back to projects">←</button>
          <div className="header-project">
            <span className="project-name">{project.name}</span>
            <span className="project-path">{project.path}</span>
          </div>
        </div>
        <div className="header-right">
          <div className="forgezero-indicator" style={{ position: "relative" }}>
            <span className="forgezero-icon">◈</span>
            <span>ForgeZero · Verified Free</span>
            {forgeZeroOpen && <ForgeZeroPopover />}
          </div>
          <button className="header-btn" title="Help">?</button>
        </div>
      </header>
      <main className="workspace-shell-main">{children}</main>
    </div>
  );
}

interface LayoutOpts {
  navActive?: string;
  session?: any;
  turns?: any[];
  workItems?: any[];
  isRunning?: boolean;
  isPaused?: boolean;
  activePhase?: string;
  workflowProgress?: number;
  activeTab?: string;
  placeholder?: string;
  forgeZeroOpen?: boolean;
  modelSelectorOpen?: boolean;
  pendingApproval?: any;
  pendingQuestion?: any;
}

function Layout(opts: LayoutOpts) {
  const {
    navActive = "sessions",
    session = null,
    turns = [],
    workItems = [],
    isRunning = false,
    isPaused = false,
    activePhase,
    workflowProgress,
    activeTab = "changes",
    placeholder = "Ask CodeForge to work on this project... try: Fix add function to return a + b",
    forgeZeroOpen = false,
    modelSelectorOpen = false,
    pendingApproval = null,
    pendingQuestion = null,
  } = opts;

  return (
    <Shell forgeZeroOpen={forgeZeroOpen}>
      <div className="workspace">
        <div className="workspace-body">
          <Navigation
            sessions={session ? [{ id: session.id, title: session.title, taskTitle: session.taskTitle, status: session.status, updatedAt: now }] : []}
            activeSessionId={session?.id ?? null}
            onSelectSession={noop}
            onNewTask={noop}
            projectName={project.name}
            onOpenProjects={noop}
            onOpenSettings={noop}
            onOpenHelp={noop}
            workItems={workItems}
          />
          <div className="workspace-center">
            <button className="panel-toggle panel-toggle-left" title="Collapse Sidebar">◀</button>
            <button className="panel-toggle panel-toggle-right" title="Collapse Inspector">▶</button>
            {session && (
              <Header
                session={session}
                agentStatus={isRunning ? "running" : (session.status ?? "idle")}
                isRunning={isRunning}
                isPaused={isPaused}
                activePhase={activePhase}
                workflowProgress={workflowProgress}
                onStop={noop}
                onPause={noop}
                onResume={noop}
              />
            )}
            <Conversation turns={turns} workItems={workItems} displayMode="detailed" isRunning={isRunning} contextLabel={`CodeForge · ${project.name}`} />
            {pendingApproval && <ApprovalBar approval={pendingApproval} onApprove={noop} onDeny={noop} />}
            {pendingQuestion && <QuestionBar question={pendingQuestion} onAnswer={noop} />}
            {modelSelectorOpen ? (
              <div className="workspace-composer" style={{ position: "relative" }}>
                <div className="composer-input-row">
                  <textarea className="composer-input" placeholder={placeholder} rows={1} />
                  <button className="composer-btn" style={{ minWidth: 40, height: 38 }}>↑</button>
                </div>
                <div className="composer-toolbar">
                  <div className="composer-toolbar-left">
                    <ModelSelector models={sampleModels} selectedId="auto" onSelect={noop} onShowDetails={noop} isOpen />
                  </div>
                  <div className="composer-toolbar-right">Enter to send · Shift+Enter for newline · Esc to stop · / for commands</div>
                </div>
              </div>
            ) : (
              <Composer
                placeholder={placeholder}
                onSend={noop}
                onSteer={noop}
                onStop={noop}
                onPause={noop}
                onResume={noop}
                onBackground={noop}
                isRunning={isRunning}
                isPaused={isPaused}
                models={sampleModels}
                selectedModelId="auto"
                onSelectModel={noop}
                onShowModelDetails={noop}
              />
            )}
          </div>
          <Inspector
            activeTab={activeTab}
            onTabSelect={noop}
            session={session}
            workItems={workItems}
            turns={turns}
            isRunning={isRunning}
            workspacePath={undefined}
          />
        </div>
      </div>
    </Shell>
  );
}

// ── Mock data ─────────────────────────────────────────────
const richItems = [
  { kind: "activity", id: "w1", sessionId: "s", title: "Inspected repository structure and dependencies", status: "completed", durationMs: 210, detail: "TypeScript ESM workspace with vitest. 30 packages.", startedAt: now },
  { kind: "command", id: "w2", sessionId: "s", command: "npm test", status: "completed", output: "✓ src/calc.test.ts (4 tests) 12ms\nTest Files  1 passed (1)\n     Tests  4 passed (4)", durationMs: 1240, startedAt: now },
  { kind: "file_change", id: "w3", sessionId: "s", path: "src/calc.ts", additions: 8, deletions: 2, changeType: "modified", startedAt: now, diff: "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1,4 +1,8 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n+}\n+\n+export function multiply(a: number, b: number): number {\n+  return a * b;\n }" },
  { kind: "test_run", id: "w4", sessionId: "s", name: "Calc Unit Tests", passed: 4, failed: 0, skipped: 0, startedAt: now },
  { kind: "plan", id: "w5", sessionId: "s", title: "Implementation Plan", status: "in_progress", createdAt: now, updatedAt: now, steps: [
    { id: "s1", description: "Audit existing calc.ts implementation", status: "completed" },
    { id: "s2", description: "Implement add and multiply functions", status: "completed" },
    { id: "s3", description: "Add comprehensive unit tests in vitest", status: "active" },
    { id: "s4", description: "Verify typecheck and full test suite passes", status: "pending" },
  ] },
];

const scenarios: Record<string, () => React.ReactElement> = {
  empty: () => <Layout navActive="projects" session={null} activeTab="overview" />,

  active: () => <Layout
    session={{ id: "s", title: "Fix add function to return a + b", taskTitle: "Fix add function to return a + b", status: "running", branch: "fix/math-addition", currentAgentId: "forge-coder", currentModelId: "qwen-2.5-coder" }}
    turns={[{ id: "t1", sessionId: "s", seq: 0, userMessage: "Fix the add function in src/calc.ts so it returns a + b instead of a - b", status: "completed" }]}
    workItems={[
      { kind: "activity", id: "a1", sessionId: "s", title: "Inspected repository architecture and calc.ts", status: "completed", durationMs: 140, startedAt: now },
      { kind: "command", id: "a2", sessionId: "s", command: "npm test", status: "failed", exitCode: 1, output: "FAIL src/calc.test.ts > add returns sum\nAssertionError: expected -1 to be 5", durationMs: 820, startedAt: now },
      { kind: "activity", id: "a3", sessionId: "s", title: "Synthesizing fix via ForgeZero verified free model", status: "started", startedAt: now },
    ]}
    isRunning activePhase="implementing" workflowProgress={55} activeTab="terminal" placeholder="Steer the agent…" />,

  stream: () => <Layout
    session={{ id: "s", title: "Implement calculator suite", taskTitle: "Implement calculator suite", status: "running", branch: "feature/calc-suite", currentAgentId: "forge-coder", currentModelId: "qwen-2.5-coder" }}
    turns={[{ id: "t1", sessionId: "s", seq: 0, userMessage: "Create a calc suite with add, subtract, multiply and verify tests pass", status: "completed" }]}
    workItems={richItems}
    isRunning activePhase="testing" workflowProgress={68} activeTab="changes" placeholder="Steer the agent…" />,

  changes: () => <Layout
    session={{ id: "s", title: "Add multiply and divide", taskTitle: "Add multiply and divide with zero-division safety", status: "idle", branch: "refactor/calc-modules" }}
    turns={[{ id: "t1", sessionId: "s", seq: 0, userMessage: "Add multiply and divide with zero-division safety", status: "completed" }]}
    workItems={[
      { kind: "file_change", id: "c1", sessionId: "s", path: "src/calc.ts", additions: 14, deletions: 3, changeType: "modified", startedAt: now, diff: "--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1,5 +1,16 @@\n export function add(a: number, b: number): number {\n   return a + b;\n }\n+\n+export function divide(a: number, b: number): number {\n+  if (b === 0) throw new Error(\"Division by zero\");\n+  return a / b;\n+}" },
      { kind: "file_change", id: "c2", sessionId: "s", path: "src/calc.test.ts", additions: 18, deletions: 1, changeType: "modified", startedAt: now },
      { kind: "file_change", id: "c3", sessionId: "s", path: "src/index.ts", additions: 4, deletions: 0, changeType: "created", startedAt: now },
      { kind: "test_run", id: "c4", sessionId: "s", name: "Calculator Test Suite", passed: 8, failed: 0, skipped: 0, startedAt: now },
    ]}
    activeTab="changes" />,

  complete: () => <Layout
    session={{ id: "s", title: "Fix add function", taskTitle: "Fix add function to return a + b", status: "completed", branch: "fix/math-addition", currentAgentId: "forge-coder", currentModelId: "qwen-2.5-coder" }}
    turns={[{ id: "t1", sessionId: "s", seq: 0, userMessage: "Fix add function in src/calc.ts", status: "completed" }]}
    workItems={[
      { kind: "activity", id: "e1", sessionId: "s", title: "Inspected repository and found calc.ts bug", status: "completed", durationMs: 110, startedAt: now },
      { kind: "file_change", id: "e2", sessionId: "s", path: "src/calc.ts", additions: 2, deletions: 2, changeType: "modified", startedAt: now },
      { kind: "command", id: "e3", sessionId: "s", command: "npm test", status: "completed", output: "✓ src/calc.test.ts (2 tests)\nTests  2 passed (2)", durationMs: 640, startedAt: now },
      { kind: "checkpoint", id: "chk-89ab0123", sessionId: "s", label: "Pre-verification checkpoint", fileCount: 1, testStatus: "passed", branch: "fix/math-addition", createdAt: now },
      { kind: "evidence", id: "evi-cdef4567", sessionId: "s", conclusion: "Verified add(2, 3) === 5 and all tests pass with 0 errors.", references: [{ kind: "file", ref: "src/calc.ts" }, { kind: "command", ref: "npm test" }], createdAt: now },
    ]}
    activePhase="complete" workflowProgress={100} activeTab="evidence" />,

  approval: () => <Layout
    session={{ id: "s", title: "Refactor auth module", taskTitle: "Refactor auth module", status: "running", branch: "refactor/auth" }}
    turns={[{ id: "t1", sessionId: "s", seq: 0, userMessage: "Refactor the auth module and remove the deprecated token path", status: "completed" }]}
    workItems={richItems.slice(0, 2)}
    isRunning activePhase="awaiting_approval" workflowProgress={40} activeTab="terminal"
    placeholder="Review the plan above and approve or deny…"
    pendingApproval={{ kind: "approval", id: "ap1", sessionId: "s", tool: "shell", action: "rm -rf ./legacy", description: "Delete the deprecated legacy auth directory (12 files). This cannot be undone without a checkpoint restore.", risk: "high", scope: "G:\\CodeForge\\src\\legacy", createdAt: now }} />,

  question: () => <Layout
    session={{ id: "s", title: "Set up database", taskTitle: "Set up database layer", status: "running", branch: "feature/db" }}
    turns={[{ id: "t1", sessionId: "s", seq: 0, userMessage: "Add a database layer", status: "completed" }]}
    workItems={richItems.slice(0, 1)}
    isRunning activePhase="planning" workflowProgress={25} activeTab="overview"
    placeholder="Answer the agent..."
    pendingQuestion={{ kind: "question", id: "q1", sessionId: "s", prompt: "Which database should I use for the persistence layer?", options: ["SQLite (local, zero-config)", "PostgreSQL", "Let me decide"], createdAt: now }} />,

  model: () => <Layout
    session={{ id: "s", title: "Model selection", taskTitle: "Model selection", status: "idle" }}
    turns={[]} workItems={[]} activeTab="overview" modelSelectorOpen />,

  forgezero: () => <Layout
    session={{ id: "s", title: "Trust status", taskTitle: "Trust status", status: "idle" }}
    turns={[]} workItems={[]} activeTab="overview" forgeZeroOpen />,
};

const SCENARIO_KEYS = Object.keys(scenarios);

function QAApp() {
  const params = new URLSearchParams(window.location.search);
  const current = params.get("scenario") || "empty";
  const render = scenarios[current] ?? scenarios.empty!;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 4, padding: "4px 8px", background: "#000", borderBottom: "1px solid #333", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ color: "#888", fontSize: 11, marginRight: 8, fontFamily: "system-ui" }}>QA:</span>
        {SCENARIO_KEYS.map((k) => (
          <a key={k} href={`?scenario=${k}`} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, textDecoration: "none", fontFamily: "system-ui", background: k === current ? "#4f8fff" : "#1a1b1e", color: k === current ? "#fff" : "#9ca0a8", border: "1px solid #2e2f35" }}>{k}</a>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>{render()}</div>
    </div>
  );
}

// Reuse a single root across Vite HMR updates to avoid duplicate-createRoot warnings.
const container = document.getElementById("root")! as HTMLElement & { _qaRoot?: ReactDOM.Root };
const root = container._qaRoot ?? (container._qaRoot = ReactDOM.createRoot(container));
root.render(<QAApp />);

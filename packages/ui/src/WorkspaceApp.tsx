import React, { useState, useCallback } from "react";
import type { ExecutionMode } from "@codeforge/protocol";
import type { WorkspaceState } from "./workspace-sse.js";
import { readRememberedExecutionMode, rememberExecutionMode, useWorkspaceSSE } from "./workspace-sse.js";
import Header from "./Header.js";
import Navigation from "./Navigation.js";
import Conversation from "./Conversation.js";
import Inspector from "./Inspector.js";
import Composer from "./Composer.js";
import ApprovalBar from "./ApprovalBar.js";
import QuestionBar from "./QuestionBar.js";
import CommandPalette, { type Command } from "./CommandPalette.js";
import WorkflowProgress from "./WorkflowProgress.js";
import { type ModelSelectorItem, type ModelSection } from "./ModelSelector.js";
import { ForgeWorkingIndicator } from "./activity-icons.js";
import { isForgeWorkActive } from "./forge-activity.js";
import "./workspace.css";

/** Turn provider/runtime errors into concise, actionable guidance. */
export function humanizeError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("401") || m.includes("invalid api key") || m.includes("autherror") || m.includes("unauthorized"))
    return "Provider authentication failed — your API key is invalid or expired. Update it in Settings → Providers.";
  if (m.includes("403")) return "Access denied by the provider. Check your API key permissions in Settings → Providers.";
  if (m.includes("429") || m.includes("rate limit")) return "The provider is rate limited. Wait a moment and try again.";
  if (m.includes("not found in catalog") || m.includes("no free provider") || m.includes("no verified free"))
    return "No verified free model is available. Connect a provider in Settings → Providers.";
  if (m.includes("payment") || m.includes("paid model")) return "That model requires a paid plan. Choose a verified free model or connect a provider.";
  if (m.includes("timeout")) return "The request timed out — the provider may be slow or unavailable. Try again.";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("econn")) return "Network error — check your connection and that the CodeForge server is running.";
  if (m.includes("no workspace")) return "No workspace is set. Open a project folder first.";
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

export interface SessionSummary {
  id: string;
  title?: string;
  taskTitle?: string;
  status?: string;
  updatedAt?: string;
}

export interface WorkspaceAppProps {
  sseUrl?: string;
  onSendMessage?: (message: string, steer: boolean, executionMode: ExecutionMode) => void;
  models?: ModelSelectorItem[];
  selectedModelId?: string | null;
  onSelectModel?: (model: ModelSelectorItem, sessionId?: string) => void;
  onShowModelDetails?: (model: ModelSelectorItem) => void;
  onUpgradeNavigation?: (url: string) => void;
  modelSections?: ModelSection[];
  projectName?: string;
  projectBranch?: string;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
  onOpenHelp?: () => void;
}

export default function WorkspaceApp({
  sseUrl,
  onSendMessage,
  models,
  selectedModelId,
  onSelectModel,
  onShowModelDetails,
  onUpgradeNavigation,
  modelSections,
  projectName,
  projectBranch,
  onOpenProjects,
  onOpenSettings,
  onOpenHelp,
}: WorkspaceAppProps) {
  const { state, setState, sendMessage, approve, answerQuestion, stopTurn, pauseTurn, resumeTurn, cancelWorkflow, dismissWorkflowError, selectSession, startNewSession, hydrate } = useWorkspaceSSE(sseUrl ?? "/api/events");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() => readRememberedExecutionMode());

  const apiOrigin = React.useMemo(() => {
    const u = sseUrl ?? "";
    if (u.startsWith("http://") || u.startsWith("https://")) {
      try { return new URL(u).origin; } catch { return ""; }
    }
    return "";
  }, [sseUrl]);

  // CF-11B: publication is a single Cloud request. The desktop UI never pushes or opens a PR, and
  // it never marks a delivery published on its own — it re-hydrates and shows Cloud's state.
  const publishDelivery = useCallback(async (deliveryId: string) => {
    if (!apiOrigin) return;
    await fetch(`${apiOrigin}/api/deliveries/${encodeURIComponent(deliveryId)}/publication`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    hydrate();
  }, [apiOrigin, hydrate]);
  const retryPublication = useCallback(async (deliveryId: string) => {
    if (!apiOrigin) return;
    await fetch(`${apiOrigin}/api/deliveries/${encodeURIComponent(deliveryId)}/publication/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    hydrate();
  }, [apiOrigin, hydrate]);
  const authorizeRepository = useCallback(async (deliveryId: string) => {
    if (!apiOrigin) return;
    // Read-only: reports whether Cloud already authorizes this repository. No credential crosses here.
    await fetch(`${apiOrigin}/api/deliveries/${encodeURIComponent(deliveryId)}/publication/authorization`);
    hydrate();
  }, [apiOrigin, hydrate]);

  const refreshSessions = useCallback(async () => {
    if (!apiOrigin) return;
    try {
      const res = await fetch(`${apiOrigin}/api/sessions`);
      if (!res.ok) return;
      const data = (await res.json()) as SessionSummary[];
      if (Array.isArray(data)) setSessions(data);
    } catch {
      // server may still be starting
    }
  }, [apiOrigin]);

  React.useEffect(() => {
    refreshSessions();
  }, [refreshSessions, state.session?.id, state.isRunning]);

  const commands: Command[] = [
    {
      id: "new-session",
      label: "New Session",
      description: "Start a new coding session",
      icon: "＋",
      action: startNewSession,
      shortcut: "Ctrl+N",
    },
    {
      id: "clear-context",
      label: "Clear Context",
      description: "Reset conversation context",
      icon: "🗑",
      action: () => setState((prev) => ({ ...prev, turns: [], workItems: [], events: [] })),
      shortcut: "Ctrl+L",
    },
    {
      id: "toggle-debug",
      label: "Toggle Debug Mode",
      description: "Show detailed debug information",
      icon: "🐛",
      action: () => setState((prev) => ({ ...prev, displayMode: prev.displayMode === "debug" ? "compact" : "debug" })),
    },
    {
      id: "toggle-compact",
      label: "Compact View",
      description: "Show compact conversation view",
      icon: "☰",
      action: () => setState((prev) => ({ ...prev, displayMode: "compact" })),
    },
    {
      id: "toggle-detailed",
      label: "Detailed View",
      description: "Show detailed conversation view",
      icon: "☷",
      action: () => setState((prev) => ({ ...prev, displayMode: "detailed" })),
    },
    {
      id: "approve-all",
      label: "Approve All Pending",
      description: "Approve all pending approvals",
      icon: "✓",
      action: () => approve("allow_once"),
    },
    {
      id: "deny-all",
      label: "Deny All Pending",
      description: "Deny all pending approvals",
      icon: "✕",
      action: () => approve("deny"),
    },
    {
      id: "stop",
      label: "Stop Agent",
      description: "Stop the current agent run",
      icon: "⏹",
      action: () => {
        const activeTurn = state.turns.find((t) => t.status === "running");
        if (activeTurn && state.session) {
          stopTurn(state.session.id, activeTurn.id);
        }
      },
      shortcut: "Esc",
    },
  ];

  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    },
    []
  );

  React.useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  const handleSend = (message: string, steer = false) => {
    const requestMode = executionMode;
    if (onSendMessage) {
      onSendMessage(message, steer, requestMode);
    } else {
      sendMessage(message, steer, requestMode);
    }
  };

  const handleExecutionModeChange = (mode: ExecutionMode) => {
    setExecutionMode(mode);
    rememberExecutionMode(mode);
  };

  const placeholder = state.pendingApproval?.tool === "workflow"
    ? "Review the plan above and approve or deny…"
    : state.isRunning
      ? state.activePhase === "awaiting_approval"
        ? "Awaiting plan approval…"
        : "Steer the agent…"
      : state.pendingQuestion
        ? "Answer the agent..."
        : "Ask CodeForge to work on this project... try: Fix add function to return a + b";

  const startFailureEvent = [...state.events].reverse().find((event) => event.type === "execution.start_failed");
  const startFailure = startFailureEvent?.type === "execution.start_failed"
    ? { code: startFailureEvent.payload.code, message: startFailureEvent.payload.message }
    : undefined;
  const forgeWorkActive = isForgeWorkActive(state);

  return (
    <div className="workspace">
      <div className="workspace-body">
        {!sidebarCollapsed && (
          <Navigation
            sessions={sessions}
            activeSessionId={state.session?.id ?? null}
            onSelectSession={(id) => selectSession(id)}
            onNewTask={startNewSession}
            projectName={projectName}
            onOpenProjects={onOpenProjects}
            onOpenSettings={onOpenSettings}
            onOpenHelp={onOpenHelp}
            workItems={state.workItems}
          />
        )}

        <div className="workspace-center">
          <button
            className="panel-toggle panel-toggle-left"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>

          <button
            className="panel-toggle panel-toggle-right"
            onClick={() => setInspectorCollapsed(!inspectorCollapsed)}
            title={inspectorCollapsed ? "Expand Inspector" : "Collapse Inspector"}
          >
            {inspectorCollapsed ? "◀" : "▶"}
          </button>

          {state.session && (
            <Header
              session={state.session}
              agentStatus={state.agentStatus}
              isRunning={state.isRunning}
              isPaused={state.isPaused}
              activePhase={state.activePhase}
              workflowProgress={state.workflowProgress}
              onStop={() => {
                const activeTurn = state.turns.find((t) => t.status === "running");
                if (activeTurn && state.session) stopTurn(state.session.id, activeTurn.id);
              }}
              onPause={() => {
                const activeTurn = state.turns.find((t) => t.status === "running");
                if (activeTurn && state.session) pauseTurn(state.session.id, activeTurn.id);
              }}
              onResume={() => {
                const pausedTurn = state.turns.find((t) => t.status === "paused");
                if (pausedTurn && state.session) resumeTurn(state.session.id, pausedTurn.id);
              }}
            />
          )}

          {(state.activeTaskId || state.isRunning || state.workflowError || state.lastWorkflowResult || state.pendingApproval?.tool === "workflow" || state.workItems.some((item) => item.kind === "change_delivery" || item.kind === "cloud_publication")) && (
            <div style={{ padding: "8px 12px" }}>
              <WorkflowProgress state={state} onCancel={() => cancelWorkflow()} onApprove={approve} onPublishDelivery={publishDelivery} onRetryPublication={retryPublication} onAuthorizeRepository={authorizeRepository} />
            </div>
          )}

          <Conversation
            turns={state.turns}
            workItems={state.workItems}
            events={state.events}
            displayMode={state.displayMode}
            onDisplayModeChange={(mode) => {
              setState((prev) => ({ ...prev, displayMode: mode }));
            }}
            isRunning={state.isRunning}
            onSuggestedPrompt={(text) => handleSend(text)}
            contextLabel={projectName ? `CodeForge · ${projectName}${projectBranch ? ` · ${projectBranch}` : ""}` : undefined}
          />

          <ForgeWorkingIndicator active={forgeWorkActive} />

          {state.pendingApproval && (
            <ApprovalBar approval={state.pendingApproval} onApprove={approve} onDeny={() => approve("deny")} />
          )}
          {state.pendingQuestion && (
            <QuestionBar question={state.pendingQuestion} onAnswer={answerQuestion} />
          )}

          {state.workflowError && (
            <div className="workspace-error-banner" role="alert">
              <span className="workspace-error-icon" aria-hidden="true">⚠</span>
              <span className="workspace-error-text">{humanizeError(state.workflowError)}</span>
              <button
                type="button"
                className="workspace-error-dismiss"
                onClick={dismissWorkflowError}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}

          <Composer
            placeholder={placeholder}
            onSend={handleSend}
            onSteer={(msg) => handleSend(msg, true)}
            onStop={() => {
              const activeTurn = state.turns.find((t) => t.status === "running");
              if (activeTurn && state.session) stopTurn(state.session.id, activeTurn.id);
            }}
            onPause={() => {
              const activeTurn = state.turns.find((t) => t.status === "running");
              if (activeTurn && state.session) pauseTurn(state.session.id, activeTurn.id);
            }}
            onResume={() => {
              const pausedTurn = state.turns.find((t) => t.status === "paused");
              if (pausedTurn && state.session) resumeTurn(state.session.id, pausedTurn.id);
            }}
            onBackground={() => setState((prev) => ({ ...prev, leftNav: "agents" }))}
            isRunning={state.isRunning}
            isPaused={state.isPaused}
            models={models}
            selectedModelId={selectedModelId}
            onSelectModel={(model) => onSelectModel?.(model, state.session?.id)}
            onShowModelDetails={onShowModelDetails}
            onUpgradeNavigation={onUpgradeNavigation}
            modelSections={modelSections}
            executionMode={executionMode}
            onExecutionModeChange={handleExecutionModeChange}
          />
        </div>

        {!inspectorCollapsed && (
          <Inspector
            activeTab={state.activeTab}
            onTabSelect={(tab) => setState((prev) => ({ ...prev, activeTab: tab }))}
            session={state.session}
            workItems={state.workItems}
            turns={state.turns}
            events={state.events}
            isRunning={state.isRunning}
            workspacePath={state.session?.workspacePath}
            activeTaskId={state.activeTaskId}
            startFailure={startFailure}
          />
        )}
      </div>

      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}

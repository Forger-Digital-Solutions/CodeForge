import React, { useState, useCallback, useEffect, useRef } from "react";
import type { ExecutionMode, UserIntentHoldPolicy } from "@codeforge/protocol";
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

export interface Attachment {
  id: string;
  type: "file" | "image" | "folder";
  name: string;
  path?: string;
  content?: string;
  size?: number;
}

export interface WorkspaceAppProps {
  sseUrl?: string;
  onSendMessage?: (message: string, steer: boolean, executionMode: ExecutionMode, attachments?: Attachment[]) => void;
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
  userIntentHoldPolicy?: UserIntentHoldPolicy;
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
  userIntentHoldPolicy = "expensive_actions_only",
}: WorkspaceAppProps) {
  const { state, setState, sendMessage, requestUserIntentHold, approve, answerQuestion, stopTurn, pauseTurn, resumeTurn, cancelWorkflow, dismissWorkflowError, selectSession, startNewSession, hydrate } = useWorkspaceSSE(sseUrl ?? "/api/events");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem("codeforge:sidebar-collapsed") === "true"; } catch { return false; }
  });
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(() => readRememberedExecutionMode());
  const [showQuickActions, setShowQuickActions] = useState(false);

  React.useEffect(() => {
    try { window.localStorage.setItem("codeforge:sidebar-collapsed", String(sidebarCollapsed)); } catch { /* convenience preference */ }
  }, [sidebarCollapsed]);

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
      label: "New Task",
      description: "Start a new coding task",
      icon: "＋",
      action: startNewSession,
      shortcut: "Ctrl+N",
    },
    {
      id: "open-workspace",
      label: "Open Workspace",
      description: "Switch to a different project folder",
      icon: "📁",
      action: onOpenProjects ?? (() => {}),
      shortcut: "Ctrl+Shift+O",
    },
    {
      id: "search-sessions",
      label: "Search Sessions",
      description: "Find previous tasks and sessions",
      icon: "🔍",
      action: () => setShowQuickActions(true),
      shortcut: "Ctrl+K",
    },
    {
      id: "search-files",
      label: "Search Files",
      description: "Find files in the current workspace",
      icon: "📄",
      action: () => setState((prev) => ({ ...prev, leftNav: "files" })),
      shortcut: "Ctrl+P",
    },
    {
      id: "attach-file",
      label: "Attach File",
      description: "Add a file reference to the current task",
      icon: "📎",
      action: () => {},
      shortcut: "Ctrl+Shift+A",
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      description: "Show or hide the left navigation panel",
      icon: "☰",
      action: () => setSidebarCollapsed(!sidebarCollapsed),
      shortcut: "Ctrl+B",
    },
    {
      id: "toggle-inspector",
      label: "Toggle Inspector",
      description: "Show or hide the right details panel",
      icon: "🔍",
      action: () => setInspectorCollapsed(!inspectorCollapsed),
      shortcut: "Ctrl+Alt+B",
    },
    {
      id: "model-picker",
      label: "Model Picker",
      description: "Choose a model for the current task",
      icon: "🤖",
      action: () => {},
      shortcut: "Ctrl+M",
    },
    {
      id: "usage-billing",
      label: "Usage & Billing",
      description: "View your plan, credits, and usage",
      icon: "💳",
      action: () => onUpgradeNavigation?.(""),
      shortcut: "",
    },
    {
      id: "repository-intelligence",
      label: "Repository Intelligence",
      description: "View indexing status and settings",
      icon: "📊",
      action: () => {},
      shortcut: "",
    },
    {
      id: "permissions",
      label: "Permissions & Approvals",
      description: "Configure approval behavior",
      icon: "🔐",
      action: onOpenSettings ?? (() => {}),
      shortcut: "",
    },
    {
      id: "mcp-plugins",
      label: "MCP / Plugins",
      description: "Manage Model Context Protocol servers",
      icon: "🔌",
      action: onOpenSettings ?? (() => {}),
      shortcut: "",
    },
    {
      id: "settings",
      label: "Settings",
      description: "Open application settings",
      icon: "⚙",
      action: onOpenSettings ?? (() => {}),
      shortcut: "Ctrl+,",
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
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowQuickActions(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === "b") {
        e.preventDefault();
        setInspectorCollapsed(!inspectorCollapsed);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "m") {
        e.preventDefault();
        // Model picker focus - would need integration with ModelSelector
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        startNewSession();
      }
      if (e.key === "Escape") {
        setShowQuickActions(false);
        setPaletteOpen(false);
      }
    },
    [sidebarCollapsed, inspectorCollapsed, startNewSession]
  );

  React.useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  const handleSend = (message: string, attachments?: Attachment[]) => {
    const requestMode = executionMode;
    if (onSendMessage) {
      onSendMessage(message, false, requestMode, attachments);
    } else {
      sendMessage(message, false, requestMode);
    }
  };

  const handleSteer = (message: string, attachments?: Attachment[]) => {
    const requestMode = executionMode;
    if (onSendMessage) {
      onSendMessage(message, true, requestMode, attachments);
    } else {
      sendMessage(message, true, requestMode);
    }
  };

  const handleExecutionModeChange = (mode: ExecutionMode) => {
    setExecutionMode(mode);
    rememberExecutionMode(mode);
  };

  const placeholder = state.pendingApproval?.tool === "workflow"
    ? "Add context, or use the approval controls above…"
    : state.isRunning
      ? state.activePhase === "awaiting_approval"
        ? "Awaiting plan approval…"
        : "Steer the agent…"
      : state.pendingQuestion
        ? "Answer the agent..."
        : "Describe a task or ask about your code…";

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
            onNavigateFiles={() => setState((prev) => ({ ...prev, leftNav: "files" }))}
            onNavigateTasks={() => setState((prev) => ({ ...prev, leftNav: "tasks" }))}
            currentNavView={state.leftNav === "files" ? "files" : "tasks"}
          />
        )}

        <div className="workspace-center">
          <div className="workspace-toolbar">
            <button
              className="toolbar-btn toolbar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)"}
              aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!sidebarCollapsed}
            >
              ☰
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

            <div className="toolbar-spacer" />

            <div className="toolbar-group">
              {showQuickActions && (
                <CommandPalette
                  isOpen={showQuickActions}
                  onClose={() => setShowQuickActions(false)}
                  commands={commands}
                />
              )}
              <button
                className="toolbar-btn"
                onClick={() => setShowQuickActions(!showQuickActions)}
                title="Command Center (Ctrl+K)"
                aria-label="Command Center"
              >
                ⌕
              </button>
            </div>

            <button
              className="toolbar-btn toolbar-toggle"
              onClick={() => setInspectorCollapsed(!inspectorCollapsed)}
              title={inspectorCollapsed ? "Show inspector (Ctrl+Alt+B)" : "Hide inspector (Ctrl+Alt+B)"}
              aria-label={inspectorCollapsed ? "Show inspector" : "Hide inspector"}
              aria-expanded={!inspectorCollapsed}
            >
              🔍
            </button>
          </div>

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
            contextLabel={projectName ? `CodeForge · ${projectName}${projectBranch ?? state.session?.branch ? ` · ${projectBranch ?? state.session?.branch}` : ""}` : undefined}
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
            onSteer={handleSteer}
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
            executionState={state.executionState}
            onComposerActivity={(active) => {
              if (userIntentHoldPolicy !== "off" && (state.activeExecutionMode === "agent" || state.activeTaskId)) void requestUserIntentHold(active);
            }}
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

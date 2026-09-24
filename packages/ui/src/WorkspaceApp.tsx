import React, { useState, useCallback } from "react";
import type { ExecutionMode, UserIntentHoldPolicy } from "@codeforge/protocol";
import { readRememberedExecutionMode, rememberExecutionMode, useWorkspaceSSE } from "./workspace-sse.js";
import Header from "./Header.js";
import Navigation from "./Navigation.js";
import { dedupeSessionSummaries } from "./Navigation.js";
import Conversation from "./Conversation.js";
import Inspector from "./Inspector.js";
import Composer from "./Composer.js";
import ApprovalBar from "./ApprovalBar.js";
import QuestionBar from "./QuestionBar.js";
import CommandPalette, { type Command } from "./CommandPalette.js";
import WorkflowProgress from "./WorkflowProgress.js";
import { type ModelSelectorItem, type ModelSection } from "./ModelSelector.js";
import { ForgeWorkingIndicator } from "./activity-icons.js";

import { loadModelFavorites } from "./model-favorites.js";
import type { ActivityOverviewData, ActivityPeriod } from "./ActivityOverview.js";
import type { WorkspaceBriefData } from "./Conversation.js";
import "./workspace.css";
import { failureBannerLabel } from "./run-inspection.js";
export { humanizeError } from "./error-copy.js";

export interface SessionSummary {
  id: string;
  title?: string;
  taskTitle?: string;
  status?: string;
  /** How the last run ended ("route_exhausted", "verification_failed", …); refines `status`. */
  outcome?: string;
  updatedAt?: string;
  /** Repository the conversation is bound to; absent for sessions created before binding existed. */
  workspacePath?: string;
}

/**
 * Only this repository's conversations belong in this repository's task list. A task from another
 * project would read as continuable here, and continuing it is exactly what the runtime refuses
 * (WORKSPACE_MISMATCH). Sessions without a binding (pre-binding history) stay visible: the runtime
 * binds them to the active workspace on their next message.
 */
export function sessionsForWorkspace<T extends { workspacePath?: string }>(sessions: T[], activeWorkspacePath?: string): T[] {
  if (!activeWorkspacePath) return sessions;
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const active = normalize(activeWorkspacePath);
  return sessions.filter((session) => !session.workspacePath || normalize(session.workspacePath) === active);
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
  modelSelection?: { modelId: string; providerId?: string; canonicalModelId?: string };
  onSelectModel?: (model: ModelSelectorItem, sessionId?: string) => void;
  onShowModelDetails?: (model: ModelSelectorItem) => void;
  onUpgradeNavigation?: (url: string) => void;
  modelSections?: ModelSection[];
  projectName?: string;
  projectBranch?: string;
  /** Real signed-in display name; omit for a neutral greeting instead of guessing/hardcoding one. */
  userDisplayName?: string;
  workspacePath?: string;
  isGitRepo?: boolean;
  isDetached?: boolean;
  isWorktree?: boolean;
  /** Where the next turn will actually execute, e.g. "Local" / "Hosted". Real state, not invented. */
  runtimeLabel?: string;
  runtimeDetail?: string;
  /** Resolves a raw model id (e.g. "openrouter::nemotron") to its catalog display name. */
  resolveModelDisplayName?: (modelId: string) => string;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
  /** Deep-link target for settings sections (Agents, About, …) when the host has a Settings app. */
  onOpenSettingsSection?: (sectionId: string) => void;
  onOpenHelp?: () => void;
  userIntentHoldPolicy?: UserIntentHoldPolicy;
  /**
   * The persisted default task mode from the Settings app. When it changes while a workspace is
   * open, the composer follows it (the composer's own toggle remains the per-workspace control).
   */
  defaultExecutionMode?: ExecutionMode;
  workspaceBrief?: WorkspaceBriefData;
}

export default function WorkspaceApp({
  sseUrl,
  onSendMessage,
  models,
  selectedModelId,
  modelSelection,
  onSelectModel,
  onShowModelDetails,
  onUpgradeNavigation,
  modelSections,
  projectName,
  projectBranch,
  userDisplayName,
  workspacePath,
  resolveModelDisplayName,
  onOpenProjects,
  onOpenSettings,
  onOpenSettingsSection,
  onOpenHelp,
  userIntentHoldPolicy = "expensive_actions_only",
  defaultExecutionMode,
  workspaceBrief,
}: WorkspaceAppProps) {
  const { state, lifecycle, run, setState, sendMessage, setAuthority, requestUserIntentHold, approve, answerQuestion, stopTurn, pauseTurn, resumeTurn, cancelWorkflow, dismissWorkflowError, selectSession, startNewSession, hydrate } = useWorkspaceSSE(sseUrl ?? "/api/events");
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

  // "@" context references resolve through Repository Intelligence's live index.
  const searchContext = React.useCallback(async (query: string) => {
    if (!apiOrigin) return [];
    const res = await fetch(`${apiOrigin}/api/repository-index/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const page = (await res.json()) as { items?: Array<{ path: string; symbol?: { name?: string }; line?: number; reasons?: string[] }> };
    return (page.items ?? []).map((item) => ({
      path: item.path,
      symbol: item.symbol?.name,
      line: item.line,
      reason: item.reasons?.[0]?.replace(/_/g, " "),
    }));
  }, [apiOrigin]);

  // Real favorited model ids — same localStorage-backed source ModelSelector's star toggle
  // writes to (see model-favorites.ts). Re-synced whenever the picker closes, since that's when a
  // toggle inside it could have changed.
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(loadModelFavorites);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const favoriteModels = React.useMemo(
    () => (models ?? []).filter((m) => favoriteIds.has(m.id)),
    [models, favoriteIds],
  );

  const [activityOverview, setActivityOverview] = useState<ActivityOverviewData | null>(null);
  const [isActivityLoading, setIsActivityLoading] = useState(false);
  const [activityPeriod, setActivityPeriod] = useState<ActivityPeriod>("all");
  const refreshActivityOverview = useCallback(async (period: ActivityPeriod) => {
    if (!apiOrigin) return;
    setIsActivityLoading(true);
    try {
      const res = await fetch(`${apiOrigin}/api/activity/overview?period=${period}`);
      if (res.ok) setActivityOverview((await res.json()) as ActivityOverviewData);
    } catch {
      // server may still be starting — keep whatever we last had
    } finally {
      setIsActivityLoading(false);
    }
  }, [apiOrigin]);
  React.useEffect(() => {
    void refreshActivityOverview(activityPeriod);
  }, [refreshActivityOverview, activityPeriod, state.session?.id]);

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
      if (Array.isArray(data)) setSessions(dedupeSessionSummaries(sessionsForWorkspace(data, workspacePath)));
    } catch {
      // server may still be starting
    }
  }, [apiOrigin, workspacePath]);

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
      icon: "▣",
      action: onOpenProjects ?? (() => {}),
      shortcut: "Ctrl+Shift+O",
    },
    {
      id: "search-sessions",
      label: "Search Sessions",
      description: "Find previous tasks and sessions",
      icon: "⌕",
      action: () => setShowQuickActions(true),
      shortcut: "Ctrl+K",
    },
    {
      id: "search-files",
      label: "Search Files",
      description: "Find files in the current workspace",
      icon: "≡",
      action: () => setState((prev) => ({ ...prev, leftNav: "files" })),
      shortcut: "Ctrl+P",
    },
    {
      id: "attach-file",
      label: "Attach File",
      description: "Add a file reference to the current task",
      icon: "⎘",
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
      icon: "⌕",
      action: () => setInspectorCollapsed(!inspectorCollapsed),
      shortcut: "Ctrl+Alt+B",
    },
    {
      id: "model-picker",
      label: "Model Picker",
      description: "Choose a model for the current task",
      icon: "◈",
      action: () => {},
      shortcut: "Ctrl+M",
    },
    {
      id: "usage-billing",
      label: "Usage & Billing",
      description: "View your plan, credits, and usage",
      icon: "◆",
      action: () => onUpgradeNavigation?.(""),
      shortcut: "",
    },
    {
      id: "repository-intelligence",
      label: "Repository Intelligence",
      description: "View indexing status and settings",
      icon: "▤",
      action: () => {},
      shortcut: "",
    },
    {
      id: "permissions",
      label: "Permissions & Approvals",
      description: "Review approval and agent behavior settings",
      icon: "⚿",
      action: onOpenSettingsSection
        ? () => onOpenSettingsSection("agents")
        : onOpenSettings ?? (() => {}),
      shortcut: "",
    },
    {
      id: "settings",
      label: "Settings",
      description: "Open application settings",
      icon: "◎",
      action: onOpenSettingsSection
        ? () => onOpenSettingsSection("general")
        : onOpenSettings ?? (() => {}),
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

  // Text attachments go to the runtime with the message; the composer only produces text ones.
  const toSendAttachments = (attachments?: Attachment[]) =>
    (attachments ?? []).filter((a) => typeof a.content === "string" && a.type === "file").map((a) => ({ name: a.name, content: a.content as string, size: a.size }));

  const handleSend = (message: string, attachments?: Attachment[]) => {
    const requestMode = executionMode;
    if (onSendMessage) {
      onSendMessage(message, false, requestMode, attachments);
    } else {
      sendMessage(message, false, requestMode, { attachments: toSendAttachments(attachments), modelSelection });
    }
  };

  const handleSteer = (message: string, attachments?: Attachment[]) => {
    const requestMode = executionMode;
    if (onSendMessage) {
      onSendMessage(message, true, requestMode, attachments);
    } else {
      sendMessage(message, true, requestMode, { attachments: toSendAttachments(attachments) });
    }
  };

  const handleExecutionModeChange = (mode: ExecutionMode) => {
    setExecutionMode(mode);
    rememberExecutionMode(mode);
  };

  // A default-mode change from the Settings app reaches an open workspace through this prop.
  React.useEffect(() => {
    if (defaultExecutionMode) setExecutionMode(defaultExecutionMode);
  }, [defaultExecutionMode]);

  const placeholder = state.pendingApproval?.tool === "workflow" || run.composer === "approve"
    ? "Add context, or use the approval controls above…"
    : run.composer === "answer"
      ? "Answer the agent…"
      : run.composer === "resume"
        ? "Resume the task, or steer it…"
        : run.composer === "steer"
          ? "Steer the agent…"
          : "Describe a task or ask about your code…";

  const startFailureEvent = [...state.events].reverse().find((event) => event.type === "execution.start_failed");
  const startFailure = startFailureEvent?.type === "execution.start_failed"
    ? { code: startFailureEvent.payload.code, message: startFailureEvent.payload.message }
    : undefined;
  const forgeWorkActive = lifecycle.active && state.isEventStreamConnected;
  // Terminal task events arrive before the next session-list persistence poll. Keep the selected
  // row truthful during that short interval instead of leaving it labelled "Verifying" after the
  // main task surface has already reported completion. The overlay carries the outcome code too
  // so "No free route" is distinguishable from a plain failure.
  const activeSessionOverlay = lifecycle.terminal
    ? {
        status: lifecycle.state === "COMPLETED" ? "completed" : lifecycle.state === "CANCELLED" ? "cancelled" : lifecycle.state === "BLOCKED" ? "blocked" : "failed",
        outcome: lifecycle.reasonCode,
      }
    : undefined;
  // "Fix and continue" continues the same task: the server injects the previous
  // run's failure context and the session lease carries the authority — it is
  // never a fresh task asking for the same plan approval again.
  const repairFailure = () => {
    void sendMessage("Review the failure, fix the underlying issue, and rerun the relevant verification.", false, executionMode, { repair: true });
    dismissWorkflowError();
  };

  // Problem-centric failure detail: what actually failed beats workflow jargon.
  const failureDetail = React.useMemo(() => {
    const inspection = [...state.workItems].reverse().find((item) => item.kind === "run_inspection");
    if (!inspection || inspection.kind !== "run_inspection") return null;
    const attempt = inspection.verificationAttempts.at(-1);
    const failing = attempt?.verifiers.filter((v) => v.status === "failed" || v.status === "timed_out") ?? [];
    const verifierLines = failing.map((v) => v.failureSummary ?? `${v.command} — ${v.failed} failing`).filter(Boolean).slice(0, 3);
    const blockers = inspection.completion?.blockers.map((b) => b.message).slice(0, 3) ?? [];
    const repairs = inspection.repairs.length;
    return {
      status: inspection.status,
      verifierFailed: verifierLines.length > 0,
      lines: [...verifierLines, ...blockers],
      repairs,
      verification: attempt ? `${attempt.passed} passed · ${attempt.failed} failed` : undefined,
    };
  }, [state.workItems]);

  return (
    <div className="workspace">
      <div className="workspace-body">
        {!sidebarCollapsed && (
          <Navigation
            sessions={sessions}
            activeSessionId={state.session?.id ?? null}
            activeSessionStatus={activeSessionOverlay?.status}
            activeSessionOutcome={activeSessionOverlay?.outcome}
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
                run={run}
                runStartedAt={lifecycle.startedAt}
                onStop={() => {
                  // The lifecycle's activeTurnId is authoritative; the turn list is the fallback
                  // for a run whose executing turn has not been hydrated yet.
                  const targetTurnId = lifecycle.activeTurnId ?? state.turns.find((t) => t.status === "running")?.id;
                  if (targetTurnId && state.session) void stopTurn(state.session.id, targetTurnId);
                  else if (lifecycle.runId && state.session) void cancelWorkflow(lifecycle.runId);
                }}
                onPause={() => {
                  const targetTurnId = lifecycle.activeTurnId ?? state.turns.find((t) => t.status === "running")?.id;
                  if (targetTurnId && state.session) void pauseTurn(state.session.id, targetTurnId);
                }}
                onResume={() => {
                  const targetTurnId = lifecycle.interruptedTurnId ?? lifecycle.activeTurnId ?? state.turns.find((t) => t.status === "paused" || t.status === "recovering")?.id;
                  if (targetTurnId && state.session) void resumeTurn(state.session.id, targetTurnId);
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M10 2.5v11" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          </div>

          {(state.activeTaskId || state.isRunning || state.workflowError || state.lastWorkflowResult || state.pendingApproval?.tool === "workflow" || state.workItems.some((item) => item.kind === "change_delivery" || item.kind === "cloud_publication")) && (
            <div style={{ padding: "8px 12px" }}>
              <WorkflowProgress state={state} onPublishDelivery={publishDelivery} onRetryPublication={retryPublication} onAuthorizeRepository={authorizeRepository} />
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
            workspacePath={workspacePath ?? state.session?.workspacePath}
            userDisplayName={userDisplayName}
            activityOverview={activityOverview}
            isActivityLoading={isActivityLoading}
            activityPeriod={activityPeriod}
            onActivityPeriodChange={setActivityPeriod}
            resolveModelDisplayName={resolveModelDisplayName}
            favoriteModels={favoriteModels}
            onSelectModel={(model) => onSelectModel?.(model, state.session?.id)}
            onOpenModelPicker={() => setIsModelPickerOpen(true)}
            workspaceBrief={workspaceBrief}
          />

          <ForgeWorkingIndicator active={forgeWorkActive} />

          {state.pendingApproval && (
            <ApprovalBar approval={state.pendingApproval} onApprove={approve} onDeny={() => approve("deny")} />
          )}
          {state.pendingQuestion && (
            <QuestionBar question={state.pendingQuestion} onAnswer={answerQuestion} />
          )}

          {state.workflowError && (
            <div className={`task-failure-card ${failureDetail?.status === "blocked" ? "tone-blocked" : failureDetail?.status === "cancelled" ? "tone-stopped" : "tone-failed"}`} role="alert">
              <div className="task-failure-card-head">
                <div>
                  <div className="task-failure-kicker">
                    {failureBannerLabel(failureDetail?.status, failureDetail?.verifierFailed ?? false)}
                  </div>
                  <div className="task-failure-title">{state.session?.taskTitle ?? "Task"}</div>
                </div>
                <button type="button" className="workspace-error-dismiss" onClick={dismissWorkflowError} aria-label="Dismiss failure">×</button>
              </div>
              {failureDetail && failureDetail.lines.length > 0 ? (
                <div className="task-failure-message">
                  {failureDetail.lines.map((line, i) => <div key={i}>{line}</div>)}
                  {failureDetail.verification && <div className="task-failure-meta">{failureDetail.verification}</div>}
                  {failureDetail.repairs > 0 && <div className="task-failure-meta">CodeForge attempted {failureDetail.repairs} {failureDetail.repairs === 1 ? "repair" : "repairs"}.</div>}
                </div>
              ) : (
                <div className="task-failure-message">{state.workflowError}</div>
              )}
              <div className="task-failure-actions">
                <button type="button" className="btn-sm primary" onClick={repairFailure}>{failureDetail?.status === "cancelled" ? "Resume task" : "Fix and continue"}</button>
                <button type="button" className="btn-sm" onClick={() => setInspectorCollapsed(false)}>View details</button>
              </div>
            </div>
          )}

          <Composer
            placeholder={placeholder}
            onSend={handleSend}
            onSteer={handleSteer}
            onStop={() => {
              const targetTurnId = lifecycle.activeTurnId ?? state.turns.find((t) => t.status === "running")?.id;
              if (targetTurnId && state.session) void stopTurn(state.session.id, targetTurnId);
              else if (lifecycle.runId && state.session) void cancelWorkflow(lifecycle.runId);
            }}
            onPause={() => {
              const targetTurnId = lifecycle.activeTurnId ?? state.turns.find((t) => t.status === "running")?.id;
              if (targetTurnId && state.session) void pauseTurn(state.session.id, targetTurnId);
            }}
            onResume={() => {
              const targetTurnId = lifecycle.interruptedTurnId ?? lifecycle.activeTurnId ?? state.turns.find((t) => t.status === "paused" || t.status === "recovering")?.id;
              if (targetTurnId && state.session) void resumeTurn(state.session.id, targetTurnId);
            }}
            onBackground={() => setState((prev) => ({ ...prev, leftNav: "agents" }))}
            isRunning={state.isRunning}
            isPaused={state.isPaused}
            run={run}
            working={lifecycle.active}
            models={models}
            selectedModelId={selectedModelId}
            onSelectModel={(model) => onSelectModel?.(model, state.session?.id)}
            onShowModelDetails={onShowModelDetails}
            onUpgradeNavigation={onUpgradeNavigation}
            modelSections={modelSections}
            isModelPickerOpen={isModelPickerOpen}
            onModelPickerOpenChange={(open) => {
              setIsModelPickerOpen(open);
              if (!open) setFavoriteIds(loadModelFavorites());
            }}
            executionMode={executionMode}
            onExecutionModeChange={handleExecutionModeChange}
            authority={state.authority}
            onAuthorityChange={(modes) => { void setAuthority(modes); }}
            searchContext={apiOrigin ? searchContext : undefined}
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
            statusLabel={run.sidebarStatus}
            workspacePath={state.session?.workspacePath}
            activeTaskId={state.activeTaskId}
            startFailure={startFailure}
            apiBase={apiOrigin}
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

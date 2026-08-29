import React, { useState, useCallback } from "react";
import type { WorkspaceState } from "./workspace-sse.js";
import { useWorkspaceSSE } from "./workspace-sse.js";
import Header from "./Header.js";
import Navigation from "./Navigation.js";
import Conversation from "./Conversation.js";
import Inspector from "./Inspector.js";
import Composer from "./Composer.js";
import ApprovalBar from "./ApprovalBar.js";
import QuestionBar from "./QuestionBar.js";
import CommandPalette, { type Command } from "./CommandPalette.js";
import { type ModelSelectorItem } from "./ModelSelector.js";
import "./workspace.css";

export interface WorkspaceAppProps {
  sseUrl?: string;
  onSendMessage?: (message: string, steer: boolean) => void;
  models?: ModelSelectorItem[];
  selectedModelId?: string | null;
  onSelectModel?: (model: ModelSelectorItem) => void;
  onShowModelDetails?: (model: ModelSelectorItem) => void;
  onUpgradeNavigation?: (url: string) => void;
}

export default function WorkspaceApp({
  sseUrl,
  onSendMessage,
  models,
  selectedModelId,
  onSelectModel,
  onShowModelDetails,
  onUpgradeNavigation
}: WorkspaceAppProps) {
  const { state, setState, sendMessage, approve, answerQuestion, stopTurn, pauseTurn, resumeTurn, cancelWorkflow, dismissWorkflowError } = useWorkspaceSSE(sseUrl ?? "/api/events");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);

  const commands: Command[] = [
    {
      id: "new-session",
      label: "New Session",
      description: "Start a new coding session",
      icon: "＋",
      action: () => setState((prev) => ({ ...prev, session: null, turns: [], workItems: [], events: [] })),
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
    if (onSendMessage) {
      onSendMessage(message, steer);
    } else {
      sendMessage(message, steer);
    }
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

  return (
    <div className="workspace">
      <div className="workspace-body">
        {!sidebarCollapsed && (
          <Navigation
            active={state.leftNav}
            onSelect={(nav) => setState((prev) => ({ ...prev, leftNav: nav }))}
            workItems={state.workItems}
            onNewTask={() => setState((prev) => ({ ...prev, session: null, turns: [], workItems: [], events: [] }))}
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

          <Conversation
            turns={state.turns}
            workItems={state.workItems}
            displayMode={state.displayMode}
            onDisplayModeChange={(mode) => {
              setState((prev) => ({ ...prev, displayMode: mode }));
            }}
            isRunning={state.isRunning}
          />

          {state.pendingApproval && (
            <ApprovalBar approval={state.pendingApproval} onApprove={approve} onDeny={() => approve("deny")} />
          )}
          {state.pendingQuestion && (
            <QuestionBar question={state.pendingQuestion} onAnswer={answerQuestion} />
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
            onSelectModel={onSelectModel}
            onShowModelDetails={onShowModelDetails}
            onUpgradeNavigation={onUpgradeNavigation}
          />
        </div>

        {!inspectorCollapsed && (
          <Inspector
            activeTab={state.activeTab}
            onTabSelect={(tab) => setState((prev) => ({ ...prev, activeTab: tab }))}
            session={state.session}
            workItems={state.workItems}
            turns={state.turns}
            isRunning={state.isRunning}
            workspacePath={state.session?.workspacePath}
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

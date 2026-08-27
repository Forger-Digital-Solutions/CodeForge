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
import WorkflowProgress from "./WorkflowProgress.js";
import "./workspace.css";

export interface WorkspaceAppProps {
  sseUrl?: string;
  onSendMessage?: (message: string, steer: boolean) => void;
}

export default function WorkspaceApp({ sseUrl, onSendMessage }: WorkspaceAppProps) {
  const { state, setState, sendMessage, approve, answerQuestion, stopTurn, pauseTurn, resumeTurn, cancelWorkflow, dismissWorkflowError } = useWorkspaceSSE(sseUrl ?? "/api/events");
  const [paletteOpen, setPaletteOpen] = useState(false);

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
        // Stop the current running turn
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

  const showWorkflowProgress = Boolean(
    state.activeTaskId ||
      state.isRunning ||
      state.workflowError ||
      state.lastWorkflowResult ||
      state.pendingApproval?.tool === "workflow",
  );

  return (
    <div className="workspace">
      <Header
        session={state.session}
        agentStatus={state.agentStatus}
        isRunning={state.isRunning}
        isPaused={state.isPaused}
        displayMode={state.displayMode}
        onDisplayModeChange={(mode) => {
          setState((prev) => ({ ...prev, displayMode: mode }));
        }}
      />
      {showWorkflowProgress && (
        <WorkflowProgress state={state} onCancel={() => cancelWorkflow()} onApprove={approve} />
      )}
      {(state.workflowError || state.workflowActionError) && !showWorkflowProgress && (
        <div style={{ margin: "8px 12px", background: "#2b0e0e", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 10, padding: "10px 12px", fontSize: 12, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <span><strong>Workflow:</strong> {state.workflowError ?? state.workflowActionError}</span>
          <button className="work-item-btn" onClick={dismissWorkflowError}>Dismiss</button>
        </div>
      )}
      <div className="workspace-body">
        <Navigation active={state.leftNav} onSelect={(nav) => setState((prev) => ({ ...prev, leftNav: nav }))} workItems={state.workItems} />
        <Conversation
          turns={state.turns}
          workItems={state.workItems}
          displayMode={state.displayMode}
          onDisplayModeChange={(mode) => {
            setState((prev) => ({ ...prev, displayMode: mode }));
          }}
          isRunning={state.isRunning}
        />
        <Inspector
          activeTab={state.activeTab}
          onTabSelect={(tab) => setState((prev) => ({ ...prev, activeTab: tab }))}
          session={state.session}
          workItems={state.workItems}
          turns={state.turns}
          isRunning={state.isRunning}
          workspacePath={state.session?.workspacePath}
        />
      </div>
      {/* Non-workflow approvals still use the floating bar; workflow approvals are handled inside WorkflowProgress but we keep fallback for safety */}
      {state.pendingApproval && state.pendingApproval.tool !== "workflow" && (
        <ApprovalBar approval={state.pendingApproval} onApprove={approve} onDeny={() => approve("deny")} />
      )}
      {state.pendingApproval?.tool === "workflow" && !showWorkflowProgress && (
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
          // Stop the current running turn
          const activeTurn = state.turns.find((t) => t.status === "running");
          if (activeTurn && state.session) {
            stopTurn(state.session.id, activeTurn.id);
          }
        }}
        onPause={() => {
          // Pause the current running turn
          const activeTurn = state.turns.find((t) => t.status === "running");
          if (activeTurn && state.session) {
            pauseTurn(state.session.id, activeTurn.id);
          }
        }}
        onResume={() => {
          // Resume the current paused turn
          const pausedTurn = state.turns.find((t) => t.status === "paused");
          if (pausedTurn && state.session) {
            resumeTurn(state.session.id, pausedTurn.id);
          }
        }}
        onBackground={() => setState((prev) => ({ ...prev, leftNav: "agents" }))}
        isRunning={state.isRunning}
        isPaused={state.isPaused}
      />
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}

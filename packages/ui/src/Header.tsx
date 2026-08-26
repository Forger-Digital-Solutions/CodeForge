import React from "react";
import type { SessionRecord } from "@codeforge/sessions";
import type { SessionStatus } from "@codeforge/protocol";

interface HeaderProps {
  session: SessionRecord | null;
  agentStatus: SessionStatus;
  isRunning: boolean;
  isPaused: boolean;
  displayMode: string;
  onDisplayModeChange: (mode: "compact" | "detailed" | "debug") => void;
}

export default function Header({ session, agentStatus, isRunning, isPaused, displayMode, onDisplayModeChange }: HeaderProps) {
  const statusLabel: string = isRunning ? (isPaused ? "Paused" : "Running") : agentStatus === "failed" ? "Failed" : agentStatus === "completed" ? "Complete" : "Idle";
  const statusClass: string = isRunning ? (isPaused ? "paused" : "running") : agentStatus === "failed" ? "failed" : "idle";

  const sessionLabel: React.ReactNode = session ? <>{session.title}</> : null;
  const branchLabel: React.ReactNode = session?.branch ? <>{session.branch}</> : null;
  const agentLabel: React.ReactNode = session?.currentAgentId ? <>{session.currentAgentId}</> : null;
  const modelLabel: React.ReactNode = session?.currentModelId ? <>{session.currentModelId}</> : null;
  const permLabel: React.ReactNode = session?.permissionMode ? <>{session.permissionMode}</> : null;

  return (
    <header className="workspace-header">
      <div className="workspace-header-brand">
        <div className="logo">CF</div>
        <span>CodeForge</span>
      </div>
      <div className="workspace-header-meta">
        {session && (
          <>
            <div className="meta-item">
              <span className="label">Session</span>
              <span>{sessionLabel}</span>
            </div>
            {session.branch && (
              <div className="meta-item">
                <span className="label">Branch</span>
                <span>{branchLabel}</span>
              </div>
            )}
            {session.currentAgentId && (
              <div className="meta-item">
                <span className="label">Agent</span>
                <span>{agentLabel}</span>
              </div>
            )}
            {session.currentModelId && (
              <div className="meta-item">
                <span className="label">Model</span>
                <span>{modelLabel}</span>
              </div>
            )}
            {session.permissionMode && (
              <div className="meta-item">
                <span className="label">Permission</span>
                <span>{permLabel}</span>
              </div>
            )}
          </>
        )}
      </div>
      <div className="workspace-header-status">
        <div className={`status-dot ${statusClass}`} />
        <span>{statusLabel}</span>
        <select
          value={displayMode}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onDisplayModeChange(e.target.value as "compact" | "detailed" | "debug")}
          style={{
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            borderRadius: "var(--radius)",
            padding: "3px 8px",
            fontSize: "11px",
            fontFamily: "var(--font-sans)",
            cursor: "pointer",
          }}
        >
          <option value="compact">Compact</option>
          <option value="detailed">Detailed</option>
          <option value="debug">Debug</option>
        </select>
      </div>
    </header>
  );
}

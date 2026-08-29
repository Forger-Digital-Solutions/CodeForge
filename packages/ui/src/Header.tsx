import React, { useState, useEffect } from "react";
import type { SessionRecord } from "@codeforge/sessions";
import type { SessionStatus } from "@codeforge/protocol";

interface HeaderProps {
  session: SessionRecord | null;
  agentStatus: SessionStatus;
  isRunning: boolean;
  isPaused: boolean;
  activePhase?: string;
  workflowProgress?: number;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

export default function Header({
  session,
  agentStatus,
  isRunning,
  isPaused,
  activePhase,
  workflowProgress,
  onStop,
  onPause,
  onResume,
}: HeaderProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isRunning && !isPaused) {
      interval = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsed(0);
    }
    return () => clearInterval(interval);
  }, [isRunning, isPaused]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const statusDotClass = isRunning ? (isPaused ? "paused" : "running") : (agentStatus === "failed" ? "failed" : "idle");
  const phaseInfo = isRunning && activePhase ? ` · ${activePhase.replace(/_/g, " ")}` : "";
  const progressInfo = workflowProgress !== undefined ? ` · ${workflowProgress}%` : "";

  if (!session) return null;

  return (
    <div className="task-header">
      <span className="task-header-title">{session.taskTitle || session.title || "Active Task"}</span>
      <div className="task-header-status">
        <span className={`nav-status-dot ${statusDotClass}`} />
        <span>
          {isRunning ? (isPaused ? "Paused" : "Running") : agentStatus === "completed" ? "Completed" : "Idle"}
          {phaseInfo}
          {progressInfo}
        </span>
        {isRunning && !isPaused && <span style={{ fontFamily: "var(--cf-font-mono)" }}>{formatTime(elapsed)}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
        {isRunning && !isPaused && onPause && (
          <button type="button" className="task-header-btn" onClick={onPause}>
            Pause
          </button>
        )}
        {isRunning && isPaused && onResume && (
          <button type="button" className="task-header-btn" onClick={onResume}>
            Resume
          </button>
        )}
        {isRunning && onStop && (
          <button type="button" className="task-header-btn danger" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

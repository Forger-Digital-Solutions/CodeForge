import React, { useState, useEffect } from "react";
import type { SessionRecord } from "@codeforge/sessions";
import type { SessionStatus } from "@codeforge/protocol";
import type { RunPresentation, RunTone } from "./run-lifecycle.js";

interface HeaderProps {
  session: SessionRecord | null;
  agentStatus: SessionStatus;
  isRunning: boolean;
  isPaused: boolean;
  activePhase?: string;
  workflowProgress?: number;
  /**
   * The one canonical run projection. When present it is authoritative for the status word,
   * dot, timer and controls — the legacy fields above are ignored. Surfaces must never see a
   * combination the reducer did not produce ("Running · failed" is not representable).
   */
  run?: RunPresentation;
  /** Run start timestamp for the elapsed timer (lifecycle.startedAt). */
  runStartedAt?: string;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

const TONE_TO_DOT: Record<RunTone, string> = {
  idle: "idle",
  active: "running",
  waiting: "waiting",
  paused: "paused",
  success: "completed",
  danger: "failed",
  warning: "failed",
  muted: "idle",
};

export default function Header({
  session,
  agentStatus,
  isRunning,
  isPaused,
  activePhase,
  workflowProgress,
  run,
  runStartedAt,
  onStop,
  onPause,
  onResume,
}: HeaderProps) {
  const [elapsed, setElapsed] = useState(0);

  // Timer runs only while the canonical projection says time is accruing — a terminal state
  // stops the clock even if a stale flag somewhere still says "running".
  const timerActive = run ? run.timer : isRunning && !isPaused;
  const timerOrigin = runStartedAt ? Date.parse(runStartedAt) : null;

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (timerActive) {
      interval = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsed(0);
    }
    return () => clearInterval(interval);
  }, [timerActive]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const statusDotClass = run ? TONE_TO_DOT[run.tone] : isRunning ? (isPaused ? "paused" : "running") : (agentStatus === "failed" ? "failed" : "idle");
  const statusText = run
    ? `${run.label}${run.detail ? ` · ${run.detail}` : ""}`
    : `${isRunning ? (isPaused ? "Paused" : "Running") : agentStatus === "completed" ? "Completed" : "Idle"}${isRunning && activePhase ? ` · ${activePhase.replace(/_/g, " ")}` : ""}`;
  const elapsedShown = timerOrigin !== null ? Math.max(0, Math.floor((Date.now() - timerOrigin) / 1000)) : elapsed;
  // Workflow phases are authoritative; a raw percentage suggests precision the runtime does not claim.
  void workflowProgress;

  if (!session) return null;

  const showPause = run ? run.controls.pause && Boolean(onPause) : isRunning && !isPaused && Boolean(onPause);
  const showResume = run ? run.controls.resume && Boolean(onResume) : isRunning && isPaused && Boolean(onResume);
  const showStop = run ? run.controls.stop && Boolean(onStop) : isRunning && Boolean(onStop);

  return (
    <div className="task-header">
      <span className="task-header-title">{session.taskTitle || session.title || "Active Task"}</span>
      <div className="task-header-status">
        <span className={`nav-status-dot ${statusDotClass}`} />
        <span>{statusText}</span>
        {timerActive && <span style={{ fontFamily: "var(--cf-font-mono)" }}>{formatTime(elapsedShown)}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
        {showPause && (
          <button type="button" className="task-header-btn" onClick={onPause}>
            Pause
          </button>
        )}
        {showResume && (
          <button type="button" className="task-header-btn" onClick={onResume}>
            Resume
          </button>
        )}
        {showStop && (
          <button type="button" className="task-header-btn danger" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

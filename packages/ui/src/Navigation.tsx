import React from "react";
import type { WorkItem } from "@codeforge/sessions";

interface NavigationProps {
  active: string;
  onSelect: (nav: string) => void;
  workItems: WorkItem[];
  onNewTask?: () => void;
}

export default function Navigation({ active, onSelect, workItems, onNewTask }: NavigationProps) {
  const activeSessions = workItems.filter((w) => w.kind === "agent" && w.status === "working").length;
  const checkpoints = workItems.filter((w) => w.kind === "checkpoint").length;
  const pendingApprovals = workItems.filter((w) => w.kind === "approval" && !w.decision).length;

  return (
    <nav className="workspace-nav">
      <div className="nav-brand">
        <div className="nav-brand-logo" style={{ background: "transparent", overflow: "hidden", borderRadius: 4, border: "1px solid var(--cf-border)" }}>
          <svg width="20" height="20" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="128" cy="128" r="122" fill="#0a0b0d"/>
            <ellipse cx="128" cy="128" rx="108" ry="46" transform="rotate(-18 128 128)" fill="none" stroke="#b8bec7" strokeWidth="4.2"/>
            <ellipse cx="128" cy="128" rx="108" ry="40" transform="rotate(42 128 128)" fill="none" stroke="#b8bec7" strokeWidth="3.8" opacity="0.95"/>
            <ellipse cx="128" cy="128" rx="102" ry="36" transform="rotate(78 128 128)" fill="none" stroke="#a8adb5" strokeWidth="3.2" opacity="0.9"/>
            <path d="M128 56 L178 106 L128 118 L78 106 Z" fill="#dbe0e6"/>
            <path d="M78 106 L102 152 L128 204 L128 118 Z" fill="#5c6575"/>
            <path d="M178 106 L154 152 L128 204 L128 118 Z" fill="#9aa2af"/>
            <circle cx="192.5" cy="57.5" r="18" fill="#c2c6cd" stroke="#e8ecf0" strokeWidth="0.6"/>
            <circle cx="42.5" cy="130" r="16" fill="#c2c6cd" stroke="#e8ecf0" strokeWidth="0.6"/>
            <circle cx="196" cy="194" r="14" fill="#c2c6cd"/>
          </svg>
        </div>
        <span className="nav-brand-name">CodeForge</span>
      </div>

      <button className="nav-new-task" onClick={onNewTask}>
        + New Task
      </button>

      <div className="nav-scroll">
        <div className="nav-section">
          <div className="nav-section-title">Tasks</div>
          <button
            type="button"
            className={`nav-item ${active === "projects" ? "active" : ""}`}
            onClick={() => onSelect("projects")}
          >
            <span className="nav-icon">◈</span>
            <span className="nav-label">Projects</span>
          </button>
          <button
            type="button"
            className={`nav-item ${active === "sessions" ? "active" : ""}`}
            onClick={() => onSelect("sessions")}
          >
            <span className="nav-icon">◫</span>
            <span className="nav-label">Sessions</span>
            {pendingApprovals > 0 && <span className="nav-badge warning">{pendingApprovals}</span>}
          </button>
        </div>

        <div className="nav-section">
          <div className="nav-section-title">Workspace</div>
          <button
            type="button"
            className={`nav-item ${active === "agents" ? "active" : ""}`}
            onClick={() => onSelect("agents")}
          >
            <span className="nav-icon">●</span>
            <span className="nav-label">Agents</span>
            {activeSessions > 0 && <span className="nav-badge">{activeSessions}</span>}
          </button>
          <button
            type="button"
            className={`nav-item ${active === "checkpoints" ? "active" : ""}`}
            onClick={() => onSelect("checkpoints")}
          >
            <span className="nav-icon">◉</span>
            <span className="nav-label">Checkpoints</span>
            {checkpoints > 0 && <span className="nav-badge">{checkpoints}</span>}
          </button>
        </div>
      </div>

      <div className="nav-bottom">
        <button
          type="button"
          className={`nav-item ${active === "settings" ? "active" : ""}`}
          onClick={() => onSelect("settings")}
        >
          <span className="nav-icon">⚙</span>
          <span className="nav-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}

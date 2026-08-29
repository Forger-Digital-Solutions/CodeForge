import React from "react";
import type { WorkItem } from "@codeforge/sessions";

export interface NavSessionSummary {
  id: string;
  title?: string;
  taskTitle?: string;
  status?: string;
  updatedAt?: string;
}

interface NavigationProps {
  sessions: NavSessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  projectName?: string;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
  onOpenHelp?: () => void;
  workItems?: WorkItem[];
}

/** Compact CodeForge diamond/atom brand mark. */
function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="128" cy="128" r="124" fill="#0b0c0e" stroke="#3a3d44" strokeWidth="4" />
      <g fill="none" stroke="#aeb4bd" strokeWidth="5">
        <ellipse cx="128" cy="128" rx="104" ry="44" transform="rotate(-18 128 128)" />
        <ellipse cx="128" cy="128" rx="104" ry="40" transform="rotate(42 128 128)" opacity="0.9" />
        <ellipse cx="128" cy="128" rx="98" ry="36" transform="rotate(78 128 128)" opacity="0.8" />
      </g>
      <path d="M128 60 L174 106 L128 118 L82 106 Z" fill="#e6eaf0" />
      <path d="M82 106 L106 150 L128 200 L128 118 Z" fill="#6b7280" />
      <path d="M174 106 L150 150 L128 200 L128 118 Z" fill="#aeb4bd" />
      <circle cx="192" cy="60" r="15" fill="#c8ccd4" />
      <circle cx="46" cy="132" r="13" fill="#c8ccd4" />
      <circle cx="196" cy="196" r="11" fill="#aeb4bd" />
    </svg>
  );
}

const ICON = {
  plus: "M8 3.5v9M3.5 8h9",
  folder: "M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.2 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z",
  chat: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  settings: "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM8 1.6l1 1.6 1.9-.4.6 1.8 1.7.9-.5 1.9 1.2 1.5-1.2 1.5.5 1.9-1.7.9-.6 1.8-1.9-.4-1 1.6-1-1.6-1.9.4-.6-1.8-1.7-.9.5-1.9L1.6 8l1.2-1.5-.5-1.9 1.7-.9.6-1.8 1.9.4z",
  help: "M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13zM6.4 6.2a1.7 1.7 0 0 1 3.3.5c0 1.1-1.7 1.4-1.7 2.6M8 11.6h.01",
};

function NavIcon({ path, filled }: { path: string; filled?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={path} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill={filled ? "currentColor" : "none"} fillOpacity={filled ? 0.14 : 0} />
    </svg>
  );
}

export default function Navigation({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewTask,
  projectName,
  onOpenProjects,
  onOpenSettings,
  onOpenHelp,
}: NavigationProps) {
  const sortedSessions = [...sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return (
    <nav className="workspace-nav">
      <div className="nav-brand">
        <div className="nav-brand-logo">
          <BrandMark />
        </div>
        <span className="nav-brand-name">CodeForge</span>
      </div>

      <button type="button" className="nav-new-task" onClick={onNewTask}>
        <NavIcon path={ICON.plus} />
        <span>New task</span>
      </button>

      <div className="nav-scroll">
        {projectName && (
          <div className="nav-section">
            <div className="nav-section-title">Project</div>
            <button
              type="button"
              className="nav-item nav-project"
              onClick={onOpenProjects}
              title="Switch project"
            >
              <span className="nav-icon"><NavIcon path={ICON.folder} /></span>
              <span className="nav-label">{projectName}</span>
              <span className="nav-project-switch">Switch</span>
            </button>
          </div>
        )}

        <div className="nav-section">
          <div className="nav-section-title">Tasks</div>
          {sortedSessions.length === 0 ? (
            <div className="nav-empty">No tasks yet</div>
          ) : (
            sortedSessions.map((session) => {
              const label = session.taskTitle || session.title || session.id.slice(0, 8);
              const isActive = session.id === activeSessionId;
              const running = session.status === "running";
              return (
                <button
                  type="button"
                  key={session.id}
                  className={`nav-item nav-task ${isActive ? "active" : ""}`}
                  onClick={() => onSelectSession(session.id)}
                  title={label}
                >
                  <span className={`nav-task-dot ${running ? "running" : ""}`} />
                  <span className="nav-label">{label}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="nav-bottom">
        <button type="button" className="nav-item" onClick={onOpenSettings}>
          <span className="nav-icon"><NavIcon path={ICON.settings} /></span>
          <span className="nav-label">Settings</span>
        </button>
        <button type="button" className="nav-item" onClick={onOpenHelp}>
          <span className="nav-icon"><NavIcon path={ICON.help} /></span>
          <span className="nav-label">Help &amp; docs</span>
        </button>
      </div>
    </nav>
  );
}

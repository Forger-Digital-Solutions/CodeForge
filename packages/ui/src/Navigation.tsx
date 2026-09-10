import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WorkItem } from "@codeforge/sessions";

export interface NavSessionSummary {
  id: string;
  title?: string;
  taskTitle?: string;
  status?: string;
  updatedAt?: string;
}

export function formatRelativeSessionTime(value?: string, now = Date.now()): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type SessionGroupLabel = "Today" | "Yesterday" | "Previous 7 Days" | "Older";

export function groupSessionByAge(value: string | undefined, now = Date.now()): SessionGroupLabel {
  if (!value) return "Older";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Older";
  const age = Math.max(0, now - timestamp);
  if (age < 24 * 60 * 60 * 1000) return "Today";
  if (age < 2 * 24 * 60 * 60 * 1000) return "Yesterday";
  if (age < 7 * 24 * 60 * 60 * 1000) return "Previous 7 Days";
  return "Older";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const groupedSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const groups: Record<SessionGroupLabel, NavSessionSummary[]> = {
      Today: [], Yesterday: [], "Previous 7 Days": [], Older: [],
    };
    for (const session of [...sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
      const label = session.taskTitle || session.title || session.id.slice(0, 8);
      if (normalized && !`${label} ${session.status ?? ""}`.toLocaleLowerCase().includes(normalized)) continue;
      groups[groupSessionByAge(session.updatedAt)].push(session);
    }
    return groups;
  }, [query, sessions]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
    else setQuery("");
  }, [searchOpen]);

  const groupOrder: SessionGroupLabel[] = ["Today", "Yesterday", "Previous 7 Days", "Older"];

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
      <div className="nav-search-action">
        {searchOpen ? (
          <input
            ref={searchRef}
            type="search"
            className="nav-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); }}
            placeholder="Search tasks"
            aria-label="Search tasks"
          />
        ) : (
          <button type="button" className="nav-search-button" onClick={() => setSearchOpen(true)}>
            <span aria-hidden="true">⌕</span><span>Search</span><span className="nav-shortcut">Ctrl K</span>
          </button>
        )}
      </div>

      <div className="nav-scroll">
        {projectName && (
          <div className="nav-section">
            <div className="nav-section-title">Workspaces</div>
            <button
              type="button"
              className="nav-item nav-project"
              onClick={onOpenProjects}
              title="Switch project"
              aria-current="page"
            >
              <span className="nav-icon"><NavIcon path={ICON.folder} /></span>
              <span className="nav-label">{projectName}</span>
              <span className="nav-project-switch">Switch</span>
            </button>
          </div>
        )}

        <div className="nav-section nav-sessions-section">
          <div className="nav-section-title">Sessions</div>
          {sessions.length === 0 ? (
            <div className="nav-empty">No tasks yet</div>
          ) : (
            groupOrder.map((group) => groupedSessions[group].length > 0 ? (
              <div className="nav-session-group" key={group}>
                <div className="nav-group-label">{group}</div>
                {groupedSessions[group].map((session) => {
                  const label = session.taskTitle || session.title || session.id.slice(0, 8);
                  const isActive = session.id === activeSessionId;
                  const running = session.status === "running";
                  const relativeTime = formatRelativeSessionTime(session.updatedAt);
                  return (
                    <button
                      type="button"
                      key={session.id}
                      className={`nav-item nav-task ${isActive ? "active" : ""}`}
                      onClick={() => onSelectSession(session.id)}
                      title={label}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <span className={`nav-task-dot ${running ? "running" : ""}`} />
                      <span className="nav-task-copy">
                        <span className="nav-label">{label}</span>
                        <span className="nav-task-meta">{running ? "Working" : session.status ?? "Idle"}{relativeTime ? ` · ${relativeTime}` : ""}</span>
                      </span>
                      <span className="nav-task-menu" aria-hidden="true">…</span>
                    </button>
                  );
                })}
              </div>
            ) : null)
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

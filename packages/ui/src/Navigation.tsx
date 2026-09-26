import React, { useEffect, useMemo, useRef, useState } from "react";
import type { WorkItem } from "@codeforge/sessions";
import FileExplorer from "./FileExplorer.js";
import { presentSessionSummary, type RunTone } from "./run-lifecycle.js";

export interface NavSessionSummary {
  id: string;
  title?: string;
  taskTitle?: string;
  status?: string;
  /** How the last run ended ("route_exhausted", "verification_failed", …); refines `status`. */
  outcome?: string;
  updatedAt?: string;
}

/** A session is the user-visible task; retries and recovery remain inside it. */
export function dedupeSessionSummaries<T extends NavSessionSummary>(sessions: T[]): T[] {
  const unique = new Map<string, T>();
  for (const session of sessions) {
    const existing = unique.get(session.id);
    if (!existing || (session.updatedAt ?? "").localeCompare(existing.updatedAt ?? "") > 0) unique.set(session.id, session);
  }
  return [...unique.values()];
}

/** Apply a just-observed terminal outcome before the next persisted-session refresh arrives. */
export function overlayActiveSessionStatus<T extends NavSessionSummary>(
  sessions: T[],
  activeSessionId: string | null,
  activeSessionStatus?: string,
  activeSessionOutcome?: string,
): T[] {
  if (!activeSessionId || !activeSessionStatus) return sessions;
  return sessions.map((session) => session.id === activeSessionId ? { ...session, status: activeSessionStatus, ...(activeSessionOutcome ? { outcome: activeSessionOutcome } : {}) } : session);
}

/** Internal bootstrap prompts must never leak into task history. */
export function displaySessionTitle(session: NavSessionSummary): string {
  const title = (session.taskTitle || session.title || "").replace(/\s+/g, " ").trim();
  if (!title || /^(you are codeforge|you are an autonomous coding agent|system prompt)/i.test(title)) return "CodeForge task";
  return title;
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

/** Internal run states (phases, terminal enums) are not user vocabulary. Shares its wording with
 *  the canonical presentation (`presentSessionSummary`) so a sidebar row can never disagree with
 *  the header of the task it names. */
export function humanizeSessionStatus(status?: string): string {
  return presentSessionSummary({ status }).label;
}

/**
 * Retried tasks are distinct sessions but identical titles — a wall of same-titled rows reads as a
 * rendering bug. Cluster them under one expandable row; the runs inside stay individually visible
 * and selectable, ordered newest first.
 */
export function clusterSessionsByTitle<T extends NavSessionSummary>(sessions: T[]): T[][] {
  const byTitle = new Map<string, T[]>();
  for (const session of sessions) {
    const key = displaySessionTitle(session).toLocaleLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), session]);
  }
  return [...byTitle.values()];
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
  /** Terminal SSE state takes precedence over a briefly stale persisted session summary. */
  activeSessionStatus?: string;
  /** The live run's outcome code when it refines the overlaid status ("route_exhausted", …). */
  activeSessionOutcome?: string;
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  projectName?: string;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
  onOpenHelp?: () => void;
  workItems?: WorkItem[];
  onNavigateFiles?: () => void;
  onNavigateTasks?: () => void;
  currentNavView?: "tasks" | "files";
  /** Workspace root for the Files view — absent when no project is open. */
  workspacePath?: string;
  /** Server http origin for the file tree ("" when the document is served by the API). */
  apiBase?: string;
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
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
};

function NavIcon({ path, filled }: { path: string; filled?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={path} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill={filled ? "currentColor" : "none"} fillOpacity={filled ? 0.14 : 0} />
    </svg>
  );
}

/** One restrained glyph per presentation tone — historical rows stay quiet instead of
 *  accumulating a wall of loud failure markers. */
const TONE_TO_ICON: Record<RunTone, string> = {
  active: "●",
  waiting: "⏳",
  paused: "Ⅱ",
  success: "✓",
  danger: "✕",
  warning: "⚠",
  muted: "○",
  idle: "○",
};

export default function Navigation({
  sessions,
  activeSessionId,
  activeSessionStatus,
  activeSessionOutcome,
  onSelectSession,
  onNewTask,
  projectName,
  onOpenProjects,
  onOpenSettings,
  onOpenHelp,
  onNavigateFiles,
  onNavigateTasks,
  currentNavView = "tasks",
  workspacePath,
  apiBase = "",
}: NavigationProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const groupOrder: SessionGroupLabel[] = ["Today", "Yesterday", "Previous 7 Days", "Older"];
  const groupedSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const groups: Record<SessionGroupLabel, NavSessionSummary[]> = {
      Today: [], Yesterday: [], "Previous 7 Days": [], Older: [],
    };
    for (const session of [...overlayActiveSessionStatus(sessions, activeSessionId, activeSessionStatus, activeSessionOutcome)].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
      const label = displaySessionTitle(session);
      if (normalized && !`${label} ${session.status ?? ""}`.toLocaleLowerCase().includes(normalized)) continue;
      groups[groupSessionByAge(session.updatedAt)].push(session);
    }
    return groups;
  }, [query, sessions, activeSessionId, activeSessionStatus, activeSessionOutcome]);

  const clusterByTitle = useMemo(() => {
    const clusters: Record<SessionGroupLabel, NavSessionSummary[][]> = {
      Today: [], Yesterday: [], "Previous 7 Days": [], Older: [],
    };
    for (const group of groupOrder) {
      clusters[group] = clusterSessionsByTitle(groupedSessions[group]);
    }
    return clusters;
  }, [groupedSessions]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
    else setQuery("");
  }, [searchOpen]);

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
          <div className="nav-section-title">
            <div className="nav-view-toggle" role="tablist" aria-label="Navigation view">
              <button
                type="button"
                role="tab"
                aria-selected={currentNavView === "tasks"}
                onClick={onNavigateTasks}
                className={`nav-view-btn ${currentNavView === "tasks" ? "active" : ""}`}
              >
                Tasks
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentNavView === "files"}
                onClick={onNavigateFiles}
                className={`nav-view-btn ${currentNavView === "files" ? "active" : ""}`}
              >
                Files
              </button>
            </div>
          </div>

          {currentNavView === "tasks" ? (
            <>
              {sessions.length === 0 ? (
                <div className="nav-empty">No tasks yet</div>
              ) : (
                groupOrder.map((group) => groupedSessions[group].length > 0 ? (
                  <div className="nav-session-group" key={group}>
                    <div className="nav-group-label">{group}</div>
                    {clusterByTitle[group].map((cluster) => {
                      const renderRow = (session: NavSessionSummary, nested = false) => {
                        const label = displaySessionTitle(session);
                        const isActive = session.id === activeSessionId;
                        const summary = presentSessionSummary({ status: session.status, outcome: session.outcome });
                        const relativeTime = formatRelativeSessionTime(session.updatedAt);
                        return (
                          <button
                            type="button"
                            key={session.id}
                            className={`nav-item nav-task ${nested ? "nav-task-nested" : ""} ${isActive ? "active" : ""} status-${session.status ?? "idle"} tone-${summary.tone}`}
                            onClick={() => onSelectSession(session.id)}
                            title={label}
                            aria-current={isActive ? "page" : undefined}
                            aria-label={`${label} — ${summary.label}${relativeTime ? `, ${relativeTime}` : ""}`}
                          >
                            <span className={`nav-task-dot ${summary.tone === "active" ? "running" : ""}`} />
                            <span className="nav-task-copy">
                              <span className="nav-label">{label}</span>
                              <span className="nav-task-meta">{summary.label}{relativeTime ? ` · ${relativeTime}` : ""}</span>
                            </span>
                            <span className={`nav-task-status-icon tone-${summary.tone}`} title={summary.label} aria-hidden="true">{TONE_TO_ICON[summary.tone]}</span>
                          </button>
                        );
                      };

                      if (cluster.length === 1) return renderRow(cluster[0]!);

                      const latest = cluster[0]!;
                      const label = displaySessionTitle(latest);
                      const summary = presentSessionSummary({ status: latest.status, outcome: latest.outcome });
                      const groupKey = `${group}:${label.toLocaleLowerCase()}`;
                      const isOpen = expandedGroups.has(groupKey) || cluster.some((session) => session.id === activeSessionId);
                      return (
                        <div key={groupKey} className="nav-task-cluster">
                          <button
                            type="button"
                            className={`nav-item nav-task nav-task-cluster-head tone-${summary.tone}`}
                            onClick={() => setExpandedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(groupKey)) next.delete(groupKey);
                              else next.add(groupKey);
                              return next;
                            })}
                            title={`${label} — ${cluster.length} runs`}
                            aria-expanded={isOpen}
                            aria-label={`${label} — ${cluster.length} runs`}
                          >
                            <span className={`nav-task-dot ${summary.tone === "active" ? "running" : ""}`} />
                            <span className="nav-task-copy">
                              <span className="nav-label">{label}</span>
                              <span className="nav-task-meta">{summary.label} · {cluster.length} runs</span>
                            </span>
                            <span className="activity-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                          </button>
                          {isOpen && cluster.map((session) => renderRow(session, true))}
                        </div>
                      );
                    })}
                  </div>
                ) : null)
              )}
            </>
          ) : (
            <div className="nav-files-view">
              {workspacePath ? (
                <FileExplorer rootPath={workspacePath} apiBase={apiBase} />
              ) : (
                <div className="nav-empty" style={{ padding: "16px", textAlign: "center", color: "var(--cf-text-muted)" }}>
                  Open a project to browse its files
                </div>
              )}
            </div>
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
          <span className="nav-label">Help & docs</span>
        </button>
      </div>
    </nav>
  );
}

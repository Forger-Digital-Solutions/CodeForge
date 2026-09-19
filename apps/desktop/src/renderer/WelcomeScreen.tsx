import React from "react";
import type { Project } from "./App.js";

interface WelcomeScreenProps {
  recentProjects: Project[];
  onOpenProject: (path?: string) => void;
  onCreateProject: () => void;
  onRemoveRecent: (path: string) => void;
  loading: boolean;
  error: string | null;
}

function FolderGlyph(): React.ReactElement {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12v-7.5Z" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PlusGlyph(): React.ReactElement {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.2 4.8 9 10 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Compact human delta for the launcher list — intentionally coarse (folders, not feeds). */
export function formatLastOpened(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

export default function WelcomeScreen({
  recentProjects,
  onOpenProject,
  onCreateProject,
  onRemoveRecent,
  loading,
  error,
}: WelcomeScreenProps) {
  return (
    <div className="welcome">
      <div className="welcome-container">
        <div className="welcome-header">
          <div className="welcome-logo">
            <svg width="80" height="80" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CodeForge">
              <defs>
                <radialGradient id="ws-bg" cx="50%" cy="50%" r="68%"><stop offset="0%" stopColor="#1e1f24"/><stop offset="100%" stopColor="#0a0b0d"/></radialGradient>
                <linearGradient id="ws-rim" x1="8%" y1="8%" x2="92%" y2="92%"><stop offset="0%" stopColor="#f1f2f4"/><stop offset="42%" stopColor="#a8adb5"/><stop offset="100%" stopColor="#7d828a"/></linearGradient>
                <linearGradient id="ws-orbit" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#e6e8ec"/><stop offset="100%" stopColor="#8b9099"/></linearGradient>
                <radialGradient id="ws-d-top" cx="32%" cy="22%" r="85%"><stop offset="0%" stopColor="#ffffff"/><stop offset="60%" stopColor="#9aa2af"/><stop offset="100%" stopColor="#5c6575"/></radialGradient>
                <radialGradient id="ws-d-left" cx="20%" cy="35%" r="90%"><stop offset="0%" stopColor="#f2f4f7"/><stop offset="100%" stopColor="#3e4552"/></radialGradient>
                <radialGradient id="ws-d-right" cx="78%" cy="30%" r="90%"><stop offset="0%" stopColor="#ffffff"/><stop offset="100%" stopColor="#4a5261"/></radialGradient>
                <radialGradient id="ws-sphere" cx="32%" cy="28%" r="75%"><stop offset="0%" stopColor="#ffffff"/><stop offset="48%" stopColor="#a9b0bc"/><stop offset="100%" stopColor="#5a6474"/></radialGradient>
              </defs>
              <circle cx="128" cy="128" r="127" fill="none" stroke="url(#ws-rim)" strokeWidth="3"/>
              <circle cx="128" cy="128" r="122" fill="url(#ws-bg)"/>
              <circle cx="128" cy="128" r="98" fill="none" stroke="#2e2f35" strokeWidth="0.7" opacity="0.35"/>
              <ellipse cx="128" cy="128" rx="108" ry="46" transform="rotate(-18 128 128)" fill="none" stroke="url(#ws-orbit)" strokeWidth="4.2"/>
              <ellipse cx="128" cy="128" rx="108" ry="40" transform="rotate(42 128 128)" fill="none" stroke="url(#ws-orbit)" strokeWidth="3.8" opacity="0.95"/>
              <ellipse cx="128" cy="128" rx="102" ry="36" transform="rotate(78 128 128)" fill="none" stroke="#a8adb5" strokeWidth="3.2" opacity="0.9"/>
              <path d="M128 56 L178 106 L128 118 L78 106 Z" fill="url(#ws-d-top)"/>
              <path d="M78 106 L128 118 L102 152 L78 106" fill="#8f99ab"/>
              <path d="M78 106 L102 152 L128 204 L128 118 Z" fill="url(#ws-d-left)"/>
              <path d="M178 106 L128 118 L154 152 L178 106" fill="#b8c0ce"/>
              <path d="M178 106 L154 152 L128 204 L128 118 Z" fill="url(#ws-d-right)"/>
              <path d="M128 118 L154 152 L128 204 Z" fill="#e8ecf2" opacity="0.96"/>
              <circle cx="192.5" cy="57.5" r="20" fill="url(#ws-sphere)" stroke="#d6dae0" strokeWidth="0.7"/>
              <circle cx="42.5" cy="130.5" r="19.2" fill="url(#ws-sphere)" stroke="#d6dae0" strokeWidth="0.7"/>
              <circle cx="196.2" cy="194.2" r="15.8" fill="url(#ws-sphere)" stroke="#d6dae0" strokeWidth="0.6"/>
              <circle cx="77.8" cy="76.2" r="7.8" fill="url(#ws-sphere)" stroke="#c2c6cd" strokeWidth="0.5"/>
            </svg>
          </div>
          <h1 className="welcome-title">Welcome to CodeForge</h1>
          <p className="welcome-subtitle">What are we building today?</p>

          <p className="welcome-context-note">Open an existing project or create a new workspace to get started.</p>
        </div>

        {error && (
          <div className="welcome-error">
            {error}
          </div>
        )}

        <div className="welcome-actions">
          <button
            className="welcome-btn primary"
            onClick={() => onOpenProject()}
            disabled={loading}
          >
            <FolderGlyph />
            <span>Open project folder</span>
          </button>
          <button
            className="welcome-btn secondary"
            onClick={onCreateProject}
            disabled={loading}
            title="Pick a location and create a new, empty project folder"
          >
            <PlusGlyph />
            <span>Create new project</span>
          </button>
        </div>

        {recentProjects.length > 0 && (
          <div className="welcome-recent">
            <h3 className="welcome-recent-title">Recent projects</h3>
            <ul className="welcome-recent-list">
              {recentProjects.slice(0, 5).map((project) => {
                const stale = project.exists === false;
                const lastOpened = formatLastOpened(project.lastOpened);
                return (
                  <li key={project.id}>
                    <div className={`welcome-recent-row${stale ? " stale" : ""}`}>
                      <button
                        className="welcome-recent-item"
                        onClick={() => onOpenProject(project.path)}
                        disabled={loading}
                        title={stale ? "This folder no longer exists at this path" : project.path}
                      >
                        <span className="recent-icon" aria-hidden="true"><FolderGlyph /></span>
                        <div className="recent-info">
                          <span className="recent-name">
                            {project.name}
                            {stale && <span className="recent-stale-badge">folder not found</span>}
                          </span>
                          <span className="recent-path">
                            {project.path}
                            {lastOpened && <span className="recent-time">{stale ? "" : ` · ${lastOpened}`}</span>}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="recent-remove"
                        aria-label={`Remove ${project.name} from recent projects`}
                        title={stale ? "Remove missing folder from the list" : "Remove from recent projects"}
                        onClick={() => onRemoveRecent(project.path)}
                        disabled={loading}
                      >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                          <path d="M1.5 1.5 9.5 9.5M9.5 1.5 1.5 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="welcome-benefits">
          <span className="welcome-benefit"><CheckGlyph />Free AI models included</span>
          <span className="welcome-benefit"><CheckGlyph />No API key required</span>
          <span className="welcome-benefit"><CheckGlyph />Changes verified before completion</span>
        </div>
      </div>
    </div>
  );
}

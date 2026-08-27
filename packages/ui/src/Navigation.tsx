import React from "react";
import type { WorkItem } from "@codeforge/sessions";

interface NavigationProps {
  active: string;
  onSelect: (nav: string) => void;
  workItems: WorkItem[];
}

export default function Navigation({ active, onSelect, workItems }: NavigationProps) {
  const activeSessions = workItems.filter((w) => w.kind === "agent" && w.status === "working").length;
  const checkpoints = workItems.filter((w) => w.kind === "checkpoint").length;
  const artifacts = workItems.filter((w) => w.kind === "artifact").length;
  const pendingApprovals = workItems.filter((w) => w.kind === "approval" && !w.decision).length;

  const navItems = [
    { id: "projects", label: "Projects", icon: "◈" },
    { id: "sessions", label: "Sessions", icon: "◫" },
    { id: "agents", label: "Agents", icon: "●", badge: activeSessions > 0 ? String(activeSessions) : undefined },
    { id: "checkpoints", label: "Checkpoints", icon: "◉", badge: checkpoints > 0 ? String(checkpoints) : undefined },
    { id: "artifacts", label: "Artifacts", icon: "◆", badge: artifacts > 0 ? String(artifacts) : undefined },
  ];

  return (
    <nav className="workspace-nav scrollbar-thin">
      <div className="workspace-nav-section">
        <div className="workspace-nav-section-title">Workspace</div>
        {navItems.map((item) => (
          <div
            key={item.id}
            className={`workspace-nav-item ${active === item.id ? "active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </div>
        ))}
      </div>
      {pendingApprovals > 0 && (
        <div className="workspace-nav-section">
          <div className="workspace-nav-section-title" style={{ color: "var(--warning)" }}>Pending</div>
          <div className="workspace-nav-item" onClick={() => onSelect("sessions")}>
            <span className="nav-icon">⚠</span>
            <span>Approvals</span>
            <span className="nav-badge" style={{ color: "var(--warning)" }}>{pendingApprovals}</span>
          </div>
        </div>
      )}
      <div className="workspace-nav-section" style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <div className="workspace-nav-section-title">Display</div>
        <div className="workspace-nav-item" onClick={() => onSelect("settings")}>
          <span className="nav-icon">⚙</span>
          <span>Settings</span>
        </div>
      </div>
    </nav>
  );
}

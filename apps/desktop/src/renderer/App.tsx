import React, { useState, useEffect } from "react";
import WelcomeScreen from "./WelcomeScreen.js";
import WorkspaceShell from "./WorkspaceShell.js";

declare global {
  interface Window {
    electronAPI?: {
      selectDirectory: () => Promise<string | null>;
      getRecentProjects: () => Promise<Array<{ id: string; path: string; name: string; lastOpened: string }>>;
      openProject: (path: string) => Promise<{ id: string; path: string; name: string; lastOpened: string }>;
      createProject: () => Promise<{ id: string; path: string; name: string; lastOpened: string } | null>;
      openExternal: (url: string) => Promise<void>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
    };
  }
}

export interface Project {
  id: string;
  path: string;
  name: string;
  lastOpened: string;
}

export default function App() {
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRecentProjects();
  }, []);

  const loadRecentProjects = async () => {
    if (window.electronAPI) {
      try {
        const recent = await window.electronAPI.getRecentProjects();
        setRecentProjects(recent);
      } catch {
        // ignore
      }
    }
  };

  const handleOpenProject = async (projectPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      let project: Project | null = null;
      if (projectPath) {
        project = await window.electronAPI!.openProject(projectPath);
      } else {
        project = await window.electronAPI!.selectDirectory();
        if (project) {
          project = await window.electronAPI!.openProject(project);
        }
      }
      if (project) {
        setCurrentProject(project);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open project");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = async () => {
    setLoading(true);
    setError(null);
    try {
      const project = await window.electronAPI!.createProject();
      if (project) {
        setCurrentProject(project);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  };

  const handleCloseProject = () => {
    setCurrentProject(null);
    loadRecentProjects();
  };

  if (currentProject) {
    return (
      <WorkspaceShell
        project={currentProject}
        onClose={handleCloseProject}
      />
    );
  }

  return (
    <WelcomeScreen
      recentProjects={recentProjects}
      onOpenProject={handleOpenProject}
      onCreateProject={handleCreateProject}
      loading={loading}
      error={error}
    />
  );
}

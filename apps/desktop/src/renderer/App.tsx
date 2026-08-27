import React, { useState, useEffect } from "react";
import WelcomeScreen from "./WelcomeScreen.js";
import WorkspaceShell from "./WorkspaceShell.js";

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
    loadRecentProjects(true);
  }, []);

  const loadRecentProjects = async (restoreMostRecent = false) => {
    if (window.electronAPI) {
      try {
        const recent = await window.electronAPI.getRecentProjects();
        setRecentProjects(recent);
        if (restoreMostRecent && recent[0]) {
          await window.electronAPI.openProject(recent[0].path);
          setCurrentProject(recent[0]);
        }
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
        const selectedPath = await window.electronAPI!.selectDirectory();
        if (selectedPath) {
          project = await window.electronAPI!.openProject(selectedPath);
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
    loadRecentProjects(false);
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

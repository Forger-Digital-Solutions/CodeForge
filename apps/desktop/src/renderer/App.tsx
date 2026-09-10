import React, { useState, useEffect } from "react";
import AuthScreen from "./AuthScreen.js";
import CloseDialog, { type CloseRequest } from "./CloseDialog.js";
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
  const [authState, setAuthState] = useState<"loading" | "signed-out" | "authenticated">("loading");

  const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCloseRequested?.((request) => {
      if (request && typeof request === "object") setCloseRequest(request as CloseRequest);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    const restore = async (): Promise<void> => {
      if (!window.electronAPI?.getCloudAccount) {
        if (mounted) setAuthState("authenticated");
        return;
      }
      try {
        const account = await window.electronAPI.getCloudAccount();
        if (!mounted) return;
        if (!account) {
          setAuthState("signed-out");
          return;
        }
        setAuthState("authenticated");
        await loadRecentProjects(true);
      } catch {
        if (mounted) setAuthState("signed-out");
      }
    };
    void restore();
    return () => { mounted = false; };
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

  const handleAuthenticated = async (): Promise<void> => {
    setAuthState("authenticated");
    await loadRecentProjects(true);
  };

  const handleSignedOut = (): void => {
    setCurrentProject(null);
    setRecentProjects([]);
    setAuthState("signed-out");
  };

  const handleCloseDecision = async (decision: "cancel" | "tray" | "quit" | "quit-anyway", remember: boolean): Promise<void> => {
    setCloseRequest(null);
    await window.electronAPI?.resolveClose?.(decision, remember);
  };

  const closeOverlay = closeRequest ? <CloseDialog request={closeRequest} onDecision={(decision, remember) => void handleCloseDecision(decision, remember)} /> : null;

  if (authState === "loading") {
    return <><div className="app-bootstrap" role="status" aria-live="polite"><span className="app-bootstrap-mark">◆</span><span>Restoring your CodeForge session…</span></div>{closeOverlay}</>;
  }

  if (authState === "signed-out") {
    return <><AuthScreen onAuthenticated={() => void handleAuthenticated()} />{closeOverlay}</>;
  }

  if (currentProject) {
    return (
      <>
      <WorkspaceShell
        project={currentProject}
        onClose={handleCloseProject}
        onSignedOut={handleSignedOut}
      />
      {closeOverlay}
      </>
    );
  }

  return (
    <>
      <WelcomeScreen
        recentProjects={recentProjects}
        onOpenProject={handleOpenProject}
        onCreateProject={handleCreateProject}
        loading={loading}
        error={error}
      />
      {closeOverlay}
    </>
  );
}

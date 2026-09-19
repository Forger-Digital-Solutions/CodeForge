import React, { useState, useEffect } from "react";
import AuthScreen from "./AuthScreen.js";
import CloseDialog, { type CloseRequest } from "./CloseDialog.js";
import WelcomeScreen from "./WelcomeScreen.js";
import WorkspaceShell from "./WorkspaceShell.js";
import { migrateLegacyAppSettings, type AppSettings, type SettingsSnapshot } from "../app-settings.js";
import { markRendererLifecycle } from "./lifecycle.js";

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
    // The root has committed; the next animation frame is the first one that can show it.
    markRendererLifecycle("root-mounted");
    requestAnimationFrame(() => markRendererLifecycle("first-frame"));
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCloseRequested?.((request) => {
      if (request && typeof request === "object") setCloseRequest(request as CloseRequest);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    const restore = async (): Promise<void> => {
      // Load the canonical settings before deciding what to restore. On the first run with the
      // canonical store absent, seed it from the pre-canonical renderer-local preference exactly
      // once (a fresh store is reported by the main process; later launches never migrate).
      let startupSettings: AppSettings | undefined;
      try {
        if (window.electronAPI?.getSettings) {
          const snapshot = await window.electronAPI.getSettings() as SettingsSnapshot;
          if (snapshot.fresh) {
            const patch = migrateLegacyAppSettings(
              window.localStorage.getItem("codeforge:user-intent-hold-policy"),
              window.localStorage.getItem("codeforge:execution-mode"),
            );
            if (patch) {
              await window.electronAPI.updateSettings?.({ settings: patch });
              // The canonical store is now the single authority. The legacy renderer key carried
              // no secret, but retaining it would make a future migration ambiguous.
              window.localStorage.removeItem("codeforge:execution-mode");
            }
          }
          startupSettings = snapshot.settings;
        }
      } catch {}

      if (!mounted) return;
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
        const openLastWorkspace = startupSettings?.general.openLastWorkspaceOnStartup !== false;
        await loadRecentProjects(openLastWorkspace);
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
        onOpenProjectPath={handleOpenProject}
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

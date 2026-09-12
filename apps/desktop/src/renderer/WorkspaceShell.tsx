import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { WorkspaceApp, type ModelSection } from "@codeforge/ui";
import type { Project } from "./App.js";
import type { ModelSelectorItem } from "@codeforge/ui";
import ModelDetails from "./ModelDetails.js";
import { accessBadge, buildModelSections, isHiddenModel, resolveForgeZeroTrust, resolveRuntimeLabel, type ApiModel } from "./model-sections.js";
import { classifyGitWorkspace, GIT_WORKSPACE_INFO_ARGS, type GitWorkspaceInfo } from "./git-workspace-info.js";
import SettingsApp from "./settings/SettingsApp.js";
import type { SettingsContextValue, CloudAccountView, SystemInfoView, DesktopRuntimeStatus, RepositoryIndexStatus } from "./settings/settings-context.js";
import { computeWorkNotifications, type RunningCounters } from "./settings/notifications-client.js";
import { describeHeaderActivity, summarizeActiveWork } from "../close-lifecycle.js";
import type { AppSettings, AppSettingsPatch, CloseBehavior, ExecutionMode, SettingsSnapshot } from "../app-settings.js";

const SERVER_BASE_URL = "http://localhost:3210";
const HELP_URL = "https://github.com/Forger-Digital-Solutions/CodeForge#readme";
const EXECUTION_MODE_KEY = "codeforge:execution-mode";
const DEFAULT_MODEL_ZOOM: Record<AppSettings["appearance"]["chatTextScale"], number> = {
  small: 0.9,
  medium: 1,
  large: 1.15,
};

interface WorkspaceShellProps {
  project: Project;
  onClose: () => void;
  onSignedOut?: () => void;
  onOpenProjectPath?: (projectPath: string) => Promise<void>;
}

export default function WorkspaceShell({ project, onClose, onSignedOut, onOpenProjectPath }: WorkspaceShellProps) {
  const [models, setModels] = useState<ModelSelectorItem[]>([
    { id: "auto", displayName: "ForgeAuto/Free", tier: "free", description: "Automatic free routing" },
  ]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>("auto");
  const [modelProviders, setModelProviders] = useState<Record<string, string>>({});
  const [apiModels, setApiModels] = useState<ApiModel[]>([]);
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [selectedModelForDetails, setSelectedModelForDetails] = useState<ApiModel | null>(null);
  const [providerStatus, setProviderStatus] = useState<Record<string, { status: string; error?: string }>>({});
  const [isForgeZeroOpen, setIsForgeZeroOpen] = useState(false);
  /** Deep-linked settings view: null = workspace, otherwise a settings section id. */
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [isRepoIntelligenceOpen, setIsRepoIntelligenceOpen] = useState(false);
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null);
  const [cloudAccount, setCloudAccount] = useState<CloudAccountView | null>(null);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [repositoryIndex, setRepositoryIndex] = useState<RepositoryIndexStatus>({ state: "NOT_INDEXED" });
  const [gitInfo, setGitInfo] = useState<GitWorkspaceInfo>({ isGitRepo: false, branch: null, isDetached: false, isWorktree: false });
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfoView | null>(null);
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [catalogLastCheckedAt, setCatalogLastCheckedAt] = useState<number | null>(null);
  const [defaultExecutionMode, setDefaultExecutionModeState] = useState<ExecutionMode>(() => {
    const value = window.localStorage.getItem(EXECUTION_MODE_KEY);
    return value === "chat" ? "chat" : "agent";
  });
  const appliedDefaultModelRef = useRef(false);
  const notificationPrefsRef = useRef<AppSettings["notifications"] | null>(null);
  const previousCountersRef = useRef<RunningCounters | null>(null);

  const loadCloudAccount = useCallback(async () => {
    try {
      if (window.electronAPI?.getCloudAccount) {
        const acc = await window.electronAPI.getCloudAccount();
        setCloudAccount(acc);
      }
    } catch {}
  }, []);

  const loadRecentProjects = useCallback(async () => {
    try {
      if (window.electronAPI?.getRecentProjects) setRecentProjects(await window.electronAPI.getRecentProjects());
    } catch {}
  }, []);

  useEffect(() => {
    fetch(`${SERVER_BASE_URL}/api/workspace/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project.path }),
    }).catch(() => {});
    void loadCloudAccount();
    void loadRecentProjects();
    // Single canonical git read: branch + worktree status come from ONE `git rev-parse`
    // invocation so the header, composer context bar, and Settings can never disagree
    // about what Git state this workspace is in.
    const loadGitInfo = async () => {
      try {
        if (window.electronAPI?.execCommand) {
          const result = await window.electronAPI.execCommand({
            command: "git",
            args: GIT_WORKSPACE_INFO_ARGS,
            cwd: project.path,
          });
          setGitInfo(classifyGitWorkspace(result.exitCode, result.stdout ?? ""));
        }
      } catch {
        setGitInfo({ isGitRepo: false, branch: null, isDetached: false, isWorktree: false });
      }
    };
    void loadGitInfo();
  }, [project.path, loadCloudAccount, loadRecentProjects]);

  // Canonical settings load. The renderer never invents settings values: everything it shows
  // comes from the validated store in the main process.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!window.electronAPI?.getSettings) return;
        const snapshot = await window.electronAPI.getSettings() as SettingsSnapshot;
        if (active) setSettingsSnapshot(snapshot);
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (window.electronAPI?.getSystemInfo) {
      void window.electronAPI.getSystemInfo().then((info) => setSystemInfo(info as SystemInfoView)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refreshIndex = async () => {
      try {
        const response = await fetch(`${SERVER_BASE_URL}/api/repository-index/status`);
        if (response.ok && active) setRepositoryIndex(await response.json() as RepositoryIndexStatus);
      } catch {}
    };
    void refreshIndex();
    const interval = setInterval(refreshIndex, repositoryIndex.state === "INDEXING" ? 1000 : 5000);
    return () => { active = false; clearInterval(interval); };
  }, [project.path, repositoryIndex.state]);

  const setRepositoryIndexEnabled = async (enabled: boolean) => {
    const response = await fetch(`${SERVER_BASE_URL}/api/repository-index/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (response.ok) {
      setRepositoryIndex((current) => ({ ...current, enabled, state: enabled ? "INDEXING" : "NOT_INDEXED" }));
      const snapshot = await window.electronAPI?.updateSettings?.({ settings: { workspace: { repositoryIndexEnabled: enabled } } });
      if (snapshot) setSettingsSnapshot(snapshot as SettingsSnapshot);
    }
  };

  const rebuildRepositoryIndex = async () => {
    const response = await fetch(`${SERVER_BASE_URL}/api/repository-index/rebuild`, { method: "POST" });
    if (response.ok) setRepositoryIndex((current) => ({ ...current, state: "INDEXING" }));
  };

  const refreshModelsAndHealth = useCallback(async () => {
    try {
      const response = await fetch(`${SERVER_BASE_URL}/api/models`);
      if (!response.ok) throw new Error(`models request failed: ${response.status}`);
      const data = (await response.json()) as ApiModel[];
      if (!Array.isArray(data)) return;
      setApiModels(data);
      setCatalogLastCheckedAt(Date.now());

      const visible = data.filter((m) => !isHiddenModel(m.id));
      const modelItems: ModelSelectorItem[] = [
        { id: "auto", displayName: "ForgeAuto/Free", tier: "free", description: "Automatic free routing" },
        ...visible.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          tier: m.tier === "gems_paid" ? ("gems_paid" as const) : ("free" as const),
          description: m.eligible === false ? `${accessBadge(m)} · Unavailable` : accessBadge(m),
          available: m.eligible === true,
          unavailableReason: m.eligible === false ? "Provider or entitlement is unavailable" : undefined,
        })),
      ];
      setModels(modelItems);
      setModelProviders(Object.fromEntries(data.map((m) => [m.id, m.providerId])));

      const providerIds = [...new Set([
        ...data.map((m) => m.providerId),
        "codeforge-cloud", "opencode", "openrouter", "zai", "google", "groq",
        "cloudflare-workers-ai", "openai", "anthropic",
      ])];
      const statuses = await Promise.all(providerIds.map(async (providerId) => {
        try {
          const res = await fetch(`${SERVER_BASE_URL}/api/providers/${providerId}/health`);
          if (!res.ok) return [providerId, undefined] as const;
          return [providerId, await res.json() as { status: string; error?: string }] as const;
        } catch {
          return [providerId, undefined] as const;
        }
      }));
      setProviderStatus(Object.fromEntries(statuses.filter((entry) => entry[1] !== undefined)) as Record<string, { status: string; error?: string }>);
    } catch {}
  }, []);

  useEffect(() => {
    refreshModelsAndHealth();
    const interval = setInterval(refreshModelsAndHealth, 15000);
    return () => clearInterval(interval);
  }, [refreshModelsAndHealth]);

  // Re-apply the persisted default model exactly once per workspace mount, after the catalog
  // has loaded — the local server's model selection is per-process, so without this the user's
  // pinned default silently reset to ForgeAuto on every restart.
  useEffect(() => {
    if (appliedDefaultModelRef.current) return;
    if (!settingsSnapshot || apiModels.length === 0) return;
    appliedDefaultModelRef.current = true;
    const defaultModelId = settingsSnapshot.settings.models.defaultModelId;
    if (defaultModelId === "auto") return;
    const found = apiModels.find((m) => m.id === defaultModelId);
    if (!found || found.eligible !== true) return;
    void fetch(`${SERVER_BASE_URL}/api/model-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: defaultModelId, providerId: found.providerId, sessionId: "default" }),
    }).then((response) => {
      if (response.ok) setSelectedModelId(defaultModelId);
    }).catch(() => {});
  }, [settingsSnapshot, apiModels]);

  // Runtime-status polling: feeds the Settings runtime surfaces and the OS notification policy.
  useEffect(() => {
    if (!window.electronAPI?.getRuntimeStatus) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await window.electronAPI!.getRuntimeStatus() as DesktopRuntimeStatus;
        if (cancelled || !status) return;
        setRuntimeStatus(status);
        const prefs = notificationPrefsRef.current;
        if (prefs && window.electronAPI?.showNotification) {
          const notifications = computeWorkNotifications(previousCountersRef.current, status, prefs, document.hasFocus());
          for (const notification of notifications) {
            void window.electronAPI!.showNotification!({ title: notification.title, body: notification.body }).catch(() => {});
          }
        }
        previousCountersRef.current = status;
      } catch {}
    };
    void tick();
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    notificationPrefsRef.current = settingsSnapshot?.settings.notifications ?? null;
  }, [settingsSnapshot]);

  useEffect(() => {
    const handleProviderUpdated = () => {
      refreshModelsAndHealth();
      loadCloudAccount();
    };
    window.addEventListener("codeforge:provider-updated", handleProviderUpdated);
    return () => window.removeEventListener("codeforge:provider-updated", handleProviderUpdated);
  }, [refreshModelsAndHealth, loadCloudAccount]);

  const modelSections = useMemo((): ModelSection[] => buildModelSections(apiModels, models), [apiModels, models]);

  const postModelSelection = useCallback(async (modelId: string, providerId?: string) => {
    const response = await fetch(`${SERVER_BASE_URL}/api/model-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The historical endpoint name ("/api/model/select") never existed on the server and the
      // 404 silently swallowed every selection — /api/model-selection is the real authority.
      body: JSON.stringify({ modelId, providerId, sessionId: "default" }),
    });
    if (!response.ok) throw new Error(`Model selection rejected (${response.status})`);
  }, []);

  const handleSelectModel = (model: ModelSelectorItem) => {
    const modelId = model.id;
    void (async () => {
      try {
        await postModelSelection(modelId, modelProviders[modelId]);
        setSelectedModelId(modelId);
        // Persist only after the server authority accepts the exact route.
        const snapshot = await window.electronAPI?.updateSettings?.({ settings: { models: { defaultModelId: modelId } } });
        if (snapshot) setSettingsSnapshot(snapshot as SettingsSnapshot);
      } catch {}
    })();
  };

  const handleShowModelDetails = (model: ModelSelectorItem) => {
    const modelId = model.id;
    const found = apiModels.find((m) => m.id === modelId);
    if (found) {
      setSelectedModelForDetails(found);
      setShowModelDetails(true);
    }
  };

  const handleCloseModelDetails = () => {
    setShowModelDetails(false);
    setSelectedModelForDetails(null);
  };

  const openExternalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, "_blank");
    }
  };

  const getCurrentProviderStatus = () => {
    const selected = apiModels.find((m) => m.id === selectedModelId);
    const providerId = selected ? selected.providerId : modelProviders[selectedModelId || ""];
    const health = providerId ? providerStatus[providerId] : undefined;

    if (selectedModelId === "auto") {
      const available = apiModels.some((model) => model.eligible === true && model.freeStatus === "verified_free" && model.costProfile?.isFree === true);
      return available
        ? { status: "auto", text: "ForgeAuto/Free", detail: "Automatic free routing" }
        : { status: "auto", text: "ForgeAuto/Free", detail: "No eligible free route", error: true };
    }
    if (!providerId) return { status: "unknown", text: "Unknown" };
    const freeLabel = selected?.costProfile?.isFree || selected?.isPromotional ? "Free" : selected?.tier === "paid" || selected?.tier === "gems_paid" ? "Paid" : "Unknown";
    const promo = selected?.isPromotional ? " · Promotional" : "";
    const detail = `${freeLabel}${promo}`;
    if (health?.status === "available") return { status: "connected", text: "Connected", detail };
    if (health?.status === "error") return { status: "error", text: "Error", detail: health.error || detail };
    return { status: "unknown", text: providerId, detail };
  };

  const currentStatus = getCurrentProviderStatus();
  const autoRouteAvailable = apiModels.some((model) => model.eligible === true && model.freeStatus === "verified_free" && model.costProfile?.isFree === true);
  const forgeZeroTrust = resolveForgeZeroTrust(selectedModelId, apiModels.find((m) => m.id === selectedModelId), autoRouteAvailable, (runtimeStatus?.discoveringProviders ?? 0) > 0);
  const runtimeLabel = resolveRuntimeLabel(selectedModelId, apiModels.find((m) => m.id === selectedModelId));

  // A smoke-fixture account has no real identity fields — it must never masquerade as a real
  // authenticated user in the UI.
  const isFixtureAccount = Boolean(
    cloudAccount && !cloudAccount.user?.primaryIdentity && !cloudAccount.user?.id,
  );

  const updateSettings = useCallback(async (payload: { settings?: AppSettingsPatch; closeBehavior?: CloseBehavior }) => {
    if (!window.electronAPI?.updateSettings) return;
    const snapshot = await window.electronAPI.updateSettings(payload) as SettingsSnapshot;
    setSettingsSnapshot(snapshot);
  }, []);

  const resetPreferences = useCallback(async () => {
    if (!window.electronAPI?.resetSettings) return;
    const snapshot = await window.electronAPI.resetSettings() as SettingsSnapshot;
    setSettingsSnapshot(snapshot);
    setDefaultExecutionModeState("agent");
    try { window.localStorage.removeItem(EXECUTION_MODE_KEY); } catch {}
  }, []);

  const setDefaultModel = useCallback(async (modelId: string) => {
    const providerId = modelId === "auto" ? undefined : modelProviders[modelId] ?? apiModels.find((m) => m.id === modelId)?.providerId;
    await postModelSelection(modelId, providerId);
    setSelectedModelId(modelId);
    await updateSettings({ settings: { models: { defaultModelId: modelId } } });
  }, [modelProviders, apiModels, postModelSelection, updateSettings]);

  const setDefaultExecutionMode = useCallback((mode: ExecutionMode) => {
    setDefaultExecutionModeState(mode);
    // The composer reads this key as its persisted default (established store for this setting).
    try {
      window.localStorage.setItem(EXECUTION_MODE_KEY, mode);
    } catch {}
  }, []);

  const settingsContext = useMemo((): SettingsContextValue => {
    const settings = settingsSnapshot?.settings;
    return {
      settings: settings ?? {
        schemaVersion: 1,
        general: { openLastWorkspaceOnStartup: true, continueInterruptedAgents: true, defaultSteeringPolicy: "expensive_actions_only" },
        appearance: { chatTextScale: "medium", reducedMotion: false },
        models: { defaultModelId: "auto" },
        notifications: { enabled: true, onApprovalNeeded: true, onAgentCompleted: true, onlyWhenInBackground: true },
        privacy: { routingMode: "STANDARD" },
        workspace: { repositoryIndexEnabled: true },
      },
      closeBehavior: settingsSnapshot?.closeBehavior ?? "ask",
      update: updateSettings,
      resetPreferences,
      account: cloudAccount,
      isFixtureAccount,
      refreshAccount: loadCloudAccount,
      signIn: async () => {
        if (!window.electronAPI?.signInWithCloud) return false;
        const result = await window.electronAPI.signInWithCloud();
        if (result?.ok) {
          await loadCloudAccount();
          await refreshModelsAndHealth();
          return true;
        }
        return false;
      },
      signOut: async () => {
        await window.electronAPI?.logoutCloud?.();
        setCloudAccount(null);
        await refreshModelsAndHealth();
        onSignedOut?.();
      },
      deleteAccount: async () => {
        await window.electronAPI?.deleteCloudAccount?.();
        setCloudAccount(null);
        await refreshModelsAndHealth();
        onSignedOut?.();
      },
      apiModels,
      modelSections,
      providerStatus,
      defaultModelId: settings?.models.defaultModelId ?? "auto",
      setDefaultModel,
      refreshModels: refreshModelsAndHealth,
      catalogRefresh: async () => {
        if (!window.electronAPI?.refreshCatalog) return null;
        return await window.electronAPI.refreshCatalog();
      },
      catalogLastCheckedAt,
      gitInfo,
      project,
      recentProjects,
      openProjectPath: async (projectPath: string) => {
        if (onOpenProjectPath) await onOpenProjectPath(projectPath);
      },
      repositoryIndex,
      setRepositoryIndexEnabled,
      rebuildRepositoryIndex,
      runtimeStatus,
      systemInfo,
      defaultExecutionMode,
      setDefaultExecutionMode,
      openExternal: openExternalLink,
      openDataFolder: async () => {
        await window.electronAPI?.openDataFolder?.().catch(() => {});
      },
      clearRecentProjects: async () => {
        await window.electronAPI?.clearRecentProjects?.();
        await loadRecentProjects();
      },
      closeSettings: () => setSettingsSection(null),
      navigate: (sectionId: string) => setSettingsSection(sectionId),
    };
  }, [
    settingsSnapshot, updateSettings, resetPreferences, cloudAccount, isFixtureAccount, loadCloudAccount,
    refreshModelsAndHealth, onSignedOut, apiModels, modelSections, providerStatus, setDefaultModel,
    catalogLastCheckedAt, gitInfo, project, recentProjects, onOpenProjectPath, repositoryIndex,
    runtimeStatus, systemInfo, defaultExecutionMode, setDefaultExecutionMode, loadRecentProjects,
  ]);

  const userIntentHoldPolicy = settingsSnapshot?.settings.general.defaultSteeringPolicy ?? "expensive_actions_only";
  const displayName = cloudAccount?.user?.displayName;
  const scaleZoom = DEFAULT_MODEL_ZOOM[settingsSnapshot?.settings.appearance.chatTextScale ?? "medium"];

  return (
    <div className={`workspace-shell${settingsSnapshot?.settings.appearance.reducedMotion ? " cf-reduced-motion" : ""}`}>
      <header className="workspace-shell-header">
        <div className="header-left">
          <button className="header-back" onClick={onClose} title="Back to projects">
            ←
          </button>
          <div className="header-project">
            <span className="project-name">{project.name}</span>
            {gitInfo.isGitRepo && (
              <span className="project-branch">
                • {gitInfo.isDetached ? "detached HEAD" : gitInfo.branch}
                {gitInfo.isWorktree && " · worktree"}
              </span>
            )}
          </div>
        </div>

        <div className="header-center">
          {/* Transient only: a live activity indicator that persists while Settings is open (the
              header stays mounted, the workspace SSE view does not) so an in-flight agent run is
              never invisible, and clicking it returns to the workspace. Renders nothing when idle —
              no permanent telemetry. (R2 GAP-6) */}
          {(() => {
            const activity = runtimeStatus ? describeHeaderActivity(runtimeStatus) : null;
            if (!activity || !runtimeStatus) return null;
            const inSettings = settingsSection !== null;
            return (
              <button
                type="button"
                className={`header-activity${runtimeStatus.pendingApprovals > 0 ? " has-approvals" : ""}`}
                title={`${summarizeActiveWork(runtimeStatus)}${inSettings ? " — click to return to the workspace" : ""}`}
                aria-label={`Active work: ${summarizeActiveWork(runtimeStatus)}.${inSettings ? " Return to the workspace." : ""}`}
                onClick={() => { if (inSettings) setSettingsSection(null); }}
              >
                <span className="header-activity-dot" aria-hidden="true" />
                <span className="header-activity-label">{activity}</span>
              </button>
            );
          })()}
        </div>

        <div className="header-right">
          <button
            className="header-btn header-icon-btn"
            onClick={() => setIsRepoIntelligenceOpen(!isRepoIntelligenceOpen)}
            aria-expanded={isRepoIntelligenceOpen}
            aria-label="Repository Intelligence"
            title="Repository Intelligence"
          >
            📊
          </button>
          {isRepoIntelligenceOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 199 }}
                onClick={() => setIsRepoIntelligenceOpen(false)}
              />
              <div className="repo-intelligence-popover" onClick={(e) => e.stopPropagation()}>
                <div className="repo-intelligence-popover-title">Repository Intelligence</div>
                <div className="repo-intelligence-popover-row">
                  <span className="repo-intelligence-popover-label">Status</span>
                  <span className="repo-intelligence-popover-value">
                    {repositoryIndex.state === "INDEXING" && repositoryIndex.progress
                      ? `Indexing ${repositoryIndex.progress.filesProcessed.toLocaleString()} / ${repositoryIndex.progress.filesDiscovered.toLocaleString()}`
                      : repositoryIndex.state === "READY" || repositoryIndex.state === "DEGRADED"
                        ? `${repositoryIndex.state === "READY" ? "Ready" : "Degraded"}`
                        : repositoryIndex.state}
                  </span>
                </div>
                {repositoryIndex.state === "READY" || repositoryIndex.state === "DEGRADED" ? (
                  <>
                    <div className="repo-intelligence-popover-row">
                      <span className="repo-intelligence-popover-label">Indexed</span>
                      <span className="repo-intelligence-popover-value">
                        {(repositoryIndex.fileCount ?? 0).toLocaleString()} files · {(repositoryIndex.symbolCount ?? 0).toLocaleString()} symbols
                      </span>
                    </div>
                    <div className="repo-intelligence-popover-row">
                      <span className="repo-intelligence-popover-label">Mode</span>
                      <span className="repo-intelligence-popover-value">Local structural index</span>
                    </div>
                  </>
                ) : null}
                <div className="repo-intelligence-popover-divider" />
                <button
                  className="repo-intelligence-popover-action"
                  onClick={() => void setRepositoryIndexEnabled(repositoryIndex.enabled === false)}
                >
                  {repositoryIndex.enabled === false ? "Enable index" : "Disable index"}
                </button>
                <button
                  className="repo-intelligence-popover-action"
                  disabled={repositoryIndex.enabled === false || repositoryIndex.state === "INDEXING"}
                  onClick={() => void rebuildRepositoryIndex()}
                >
                  Rebuild
                </button>
                <div className="repo-intelligence-popover-divider" />
                <button
                  className="repo-intelligence-popover-action settings-link"
                  onClick={() => { setIsRepoIntelligenceOpen(false); setSettingsSection("workspaces"); }}
                >
                  Open Workspace Settings
                </button>
              </div>
            </>
          )}

          {cloudAccount ? (
            <div className="cloud-account-menu-anchor">
              <button
                className="cloud-account-btn"
                onClick={() => setIsAccountMenuOpen((current) => !current)}
                aria-expanded={isAccountMenuOpen}
                aria-haspopup="menu"
                title="Account"
              >
                <AccountAvatar account={cloudAccount} />
                <span>{displayName ?? "CodeForge account"}</span>
                <span className="account-plan">{cloudAccount.offline ? "Cloud offline" : cloudAccount.planName ?? "CodeForge Free"}</span>
              </button>
              {isAccountMenuOpen && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 199, cursor: "default" }}
                    onClick={() => setIsAccountMenuOpen(false)}
                  />
                  <div className="cloud-account-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    <div className="cloud-account-menu-header">
                      <AccountAvatar account={cloudAccount} />
                      <div style={{ minWidth: 0 }}>
                        <div className="account-name" style={{ fontSize: 13 }}>{displayName ?? "CodeForge account"}</div>
                        <div className="account-handle" style={{ fontSize: 11 }}>
                          {cloudAccount.identity?.login ? `@${cloudAccount.identity.login}` : "GitHub connected ✓"}
                        </div>
                        <div className="account-email" style={{ fontSize: 11 }}>
                          {cloudAccount.offline ? "CodeForge Cloud is unreachable — local routes still work" : cloudAccount.identity?.email ?? cloudAccount.planName ?? "CodeForge Free"}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="cloud-account-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setIsAccountMenuOpen(false);
                        setSettingsSection("profile");
                      }}
                    >
                      Profile &amp; Account
                    </button>
                    <button
                      type="button"
                      className="cloud-account-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setIsAccountMenuOpen(false);
                        setSettingsSection("general");
                      }}
                    >
                      Settings
                    </button>
                    <div className="cloud-account-menu-divider" />
                    <button
                      type="button"
                      className="cloud-account-menu-item danger"
                      role="menuitem"
                      onClick={async () => {
                        setIsAccountMenuOpen(false);
                        await window.electronAPI?.logoutCloud?.();
                        setCloudAccount(null);
                        await refreshModelsAndHealth();
                        onSignedOut?.();
                      }}
                    >
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              className="cloud-account-btn"
              onClick={async () => {
                if (window.electronAPI?.signInWithCloud) {
                  const res = await window.electronAPI.signInWithCloud();
                  if (res.ok) await loadCloudAccount();
                }
              }}
              title="Sign in with GitHub"
            >
              ✦ Start Free Cloud
            </button>
          )}

          <div
            className={`forgezero-indicator ${forgeZeroTrust.verifiedFree ? "verified" : "unverified"}`}
            role="button"
            tabIndex={0}
            onClick={() => setIsForgeZeroOpen(!isForgeZeroOpen)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setIsForgeZeroOpen((v) => !v);
              }
            }}
            aria-expanded={isForgeZeroOpen}
            title={forgeZeroTrust.detail}
          >
            <span className="forgezero-icon" aria-hidden="true">{forgeZeroTrust.verifiedFree ? "◈" : "◇"}</span>
            <span>{forgeZeroTrust.label}</span>
            {isForgeZeroOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 199, cursor: "default" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsForgeZeroOpen(false);
                  }}
                />
                <div className="forgezero-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="forgezero-popover-title">ForgeZero Trust Status</div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">{forgeZeroTrust.verifiedFree ? "✓" : "⚠"}</span>
                    <span className="forgezero-popover-label">Provider: {currentStatus.text}</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">{forgeZeroTrust.verifiedFree ? "✓" : "⚠"}</span>
                    <span className="forgezero-popover-label">{forgeZeroTrust.detail}</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Workspace Boundary Isolated</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Secrets Redaction Active</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Safety Timeout Enforced</span>
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            className="header-btn"
            title="Help & documentation"
            aria-label="Help and documentation"
            onClick={() => openExternalLink(HELP_URL)}
          >
            ?
          </button>
        </div>
      </header>

      {settingsSection !== null ? (
        <SettingsApp context={settingsContext} initialSection={settingsSection} />
      ) : (
        <main
          className="workspace-shell-main"
          style={scaleZoom !== 1 ? ({ zoom: scaleZoom } as React.CSSProperties) : undefined}
        >
          <WorkspaceApp
            sseUrl={`${SERVER_BASE_URL}/api/events`}
            models={models}
            selectedModelId={selectedModelId}
            onSelectModel={handleSelectModel}
            onShowModelDetails={handleShowModelDetails}
            onUpgradeNavigation={() => setSettingsSection("profile")}
            modelSections={modelSections}
            projectName={project.name}
            projectBranch={gitInfo.branch ?? undefined}
            userDisplayName={displayName}
            workspacePath={project.path}
            isGitRepo={gitInfo.isGitRepo}
            isDetached={gitInfo.isDetached}
            isWorktree={gitInfo.isWorktree}
            runtimeLabel={runtimeLabel.label}
            runtimeDetail={runtimeLabel.detail}
            resolveModelDisplayName={(modelId) => models.find((m) => m.id === modelId)?.displayName ?? modelId}
            onOpenProjects={onClose}
            onOpenSettings={() => setSettingsSection("general")}
            onOpenSettingsSection={(sectionId) => setSettingsSection(sectionId)}
            onOpenHelp={() => openExternalLink(HELP_URL)}
            userIntentHoldPolicy={userIntentHoldPolicy}
            defaultExecutionMode={defaultExecutionMode}
          />
        </main>
      )}

      {showModelDetails && selectedModelForDetails && (
        <ModelDetails
          model={selectedModelForDetails}
          onClose={handleCloseModelDetails}
        />
      )}
    </div>
  );
}

/** Avatar with a deterministic initials fallback — a missing or broken GitHub image never breaks the UI. */
function AccountAvatar({ account }: { account: CloudAccountView }): React.ReactElement {
  const url = account.user?.avatarUrl;
  const name = account.user?.displayName ?? "CodeForge";
  if (!url) {
    return <span className="account-avatar-fallback account-avatar-fallback-sm" aria-hidden="true">{(name.trim()[0] ?? "C").toUpperCase()}</span>;
  }
  return (
    <img
      className="account-avatar account-avatar-sm"
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(event) => {
        const img = event.currentTarget;
        const fallback = document.createElement("span");
        fallback.className = "account-avatar-fallback account-avatar-fallback-sm";
        fallback.setAttribute("aria-hidden", "true");
        fallback.textContent = (name.trim()[0] ?? "C").toUpperCase();
        img.replaceWith(fallback);
      }}
    />
  );
}

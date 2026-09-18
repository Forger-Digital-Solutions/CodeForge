import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsContext, type SettingsContextValue } from "../src/renderer/settings/settings-context.js";
import type { AppSettings } from "../src/app-settings.js";

/**
 * Test harness for Settings section components: static markup rendering (the established UI test
 * pattern in this repo) over a deterministic context fixture. Tests override only the slice they
 * assert on, so each test documents exactly which state it depends on.
 */

export const FIXTURE_SETTINGS: AppSettings = {
  schemaVersion: 1,
  general: { openLastWorkspaceOnStartup: true, continueInterruptedAgents: true, defaultSteeringPolicy: "expensive_actions_only" },
  appearance: { chatTextScale: "medium", reducedMotion: false },
  models: { defaultModelId: "auto" },
  notifications: { enabled: true, onApprovalNeeded: true, onAgentCompleted: true, onlyWhenInBackground: true },
  privacy: { routingMode: "STANDARD" },
  workspace: { repositoryIndexEnabled: true },
};

export const FIXTURE_ACCOUNT = {
  user: {
    id: "11111111-1111-1111-1111-111111111111",
    displayName: "Edward Schmidt",
    avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
    primaryIdentity: "github:42",
  },
  identity: { login: "edward-s", email: "edward@example.com", profileUrl: "https://github.com/edward-s" },
  planId: "free",
  planName: "CodeForge Free",
  creditBalance: 500000,
};

export function createSettingsContext(overrides: Partial<SettingsContextValue> = {}): SettingsContextValue {
  return {
    settings: FIXTURE_SETTINGS,
    closeBehavior: "ask",
    update: async () => undefined,
    resetPreferences: async () => undefined,
    account: FIXTURE_ACCOUNT,
    isFixtureAccount: false,
    refreshAccount: async () => undefined,
    signIn: async () => true,
    signOut: async () => undefined,
    deleteAccount: async () => undefined,
    apiModels: [],
    modelSections: [],
    providerStatus: {},
    defaultModelId: "auto",
    setDefaultModel: async () => undefined,
    refreshModels: async () => undefined,
    catalogRefresh: async () => ({ ok: true, freeModels: 3 }),
    catalogLastCheckedAt: null,
    gitInfo: { isGitRepo: true, branch: "main", isDetached: false, isWorktree: false },
    project: { id: "p1", path: "C:/work/demo", name: "demo", lastOpened: "2026-09-11T00:00:00.000Z" },
    recentProjects: [],
    openProjectPath: async () => undefined,
    repositoryIndex: { state: "READY", enabled: true, fileCount: 10, symbolCount: 20 },
    setRepositoryIndexEnabled: async () => undefined,
    rebuildRepositoryIndex: async () => undefined,
    runtimeStatus: null,
    systemInfo: {
      appVersion: "0.4.0",
      electron: "33.4.11",
      node: "22.0.0",
      chrome: "130.0.0.0",
      platform: "win32",
      arch: "x64",
      osRelease: "10.0.26200",
      buildChannel: "development",
      isPackaged: false,
    },
    defaultExecutionMode: "agent",
    setDefaultExecutionMode: () => undefined,
    openExternal: () => undefined,
    openDataFolder: async () => undefined,
    clearRecentProjects: async () => undefined,
    closeSettings: () => undefined,
    navigate: () => undefined,
    ...overrides,
  };
}

export function renderSection(element: React.ReactElement, context: SettingsContextValue): string {
  return renderToStaticMarkup(<SettingsContext.Provider value={context}>{element}</SettingsContext.Provider>);
}

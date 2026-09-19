import { createContext, useContext } from "react";
import type { AppSettings, AppSettingsPatch, CloseBehavior } from "../../app-settings.js";
import type { GitWorkspaceInfo } from "../git-workspace-info.js";
import type { ApiModel } from "../model-sections.js";
import type { ModelSection } from "@codeforge/ui";
import type { Project } from "../App.js";

import type { CloudAccount, CloudAccountIdentity } from "../../cloud-account.js";

/**
 * The renderer's view of a cloud account is the *same* typed contract the preload exposes for
 * `getCloudAccount` (R2 GAP-5) — aliased here rather than re-declared so the two can never drift.
 * Mirrors the cloud /v1/account snapshot with every identity field optional: the deployed cloud may
 * not return `identity`, and accounts may legitimately not share a login or email. Absent means
 * "not shared" — never invented, never a placeholder.
 */
export type CloudIdentityView = CloudAccountIdentity;
export type CloudAccountView = CloudAccount;

export interface SystemInfoView {
  appVersion: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
  osRelease: string;
  buildChannel: string;
  isPackaged: boolean;
}

export interface RepositoryIndexStatus {
  state: "NOT_INDEXED" | "INDEXING" | "READY" | "STALE" | "DEGRADED" | "ERROR";
  enabled?: boolean;
  fileCount?: number;
  symbolCount?: number;
  sizeBytes?: number;
  local?: boolean;
  progress?: { filesProcessed: number; filesDiscovered: number };
}

export interface DesktopRuntimeStatus {
  activeWork: boolean;
  activeWorkflows: number;
  activeAgentTurns: number;
  activeCommands: number;
  pendingApprovals: number;
  activeVerifications: number;
  hostedContinuations: number;
  backgroundTasks: number;
  recoverable: boolean;
  unrecoverableResources: string[];
  /** Providers whose live free-model discovery is still running (0 once the catalog is settled). */
  discoveringProviders?: number;
}

export interface SettingsContextValue {
  settings: AppSettings;
  closeBehavior: CloseBehavior;
  update: (payload: { settings?: AppSettingsPatch; closeBehavior?: CloseBehavior }) => Promise<void>;
  resetPreferences: () => Promise<void>;

  account: CloudAccountView | null;
  /** True when the account comes from the packaged-smoke fixture rather than a real sign-in. */
  isFixtureAccount: boolean;
  refreshAccount: () => Promise<void>;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;

  apiModels: ApiModel[];
  modelSections: ModelSection[];
  /** Per-provider health from /api/providers/:id/health, keyed by providerId. */
  providerStatus: Record<string, { status: string; error?: string }>;
  defaultModelId: string;
  setDefaultModel: (modelId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  catalogRefresh: () => Promise<{ ok: boolean; freeModels: number; error?: string } | null>;
  /** When the renderer last pulled the catalog from the local server (ms epoch), for "last checked". */
  catalogLastCheckedAt: number | null;

  gitInfo: GitWorkspaceInfo;
  project: Project;
  recentProjects: Project[];
  openProjectPath: (path: string) => Promise<void>;

  repositoryIndex: RepositoryIndexStatus;
  setRepositoryIndexEnabled: (enabled: boolean) => Promise<void>;
  rebuildRepositoryIndex: () => Promise<void>;

  runtimeStatus: DesktopRuntimeStatus | null;
  systemInfo: SystemInfoView | null;

  defaultExecutionMode: "agent" | "chat";
  setDefaultExecutionMode: (mode: "agent" | "chat") => void;

  openExternal: (url: string) => void;
  openDataFolder: () => Promise<void>;
  /** Writes a sanitized support bundle under userData/diagnostics and returns its path (RC-7). */
  exportDiagnosticBundle: () => Promise<string | null>;
  clearRecentProjects: () => Promise<void>;
  closeSettings: () => void;
  /** Deep-link to another settings section (account card → Profile, etc.). */
  navigate: (sectionId: string) => void;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("Settings sections must render inside SettingsApp");
  return value;
}

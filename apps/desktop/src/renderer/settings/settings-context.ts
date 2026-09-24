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
  /** Source identity stamped at build time; null when the build was not stamped. */
  build?: { version: string; commit: string; shortCommit: string; branch: string; dirty: boolean; builtAt: string } | null;
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

/** A contributed extension setting — rendered as a typed control on the Extensions page. */
export interface ExtensionSettingDef {
  key: string;
  type: "boolean" | "string" | "enum";
  label: string;
  description?: string;
  default?: unknown;
  options?: string[];
}

/** The renderer's view of an installed extension — mirrors the extension manager's snapshot. */
export interface ExtensionView {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** active = code loaded and activate() completed; error = last activation/command threw. */
  status: "active" | "installed" | "disabled" | "error";
  lastError?: string;
  /** Declared permissions from the manifest — the *only* capabilities the extension has. */
  permissions: string[];
  /** True when loaded in-place from a developer folder (not copied into the managed store). */
  devMode: boolean;
  commands: Array<{ id: string; title: string }>;
  settings: ExtensionSettingDef[];
}

/** A catalog entry from a signature-verified remote marketplace source. */
export interface MarketplaceEntryView {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: string;
  permissions: string[];
  sizeBytes: number;
  /** The configured source URL this entry came from — needed to install it. */
  sourceUrl: string;
  installed: boolean;
  installedVersion?: string;
}

export interface MarketplaceCatalogView {
  entries: MarketplaceEntryView[];
  errors: Array<{ source: string; error: string }>;
}

export interface SettingsContextValue {
  settings: AppSettings;
  closeBehavior: CloseBehavior;
  /** Set when a persisted or runtime-backed setting could not be applied. */
  settingsError: string | null;
  update: (payload: { settings?: AppSettingsPatch; closeBehavior?: CloseBehavior }) => Promise<boolean>;
  resetPreferences: () => Promise<boolean>;

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
  /** Remove one entry from the recent-projects list (files untouched). */
  removeRecentProject: (path: string) => Promise<void>;

  repositoryIndex: RepositoryIndexStatus;
  setRepositoryIndexEnabled: (enabled: boolean) => Promise<void>;
  rebuildRepositoryIndex: () => Promise<void>;

  runtimeStatus: DesktopRuntimeStatus | null;
  systemInfo: SystemInfoView | null;

  extensions: ExtensionView[];
  refreshExtensions: () => Promise<void>;
  setExtensionEnabled: (extensionId: string, enabled: boolean) => Promise<boolean>;
  uninstallExtension: (extensionId: string) => Promise<boolean>;
  /** Opens a folder picker and registers the chosen folder as a developer extension. */
  loadExtensionFolder: () => Promise<{ ok: boolean; error?: string } | null>;
  getExtensionSetting: (extensionId: string, key: string) => Promise<unknown>;
  setExtensionSetting: (extensionId: string, key: string, value: unknown) => Promise<boolean>;

  /** Signed remote catalog; null when no marketplace source is configured or all fetches failed. */
  marketplaceCatalog: () => Promise<MarketplaceCatalogView | null>;
  installMarketplaceExtension: (sourceUrl: string, extensionId: string) => Promise<{ ok: boolean; error?: string }>;

  defaultExecutionMode: "agent" | "chat";
  setDefaultExecutionMode: (mode: "agent" | "chat") => Promise<void>;

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

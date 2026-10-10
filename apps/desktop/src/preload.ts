import { contextBridge, ipcRenderer } from "electron";
import type { CloudAccount, CloudUsage } from "./cloud-account.js";
import type { PuterAccountView } from "./puter-account-types.js";
import type { ConnectedAccountView, ConnectedAccountResult, ConnectedAccountPolicyPatch, ProviderAccountOAuthOptions, ProviderRoutingPolicy } from "./connected-account-types.js";
import type { PersonalPaidEstimateView } from "./paid-request-estimate-types.js";

// Startup-chain marks at verbose console level (see renderer/lifecycle.ts). Observation only:
// nothing is exposed to the page and nothing is read from the main process.
const lifecycleMark = (name: string): void => {
  try { console.debug(`[codeforge:lifecycle] ${name} ${Date.now()}`); } catch { /* diagnostics only */ }
};
lifecycleMark("preload-entry");

// The local control-plane bearer is deliberately absent from this bridge: the main process
// attaches it to the primary window's own requests (see control-plane-trust.ts), so the
// renderer never holds a secret it could leak.
const api = {
  onPersonalPaidEstimate: (callback: (estimate: PersonalPaidEstimateView) => void): (() => void) => {
    const listener = (_event: unknown, estimate: PersonalPaidEstimateView) => callback(estimate);
    ipcRenderer.on("providerAccounts:paidEstimate", listener);
    return () => ipcRenderer.removeListener("providerAccounts:paidEstimate", listener);
  },
  acknowledgePersonalPaidEstimate: (presentationId: string): Promise<boolean> => ipcRenderer.invoke("providerAccounts:estimatePresented", presentationId),
  getRuntimeEndpoint: (): Promise<string | null> => {
    return ipcRenderer.invoke("app:runtime-endpoint");
  },
  selectDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke("dialog:selectDirectory");
  },
  getRecentProjects: (): Promise<Array<{ id: string; path: string; name: string; lastOpened: string; exists?: boolean }>> => {
    return ipcRenderer.invoke("project:getRecent");
  },
  removeRecentProject: (path: string): Promise<void> => {
    return ipcRenderer.invoke("project:removeRecent", path);
  },
  openProject: (path: string): Promise<{ id: string; path: string; name: string; lastOpened: string }> => {
    return ipcRenderer.invoke("project:open", path);
  },
  createProject: (): Promise<{ id: string; path: string; name: string; lastOpened: string } | null> => {
    return ipcRenderer.invoke("project:create");
  },
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke("shell:openExternal", url);
  },
  getVersion: (): Promise<string> => {
    return ipcRenderer.invoke("app:getVersion");
  },
  getPlatform: (): Promise<string> => {
    return ipcRenderer.invoke("app:getPlatform");
  },
  updaterGetStatus: (): Promise<unknown> => {
    return ipcRenderer.invoke("updater:getStatus");
  },
  updaterCheck: (): Promise<unknown> => {
    return ipcRenderer.invoke("updater:check");
  },
  updaterDownload: (): Promise<unknown> => {
    return ipcRenderer.invoke("updater:download");
  },
  updaterInstall: (): Promise<unknown> => {
    return ipcRenderer.invoke("updater:install");
  },
  getProviderCredentialStatus: (): Promise<Record<string, boolean>> => {
    return ipcRenderer.invoke("provider:getCredentialStatus");
  },
  setProviderCredential: (providerId: string, apiKey: string): Promise<void> => {
    return ipcRenderer.invoke("provider:setCredential", providerId, apiKey);
  },
  connectOpenRouter: (browser?: "default" | "firefox"): Promise<{ ok: boolean; verifiedFree?: number; error?: string }> => {
    return ipcRenderer.invoke("oauth:openrouter:start", browser);
  },
  getPuterAccount: (): Promise<PuterAccountView> => ipcRenderer.invoke("freecloud:puter:status"),
  connectPuterAccount: (): Promise<{ ok: boolean; account?: PuterAccountView; error?: string }> => ipcRenderer.invoke("freecloud:puter:connect"),
  disconnectPuterAccount: (): Promise<void> => ipcRenderer.invoke("freecloud:puter:disconnect"),
  deleteProviderCredential: (providerId: string): Promise<void> => {
    return ipcRenderer.invoke("provider:deleteCredential", providerId);
  },
  testProviderConnection: (providerId: string): Promise<{ status: string; error?: string }> => {
    return ipcRenderer.invoke("provider:testConnection", providerId);
  },
  getOnboardingCompleted: (): Promise<boolean> => {
    return ipcRenderer.invoke("onboarding:getCompleted");
  },
  setOnboardingCompleted: (completed: boolean): Promise<void> => {
    return ipcRenderer.invoke("onboarding:setCompleted", completed);
  },
  getFirstRunLegalAck: (): Promise<{ ageConfirmed: true; hostExecutionAcknowledged: true; acknowledgedAt: string } | null> => {
    return ipcRenderer.invoke("legal:getFirstRunAck");
  },
  setFirstRunLegalAck: (): Promise<{ ageConfirmed: true; hostExecutionAcknowledged: true; acknowledgedAt: string }> => {
    return ipcRenderer.invoke("legal:setFirstRunAck");
  },
  // --- CodeForge Cloud APIs ---
  signInWithCloud: (): Promise<{ ok: boolean; user?: unknown; error?: string }> => {
    return ipcRenderer.invoke("cloud:auth:start");
  },
  deleteCloudAccount: (): Promise<unknown> => {
    return ipcRenderer.invoke("cloud:account:delete");
  },
  getCloudAccount: (): Promise<CloudAccount | null> => {
    return ipcRenderer.invoke("cloud:account:get");
  },
  logoutCloud: (): Promise<void> => {
    return ipcRenderer.invoke("cloud:auth:logout");
  },
  openCloudCheckout: (): Promise<void> => {
    return ipcRenderer.invoke("cloud:billing:checkout");
  },
  openCloudPortal: (): Promise<void> => {
    return ipcRenderer.invoke("cloud:billing:portal");
  },
  getCloudUsage: (): Promise<CloudUsage | null> => {
    return ipcRenderer.invoke("cloud:usage:get");
  },
  /**
   * Fired when the startup account fast path handed the renderer the remembered identity and the
   * live answer arrived afterwards (the account with its plan, or null when the Cloud refused the
   * session). Also used for any later authoritative re-check.
   */
  onCloudAccountChanged: (callback: (account: CloudAccount | null) => void): (() => void) => {
    const listener = (_event: unknown, account: CloudAccount | null) => callback(account);
    ipcRenderer.on("cloud:account:changed", listener);
    return () => ipcRenderer.removeListener("cloud:account:changed", listener);
  },
  onCloseRequested: (callback: (request: unknown) => void): (() => void) => {
    const listener = (_event: unknown, request: unknown) => callback(request);
    ipcRenderer.on("app:close-requested", listener);
    return () => ipcRenderer.removeListener("app:close-requested", listener);
  },
  resolveClose: (decision: string, remember: boolean): Promise<void> => {
    return ipcRenderer.invoke("app:close-decision", { decision, remember });
  },
  /**
   * Read-only git introspection for the workspace context chips (branch/worktree detection). The
   * main process allowlists this to `git` only — it is not a general command-execution bridge.
   */
  execCommand: (params: { command: string; args: string[]; cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    return ipcRenderer.invoke("shell:execCommand", params);
  },
  getRuntimeStatus: (): Promise<unknown> => {
    return ipcRenderer.invoke("app:runtime-status");
  },
  // --- Settings surface ---
  getSettings: (): Promise<unknown> => {
    return ipcRenderer.invoke("settings:get");
  },
  updateSettings: (payload: { settings?: unknown; closeBehavior?: unknown }): Promise<unknown> => {
    return ipcRenderer.invoke("settings:set", payload);
  },
  resetSettings: (): Promise<unknown> => {
    return ipcRenderer.invoke("settings:reset");
  },
  getSystemInfo: (): Promise<unknown> => {
    return ipcRenderer.invoke("app:getSystemInfo");
  },
  openDataFolder: (): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke("app:openDataFolder");
  },
  // RC-7: one-click sanitized diagnostic bundle for support (written under userData/diagnostics).
  exportDiagnosticBundle: (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    return ipcRenderer.invoke("diagnostics:export");
  },
  showNotification: (payload: { title: string; body: string }): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke("notifications:show", payload);
  },
  refreshCatalog: (): Promise<{ ok: boolean; freeModels: number; error?: string }> => {
    return ipcRenderer.invoke("catalog:refresh");
  },
  // --- R1 Free Cloud Platform: provider connections (schemas + state; never secret values) ---
  getProviderDefinitions: (): Promise<unknown[]> => ipcRenderer.invoke("provider:definitions"),
  getProviderConnections: (): Promise<unknown[]> => ipcRenderer.invoke("provider:connections"),
  listProviderAccounts: (): Promise<ConnectedAccountView[]> => ipcRenderer.invoke("providerAccounts:list"),
  addProviderAccount: (providerId: string, fields: Record<string, string>, label?: string): Promise<ConnectedAccountResult> => ipcRenderer.invoke("providerAccounts:add", providerId, fields, label),
  updateProviderAccount: (connectionId: string, patch: ConnectedAccountPolicyPatch): Promise<ConnectedAccountResult> => ipcRenderer.invoke("providerAccounts:update", connectionId, patch),
  disconnectProviderAccount: (connectionId: string): Promise<ConnectedAccountResult> => ipcRenderer.invoke("providerAccounts:disconnect", connectionId),
  replaceProviderAccountCredential: (connectionId: string, fields: Record<string, string>): Promise<ConnectedAccountResult> => ipcRenderer.invoke("providerAccounts:replaceCredential", connectionId, fields),
  qualifyProviderAccount: (connectionId: string, modelId?: string): Promise<ConnectedAccountResult> => ipcRenderer.invoke("providerAccounts:qualify", connectionId, modelId),
  connectProviderAccountOAuth: (providerId: string, options?: ProviderAccountOAuthOptions, browser?: "default" | "firefox"): Promise<ConnectedAccountResult> => ipcRenderer.invoke("providerAccounts:oauth", providerId, options, browser),
  getProviderRoutingPolicy: (): Promise<ProviderRoutingPolicy> => ipcRenderer.invoke("providerRouting:getPolicy"),
  setProviderRoutingPolicy: (policy: ProviderRoutingPolicy): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("providerRouting:setPolicy", policy),
  listEnvironmentCredentials: (): Promise<unknown[]> => ipcRenderer.invoke("provider:env:list"),
  getEnvironmentCredentialPolicy: (): Promise<string> => ipcRenderer.invoke("provider:env:policy:get"),
  setEnvironmentCredentialPolicy: (policy: string): Promise<string> => ipcRenderer.invoke("provider:env:policy:set", policy),
  setEnvironmentCredentialEnabled: (providerId: string, enabled: boolean): Promise<unknown> => ipcRenderer.invoke("provider:env:setEnabled", providerId, enabled),
  refreshEnvironmentCredentials: (): Promise<{ platform: string; queried: number; updated: number; credentials: unknown[] }> => ipcRenderer.invoke("provider:env:refresh"),
  importEnvironmentCredential: (providerId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("provider:env:import", providerId),
  validateProvider: (providerId: string, fields: Record<string, string>): Promise<{ ok: boolean; error?: string; models?: unknown[] }> => ipcRenderer.invoke("provider:validate", providerId, fields),
  connectProvider: (providerId: string, fields: Record<string, string>): Promise<{ ok: boolean; error?: string; models?: unknown[]; verifiedFree?: number }> => ipcRenderer.invoke("provider:connect", providerId, fields),
  getProviderCatalog: (providerId: string): Promise<{ ok: boolean; error?: string; models?: unknown[] }> => ipcRenderer.invoke("provider:catalog", providerId),
  disconnectProvider: (providerId: string): Promise<void> => ipcRenderer.invoke("provider:disconnect", providerId),
  attestProviderFreePlan: (providerId: string, attested: boolean): Promise<void> => ipcRenderer.invoke("provider:attestFreePlan", providerId, attested),
  setGeminiFreePolicyAccepted: (accepted: boolean): Promise<void> => ipcRenderer.invoke("provider:setGeminiFreePolicyAccepted", accepted),
  setProviderEnabledModels: (providerId: string, modelIds: string[] | null): Promise<void> => ipcRenderer.invoke("provider:setEnabledModels", providerId, modelIds),
  getFreeCloudOffer: (): Promise<unknown> => ipcRenderer.invoke("freecloud:offer"),
  getFreeCloudSummary: (): Promise<unknown> => ipcRenderer.invoke("freecloud:summary"),
  qualifyFreeCloud: (): Promise<{ qualified: number; pending: number }> => ipcRenderer.invoke("freecloud:qualify"),
  onProviderChanged: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("provider:changed", listener);
    return () => ipcRenderer.removeListener("provider:changed", listener);
  },
  clearRecentProjects: (): Promise<void> => {
    return ipcRenderer.invoke("project:clearRecent");
  },
  // --- Extensions (managed host; manifests declare every capability) ---
  listExtensions: (): Promise<unknown[]> => {
    return ipcRenderer.invoke("extensions:list");
  },
  setExtensionEnabled: (extensionId: string, enabled: boolean): Promise<boolean> => {
    return ipcRenderer.invoke("extensions:setEnabled", { extensionId, enabled });
  },
  uninstallExtension: (extensionId: string): Promise<boolean> => {
    return ipcRenderer.invoke("extensions:uninstall", extensionId);
  },
  loadExtensionFolder: (): Promise<{ ok: boolean; error?: string } | null> => {
    return ipcRenderer.invoke("extensions:loadDevFolder");
  },
  getExtensionSetting: (extensionId: string, key: string): Promise<unknown> => {
    return ipcRenderer.invoke("extensions:getSetting", { extensionId, key });
  },
  setExtensionSetting: (extensionId: string, key: string, value: unknown): Promise<boolean> => {
    return ipcRenderer.invoke("extensions:setSetting", { extensionId, key, value });
  },
  runExtensionCommand: (extensionId: string, commandId: string, args?: unknown[]): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke("extensions:runCommand", { extensionId, commandId, args });
  },
  // --- Remote marketplace (signed catalog; install requires the source's pinned key) ---
  marketplaceCatalog: (): Promise<unknown> => {
    return ipcRenderer.invoke("marketplace:catalog");
  },
  marketplaceInstall: (sourceUrl: string, extensionId: string): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke("marketplace:install", { sourceUrl, extensionId });
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
lifecycleMark("preload-bridge-ready");

export type ElectronAPI = typeof api;

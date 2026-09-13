import { contextBridge, ipcRenderer } from "electron";
import type { CloudAccount, CloudUsage } from "./cloud-account.js";

// The local control-plane bearer is deliberately absent from this bridge: the main process
// attaches it to the primary window's own requests (see control-plane-trust.ts), so the
// renderer never holds a secret it could leak.
const api = {
  selectDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke("dialog:selectDirectory");
  },
  getRecentProjects: (): Promise<Array<{ id: string; path: string; name: string; lastOpened: string }>> => {
    return ipcRenderer.invoke("project:getRecent");
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
  getProviderCredentialStatus: (): Promise<Record<string, boolean>> => {
    return ipcRenderer.invoke("provider:getCredentialStatus");
  },
  setProviderCredential: (providerId: string, apiKey: string): Promise<void> => {
    return ipcRenderer.invoke("provider:setCredential", providerId, apiKey);
  },
  connectOpenRouter: (): Promise<{ ok: boolean; verifiedFree?: number; error?: string }> => {
    return ipcRenderer.invoke("oauth:openrouter:start");
  },
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
  showNotification: (payload: { title: string; body: string }): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke("notifications:show", payload);
  },
  refreshCatalog: (): Promise<{ ok: boolean; freeModels: number; error?: string }> => {
    return ipcRenderer.invoke("catalog:refresh");
  },
  // --- R1 Free Cloud Platform: provider connections (schemas + state; never secret values) ---
  getProviderDefinitions: (): Promise<unknown[]> => ipcRenderer.invoke("provider:definitions"),
  getProviderConnections: (): Promise<unknown[]> => ipcRenderer.invoke("provider:connections"),
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
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;

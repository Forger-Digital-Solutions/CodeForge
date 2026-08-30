import { contextBridge, ipcRenderer } from "electron";

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
  // --- CodeForge Cloud APIs ---
  signInWithCloud: (): Promise<{ ok: boolean; user?: any; error?: string }> => {
    return ipcRenderer.invoke("cloud:auth:start");
  },
  getCloudAccount: (): Promise<any> => {
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
  getCloudUsage: (): Promise<any> => {
    return ipcRenderer.invoke("cloud:usage:get");
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;

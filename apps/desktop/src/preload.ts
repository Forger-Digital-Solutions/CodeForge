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
  getProviderCredentials: (): Promise<Record<string, string>> => {
    return ipcRenderer.invoke("provider:getCredentials");
  },
  getProviderCredentialStatus: (): Promise<Record<string, boolean>> => {
    return ipcRenderer.invoke("provider:getCredentialStatus");
  },
  setProviderCredential: (providerId: string, apiKey: string): Promise<void> => {
    return ipcRenderer.invoke("provider:setCredential", providerId, apiKey);
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
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;

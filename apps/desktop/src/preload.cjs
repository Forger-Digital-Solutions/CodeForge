const { contextBridge, ipcRenderer } = require("electron");

const api = {
  selectDirectory: () => {
    return ipcRenderer.invoke("dialog:selectDirectory");
  },
  getRecentProjects: () => {
    return ipcRenderer.invoke("project:getRecent");
  },
  openProject: (path) => {
    return ipcRenderer.invoke("project:open", path);
  },
  createProject: () => {
    return ipcRenderer.invoke("project:create");
  },
  openExternal: (url) => {
    return ipcRenderer.invoke("shell:openExternal", url);
  },
  getVersion: () => {
    return ipcRenderer.invoke("app:getVersion");
  },
  getPlatform: () => {
    return ipcRenderer.invoke("app:getPlatform");
  },
  getProviderCredentialStatus: () => {
    return ipcRenderer.invoke("provider:getCredentialStatus");
  },
  setProviderCredential: (providerId, apiKey) => {
    return ipcRenderer.invoke("provider:setCredential", providerId, apiKey);
  },
  connectOpenRouter: () => {
    return ipcRenderer.invoke("oauth:openrouter:start");
  },
  deleteProviderCredential: (providerId) => {
    return ipcRenderer.invoke("provider:deleteCredential", providerId);
  },
  testProviderConnection: (providerId) => {
    return ipcRenderer.invoke("provider:testConnection", providerId);
  },
  getOnboardingCompleted: () => {
    return ipcRenderer.invoke("onboarding:getCompleted");
  },
  setOnboardingCompleted: (completed) => {
    return ipcRenderer.invoke("onboarding:setCompleted", completed);
  },
  // --- CodeForge Cloud APIs ---
  signInWithCloud: () => {
    return ipcRenderer.invoke("cloud:auth:start");
  },
  getCloudAccount: () => {
    return ipcRenderer.invoke("cloud:account:get");
  },
  logoutCloud: () => {
    return ipcRenderer.invoke("cloud:auth:logout");
  },
  openCloudCheckout: () => {
    return ipcRenderer.invoke("cloud:billing:checkout");
  },
  openCloudPortal: () => {
    return ipcRenderer.invoke("cloud:billing:portal");
  },
  getCloudUsage: () => {
    return ipcRenderer.invoke("cloud:usage:get");
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);

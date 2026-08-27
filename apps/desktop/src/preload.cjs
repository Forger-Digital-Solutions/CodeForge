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
};

contextBridge.exposeInMainWorld("electronAPI", api);

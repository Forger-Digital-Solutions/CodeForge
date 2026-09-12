const { contextBridge, ipcRenderer } = require("electron");

const CONTROL_PLANE_TOKEN_ARG = "--codeforge-control-plane-token=";
const controlPlaneToken = process.argv
  .find((argument) => argument.startsWith(CONTROL_PLANE_TOKEN_ARG))
  ?.slice(CONTROL_PLANE_TOKEN_ARG.length) ?? "";

const api = {
  controlPlaneToken,
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
  getFirstRunLegalAck: () => {
    return ipcRenderer.invoke("legal:getFirstRunAck");
  },
  setFirstRunLegalAck: () => {
    return ipcRenderer.invoke("legal:setFirstRunAck");
  },
  // --- CodeForge Cloud APIs ---
  signInWithCloud: () => {
    return ipcRenderer.invoke("cloud:auth:start");
  },
  getCloudAccount: () => {
    return ipcRenderer.invoke("cloud:account:get");
  },
  deleteCloudAccount: () => {
    return ipcRenderer.invoke("cloud:account:delete");
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
  onCloseRequested: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("app:close-requested", listener);
    return () => ipcRenderer.removeListener("app:close-requested", listener);
  },
  resolveClose: (decision, remember) => {
    return ipcRenderer.invoke("app:close-decision", { decision, remember });
  },
  execCommand: (params) => {
    return ipcRenderer.invoke("shell:execCommand", params);
  },
  getRuntimeStatus: () => {
    return ipcRenderer.invoke("app:runtime-status");
  },
  // --- Settings surface ---
  getSettings: () => {
    return ipcRenderer.invoke("settings:get");
  },
  updateSettings: (payload) => {
    return ipcRenderer.invoke("settings:set", payload);
  },
  resetSettings: () => {
    return ipcRenderer.invoke("settings:reset");
  },
  getSystemInfo: () => {
    return ipcRenderer.invoke("app:getSystemInfo");
  },
  openDataFolder: () => {
    return ipcRenderer.invoke("app:openDataFolder");
  },
  showNotification: (payload) => {
    return ipcRenderer.invoke("notifications:show", payload);
  },
  refreshCatalog: () => {
    return ipcRenderer.invoke("catalog:refresh");
  },
  clearRecentProjects: () => {
    return ipcRenderer.invoke("project:clearRecent");
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);

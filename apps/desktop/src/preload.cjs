const { contextBridge, ipcRenderer } = require("electron");

// Startup-chain marks at verbose console level (see renderer/lifecycle.ts). Observation only:
// nothing is exposed to the page and nothing is read from the main process.
const lifecycleMark = (name) => {
  try { console.debug(`[codeforge:lifecycle] ${name} ${Date.now()}`); } catch { /* diagnostics only */ }
};
lifecycleMark("preload-entry");

// The local control-plane bearer is deliberately absent from this bridge: the main process
// attaches it to the primary window's own requests (see control-plane-trust.ts), so the
// renderer never holds a secret it could leak.
const api = {
  getRuntimeEndpoint: () => {
    return ipcRenderer.invoke("app:runtime-endpoint");
  },
  selectDirectory: () => {
    return ipcRenderer.invoke("dialog:selectDirectory");
  },
  getRecentProjects: () => {
    return ipcRenderer.invoke("project:getRecent");
  },
  removeRecentProject: (path) => {
    return ipcRenderer.invoke("project:removeRecent", path);
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
  connectOpenRouter: (browser) => {
    return ipcRenderer.invoke("oauth:openrouter:start", browser);
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
  onCloudAccountChanged: (callback) => {
    const listener = (_event, account) => callback(account);
    ipcRenderer.on("cloud:account:changed", listener);
    return () => ipcRenderer.removeListener("cloud:account:changed", listener);
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
  exportDiagnosticBundle: () => {
    return ipcRenderer.invoke("diagnostics:export");
  },
  showNotification: (payload) => {
    return ipcRenderer.invoke("notifications:show", payload);
  },
  refreshCatalog: () => {
    return ipcRenderer.invoke("catalog:refresh");
  },
  // --- R1 Free Cloud Platform: provider connections (schemas + state; never secret values) ---
  getProviderDefinitions: () => ipcRenderer.invoke("provider:definitions"),
  getProviderConnections: () => ipcRenderer.invoke("provider:connections"),
  listEnvironmentCredentials: () => ipcRenderer.invoke("provider:env:list"),
  getEnvironmentCredentialPolicy: () => ipcRenderer.invoke("provider:env:policy:get"),
  setEnvironmentCredentialPolicy: (policy) => ipcRenderer.invoke("provider:env:policy:set", policy),
  setEnvironmentCredentialEnabled: (providerId, enabled) => ipcRenderer.invoke("provider:env:setEnabled", providerId, enabled),
  refreshEnvironmentCredentials: () => ipcRenderer.invoke("provider:env:refresh"),
  importEnvironmentCredential: (providerId) => ipcRenderer.invoke("provider:env:import", providerId),
  validateProvider: (providerId, fields) => ipcRenderer.invoke("provider:validate", providerId, fields),
  connectProvider: (providerId, fields) => ipcRenderer.invoke("provider:connect", providerId, fields),
  getProviderCatalog: (providerId) => ipcRenderer.invoke("provider:catalog", providerId),
  disconnectProvider: (providerId) => ipcRenderer.invoke("provider:disconnect", providerId),
  attestProviderFreePlan: (providerId, attested) => ipcRenderer.invoke("provider:attestFreePlan", providerId, attested),
  setGeminiFreePolicyAccepted: (accepted) => ipcRenderer.invoke("provider:setGeminiFreePolicyAccepted", accepted),
  setProviderEnabledModels: (providerId, modelIds) => ipcRenderer.invoke("provider:setEnabledModels", providerId, modelIds),
  getFreeCloudOffer: () => ipcRenderer.invoke("freecloud:offer"),
  getFreeCloudSummary: () => ipcRenderer.invoke("freecloud:summary"),
  qualifyFreeCloud: () => ipcRenderer.invoke("freecloud:qualify"),
  onProviderChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("provider:changed", listener);
    return () => ipcRenderer.removeListener("provider:changed", listener);
  },
  clearRecentProjects: () => {
    return ipcRenderer.invoke("project:clearRecent");
  },
  // --- Extensions (managed host; manifests declare every capability) ---
  listExtensions: () => {
    return ipcRenderer.invoke("extensions:list");
  },
  setExtensionEnabled: (extensionId, enabled) => {
    return ipcRenderer.invoke("extensions:setEnabled", { extensionId, enabled });
  },
  uninstallExtension: (extensionId) => {
    return ipcRenderer.invoke("extensions:uninstall", extensionId);
  },
  loadExtensionFolder: () => {
    return ipcRenderer.invoke("extensions:loadDevFolder");
  },
  getExtensionSetting: (extensionId, key) => {
    return ipcRenderer.invoke("extensions:getSetting", { extensionId, key });
  },
  setExtensionSetting: (extensionId, key, value) => {
    return ipcRenderer.invoke("extensions:setSetting", { extensionId, key, value });
  },
  runExtensionCommand: (extensionId, commandId, args) => {
    return ipcRenderer.invoke("extensions:runCommand", { extensionId, commandId, args });
  },
  // --- Updater (electron-updater; status/check/download/install guarded by main) ---
  updaterGetStatus: () => {
    return ipcRenderer.invoke("updater:getStatus");
  },
  updaterCheck: () => {
    return ipcRenderer.invoke("updater:check");
  },
  updaterDownload: () => {
    return ipcRenderer.invoke("updater:download");
  },
  updaterInstall: () => {
    return ipcRenderer.invoke("updater:install");
  },
  // --- Remote marketplace (signed catalog; install requires the source's pinned key) ---
  marketplaceCatalog: () => {
    return ipcRenderer.invoke("marketplace:catalog");
  },
  marketplaceInstall: (sourceUrl, extensionId) => {
    return ipcRenderer.invoke("marketplace:install", { sourceUrl, extensionId });
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
lifecycleMark("preload-bridge-ready");

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
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;

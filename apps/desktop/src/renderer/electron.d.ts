import type { ElectronAPI } from "../preload.js";

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};

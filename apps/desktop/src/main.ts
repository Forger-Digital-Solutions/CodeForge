import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeForgeServer } from "@codeforge/server";
import { ForgeZero, createGenericFreeRecord, createMuseSparkRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, OpencodeAdapter, OpenRouterAdapter, createOpencodeAdapter, createOpenRouterAdapter, type CredentialStore, type ProviderHealthResponse } from "@codeforge/providers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: CodeForgeServer | null = null;
let mainWindow: BrowserWindow | null = null;
let firewall: ForgeZero | null = null;
let providerCatalog: InMemoryProviderCatalog | null = null;
let desktopCredentialStore: DesktopCredentialStore | null = null;

interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  lastOpened: string;
}

const RECENT_PROJECTS_KEY = "codeforge:recent-projects";
const PROVIDER_CREDENTIALS_KEY = "codeforge:provider-credentials";
const ONBOARDING_COMPLETED_KEY = "codeforge:onboarding-completed";

class DesktopCredentialStore implements CredentialStore {
  private credentials: Record<string, string> = {};

  constructor() {
    this.load();
  }

  private load(): void {
    this.credentials = getProviderCredentials();
  }

  get(providerId: string): string | undefined {
    return this.credentials[providerId];
  }

  set(providerId: string, credential: string): void {
    this.credentials[providerId] = credential;
    setProviderCredential(providerId, credential);
  }

  delete(providerId: string): boolean {
    delete this.credentials[providerId];
    deleteProviderCredential(providerId);
    return true;
  }

  has(providerId: string): boolean {
    return !!this.credentials[providerId];
  }

  reload(): void {
    this.load();
  }
}

function getRecentProjects(): ProjectInfo[] {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    if (fs.existsSync(storePath)) {
      const settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      return settings[RECENT_PROJECTS_KEY] || [];
    }
  } catch {
    // ignore
  }
  return [];
}

function saveRecentProject(project: ProjectInfo): void {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(storePath)) {
      settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    }
    const recent = (settings[RECENT_PROJECTS_KEY] as ProjectInfo[] | undefined) || [];
    const filtered = recent.filter((p) => p.path !== project.path);
    settings[RECENT_PROJECTS_KEY] = [project, ...filtered].slice(0, 10);
    fs.writeFileSync(storePath, JSON.stringify(settings, null, 2));
  } catch {
    // ignore
  }
}

function getProviderCredentials(): Record<string, string> {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    if (fs.existsSync(storePath)) {
      const settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      return (settings[PROVIDER_CREDENTIALS_KEY] as Record<string, string>) || {};
    }
  } catch {
    // ignore
  }
  return {};
}

function setProviderCredential(providerId: string, apiKey: string): void {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(storePath)) {
      settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    }
    const credentials = (settings[PROVIDER_CREDENTIALS_KEY] as Record<string, string>) || {};
    credentials[providerId] = apiKey;
    settings[PROVIDER_CREDENTIALS_KEY] = credentials;
    fs.writeFileSync(storePath, JSON.stringify(settings, null, 2));
  } catch {
    // ignore
  }
}

function deleteProviderCredential(providerId: string): void {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(storePath)) {
      settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    }
    const credentials = (settings[PROVIDER_CREDENTIALS_KEY] as Record<string, string>) || {};
    delete credentials[providerId];
    settings[PROVIDER_CREDENTIALS_KEY] = credentials;
    fs.writeFileSync(storePath, JSON.stringify(settings, null, 2));
  } catch {
    // ignore
  }
}

function getOnboardingCompleted(): boolean {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    if (fs.existsSync(storePath)) {
      const settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      return Boolean(settings[ONBOARDING_COMPLETED_KEY]);
    }
  } catch {
    // ignore
  }
  return false;
}

function setOnboardingCompleted(completed: boolean): void {
  try {
    const data = app.getPath("userData");
    const fs = require("node:fs");
    const storePath = path.join(data, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(storePath)) {
      settings = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    }
    settings[ONBOARDING_COMPLETED_KEY] = completed;
    fs.writeFileSync(storePath, JSON.stringify(settings, null, 2));
  } catch {
    // ignore
  }
}

async function selectDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Select Project Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0]!;
}

async function initializeServer(dbPath: string): Promise<void> {
  server = new CodeForgeServer({
    port: 3210,
    dbPath,
  });
  await server.start();
}

function registerFreeModels(fw: ForgeZero): void {
  fw.register(createGenericFreeRecord());
  fw.register(createMuseSparkRecord());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "CodeForge",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
    show: false,
    backgroundColor: "#1e1e2e",
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://localhost:3210")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  Menu.setApplicationMenu(null);

  const isDev = process.env.ELECTRON_DEV === "true";
  const rendererPath = isDev
    ? "http://localhost:5173"
    : `file://${path.join(__dirname, "renderer", "index.html")}`;

  mainWindow.loadURL(rendererPath);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  desktopCredentialStore = new DesktopCredentialStore();
  firewall = new ForgeZero();
  providerCatalog = new InMemoryProviderCatalog();
  
  // Register provider adapters with credentials from storage
  const credentials = getProviderCredentials();
  
  if (credentials.opencode) {
    const opencodeAdapter = createOpencodeAdapter({ credentialStore: desktopCredentialStore });
    providerCatalog.register(opencodeAdapter);
  }
  
  if (credentials.openrouter) {
    const openrouterAdapter = createOpenRouterAdapter({ credentialStore: desktopCredentialStore });
    providerCatalog.register(openrouterAdapter);
  }
  
  registerFreeModels(firewall);

  const dbPath = path.join(app.getPath("userData"), "codeforge.db");
  await initializeServer(dbPath);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (server) {
    server.stop();
    server = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("dialog:selectDirectory", async () => {
  return selectDirectory();
});

ipcMain.handle("project:getRecent", async () => {
  return getRecentProjects();
});

ipcMain.handle("project:open", async (_event, projectPath: string) => {
  const projectName = path.basename(projectPath);
  const project: ProjectInfo = {
    id: crypto.randomUUID(),
    path: projectPath,
    name: projectName,
    lastOpened: new Date().toISOString(),
  };
  saveRecentProject(project);
  return project;
});

ipcMain.handle("project:create", async () => {
  const selectedPath = await selectDirectory();
  if (!selectedPath) return null;

  const projectName = path.basename(selectedPath);
  const project: ProjectInfo = {
    id: crypto.randomUUID(),
    path: selectedPath,
    name: projectName,
    lastOpened: new Date().toISOString(),
  };
  saveRecentProject(project);
  return project;
});

ipcMain.handle("shell:openExternal", async (_event, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle("app:getVersion", () => {
  return app.getVersion();
});

ipcMain.handle("app:getPlatform", () => {
  return process.platform;
});

ipcMain.handle("provider:getCredentials", async () => {
  return getProviderCredentials();
});

ipcMain.handle("provider:setCredential", async (_event, providerId: string, apiKey: string) => {
  setProviderCredential(providerId, apiKey);
  desktopCredentialStore?.reload();
  
  // Re-register provider adapter if credentials were added
  if (providerCatalog && desktopCredentialStore) {
    if (providerId === "opencode" && apiKey) {
      const existing = providerCatalog.get("opencode");
      if (!existing) {
        const adapter = createOpencodeAdapter({ credentialStore: desktopCredentialStore });
        providerCatalog.register(adapter);
      }
    }
    if (providerId === "openrouter" && apiKey) {
      const existing = providerCatalog.get("openrouter");
      if (!existing) {
        const adapter = createOpenRouterAdapter({ credentialStore: desktopCredentialStore });
        providerCatalog.register(adapter);
      }
    }
  }
});

ipcMain.handle("provider:deleteCredential", async (_event, providerId: string) => {
  deleteProviderCredential(providerId);
  desktopCredentialStore?.reload();
});

ipcMain.handle("provider:testConnection", async (_event, providerId: string): Promise<{ status: string; error?: string }> => {
  if (!providerCatalog) {
    return { status: "error", error: "Provider catalog not initialized" };
  }
  
  const adapter = providerCatalog.get(providerId);
  if (!adapter) {
    return { status: "error", error: "Provider not registered" };
  }
  
  try {
    const health: ProviderHealthResponse = await adapter.healthCheck();
    return { status: health.status, error: health.error };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("onboarding:getCompleted", async () => {
  return getOnboardingCompleted();
});

ipcMain.handle("onboarding:setCompleted", async (_event, completed: boolean) => {
  setOnboardingCompleted(completed);
});

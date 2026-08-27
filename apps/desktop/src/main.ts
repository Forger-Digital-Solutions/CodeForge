import { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
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
const ALLOWED_PROVIDER_IDS = new Set(["opencode", "openrouter"]);
const MAX_API_KEY_LENGTH = 512;
const SETTINGS_FILE = "settings.json";

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

function isValidProviderId(id: unknown): id is string {
  return typeof id === "string" && ALLOWED_PROVIDER_IDS.has(id);
}

function isValidApiKey(key: unknown): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_API_KEY_LENGTH;
}

function getStorePath(): string {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function readSettings(): Record<string, unknown> {
  try {
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) return {};
    const raw = fs.readFileSync(storePath, "utf-8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettingsAtomic(settings: Record<string, unknown>): void {
  const storePath = getStorePath();
  const tmpPath = `${storePath}.tmp`;
  const data = JSON.stringify(settings, null, 2);
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, storePath);
    try {
      fs.chmodSync(storePath, 0o600);
    } catch {
      // Windows ignores chmod; best-effort
    }
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function decryptCredential(value: string): string {
  if (!value) return value;
  if (value.startsWith("enc:")) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(value.slice(4), "base64");
        return safeStorage.decryptString(buf);
      }
    } catch {
      // fall through to plaintext fallback
    }
  }
  return value;
}

function encryptCredential(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(value);
      return `enc:${buf.toString("base64")}`;
    }
  } catch {
    // fallback to plaintext
  }
  return value;
}

function getRecentProjects(): ProjectInfo[] {
  const settings = readSettings();
  const recent = settings[RECENT_PROJECTS_KEY];
  if (!Array.isArray(recent)) return [];
  return recent.filter(
    (p): p is ProjectInfo =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as ProjectInfo).path === "string" &&
      typeof (p as ProjectInfo).id === "string",
  );
}

function saveRecentProject(project: ProjectInfo): void {
  if (typeof project.path !== "string" || project.path.length === 0 || project.path.length > 1024) return;
  const settings = readSettings();
  const recent = Array.isArray(settings[RECENT_PROJECTS_KEY])
    ? (settings[RECENT_PROJECTS_KEY] as ProjectInfo[])
    : [];
  const filtered = recent.filter((p) => typeof p.path === "string" && p.path !== project.path);
  settings[RECENT_PROJECTS_KEY] = [project, ...filtered].slice(0, 10);
  writeSettingsAtomic(settings);
}

function getProviderCredentials(): Record<string, string> {
  const settings = readSettings();
  const raw = settings[PROVIDER_CREDENTIALS_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_PROVIDER_IDS.has(k)) continue;
    if (typeof v !== "string") continue;
    result[k] = decryptCredential(v);
  }
  return result;
}

function getProviderCredentialStatus(): Record<string, boolean> {
  const creds = getProviderCredentials();
  return {
    opencode: !!creds.opencode,
    openrouter: !!creds.openrouter,
  };
}

function setProviderCredential(providerId: string, apiKey: string): void {
  if (!isValidProviderId(providerId)) throw new Error(`Invalid providerId: ${providerId}`);
  if (!isValidApiKey(apiKey)) throw new Error("Invalid API key");
  const settings = readSettings();
  const raw = settings[PROVIDER_CREDENTIALS_KEY];
  const credentials: Record<string, string> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, string>) }
      : {};
  // Use Object prototype-safe assignment
  Object.defineProperty(credentials, providerId, {
    value: encryptCredential(apiKey),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  settings[PROVIDER_CREDENTIALS_KEY] = credentials;
  writeSettingsAtomic(settings);
}

function deleteProviderCredential(providerId: string): void {
  if (!isValidProviderId(providerId)) throw new Error(`Invalid providerId: ${providerId}`);
  const settings = readSettings();
  const raw = settings[PROVIDER_CREDENTIALS_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const credentials = { ...(raw as Record<string, string>) };
  delete credentials[providerId];
  settings[PROVIDER_CREDENTIALS_KEY] = credentials;
  writeSettingsAtomic(settings);
}

function getOnboardingCompleted(): boolean {
  const settings = readSettings();
  return settings[ONBOARDING_COMPLETED_KEY] === true;
}

function setOnboardingCompleted(completed: boolean): void {
  if (typeof completed !== "boolean") throw new Error("Invalid onboarding value");
  const settings = readSettings();
  settings[ONBOARDING_COMPLETED_KEY] = completed;
  writeSettingsAtomic(settings);
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
  // Share the desktop's firewall and provider catalog with the server so that
  // the real autonomous workflow (Workflow ↔ AgentRuntime) uses the same
  // ForgeZero-verified free models and authenticated provider credentials.
  // This connects the desktop execution path to the real runtime.
  const hasCredentials = !!providerCatalog && (providerCatalog.get("opencode") || providerCatalog.get("openrouter"));
  server = new CodeForgeServer({
    port: 3210,
    dbPath,
    firewall: firewall ?? undefined,
    providerCatalog: providerCatalog ?? undefined,
    useRealRuntime: hasCredentials ? true : undefined,
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
    try {
      const parsed = new URL(url);
      const allowedOrigin = "http://localhost:3210";
      const isFile = parsed.protocol === "file:";
      const isAllowedHttp = parsed.origin === allowedOrigin;
      if (!isFile && !isAllowedHttp) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
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
  if (typeof projectPath !== "string" || projectPath.length === 0 || projectPath.length > 1024) {
    throw new Error("Invalid project path");
  }
  const normalized = path.normalize(projectPath);
  if (normalized.includes("\0")) throw new Error("Invalid project path");
  const projectName = path.basename(normalized);
  const project: ProjectInfo = {
    id: crypto.randomUUID(),
    path: normalized,
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
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Unsupported protocol");
    if (parsed.protocol === "http:" && parsed.hostname !== "localhost") throw new Error("http only allowed for localhost");
    await shell.openExternal(url);
  } catch {
    throw new Error("Invalid URL");
  }
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

ipcMain.handle("provider:getCredentialStatus", async () => {
  return getProviderCredentialStatus();
});

ipcMain.handle("provider:setCredential", async (_event, providerId: string, apiKey: string) => {
  if (!isValidProviderId(providerId)) throw new Error("Invalid providerId");
  if (!isValidApiKey(apiKey)) throw new Error("Invalid API key");
  setProviderCredential(providerId, apiKey);
  desktopCredentialStore?.reload();

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
  if (!isValidProviderId(providerId)) throw new Error("Invalid providerId");
  deleteProviderCredential(providerId);
  desktopCredentialStore?.reload();
});

ipcMain.handle("provider:testConnection", async (_event, providerId: string): Promise<{ status: string; error?: string }> => {
  if (!isValidProviderId(providerId)) {
    return { status: "error", error: "Invalid providerId" };
  }
  if (!providerCatalog) {
    return { status: "error", error: "Provider catalog not initialized" };
  }

  const adapter = providerCatalog.get(providerId);
  if (!adapter) {
    return { status: "error", error: "Provider not registered" };
  }

  try {
    const health: ProviderHealthResponse = await adapter.healthCheck();
    const safeError = health.error ? health.error.slice(0, 200) : undefined;
    return { status: health.status, error: safeError };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", error: msg.slice(0, 200) };
  }
});

ipcMain.handle("onboarding:getCompleted", async () => {
  return getOnboardingCompleted();
});

ipcMain.handle("onboarding:setCompleted", async (_event, completed: boolean) => {
  if (typeof completed !== "boolean") throw new Error("Invalid onboarding value");
  setOnboardingCompleted(completed);
});

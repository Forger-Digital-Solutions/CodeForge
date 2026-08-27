import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeForgeServer } from "@codeforge/server";
import { ForgeZero, createGenericFreeRecord, createMuseSparkRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: CodeForgeServer | null = null;
let mainWindow: BrowserWindow | null = null;
let firewall: ForgeZero | null = null;
let providerCatalog: InMemoryProviderCatalog | null = null;

interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  lastOpened: string;
}

const RECENT_PROJECTS_KEY = "codeforge:recent-projects";

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
  firewall = new ForgeZero();
  providerCatalog = new InMemoryProviderCatalog();
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

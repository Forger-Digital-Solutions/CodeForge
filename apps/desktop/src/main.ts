import { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";

if (process.env.CODEFORGE_SMOKE_OUT) {
  try {
    fs.appendFileSync(process.env.CODEFORGE_SMOKE_OUT, "MAIN_TS_LOADED\n", "utf8");
  } catch {}
}

import { CodeForgeServer } from "@codeforge/server";
import { ForgeZero, createGenericFreeRecord, createMuseSparkRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider, createOpencodeAdapter, createOpenRouterAdapter, type CredentialStore, type ProviderHealthResponse, type StreamEvent } from "@codeforge/providers";

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
const PACKAGED_SMOKE = process.env.CODEFORGE_PACKAGED_SMOKE === "1";

function smokeRecord(line: string): void {
  const outputPath = process.env.CODEFORGE_SMOKE_OUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${line}\n`, "utf8");
}

function createSmokeToolCall(toolName: string, args: Record<string, unknown>, id: string): StreamEvent[] {
  const serialized = JSON.stringify(args);
  return [
    { type: "tool_call_started", toolCallId: id, toolName },
    { type: "tool_call_delta", toolCallId: id, delta: serialized },
    { type: "tool_call_completed", toolCallId: id, toolName, arguments: serialized },
  ];
}

function registerPackagedSmokeProvider(catalog: InMemoryProviderCatalog): void {
  const workspacePath = process.env.CODEFORGE_SMOKE_WORKSPACE;
  if (!PACKAGED_SMOKE || !workspacePath) return;
  process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";
  const targetPath = path.join(workspacePath, "src", "calc.ts");
  if (!fs.existsSync(targetPath)) return;
  const original = fs.readFileSync(targetPath, "utf8");
  const wrong = original.replace("a - b", "a * b");
  const originalHash = crypto.createHash("sha256").update(original, "utf8").digest("hex");
  const wrongHash = crypto.createHash("sha256").update(wrong, "utf8").digest("hex");
  const finishToolCalls = { type: "finish", finishReason: "tool_calls" } as StreamEvent;
  const finishStop = { type: "finish", finishReason: "stop" } as StreamEvent;

  catalog.register(createMockProvider({
    providerId: "codeforge",
    models: [{
      modelId: "free-model-1",
      displayName: "CodeForge Packaged Smoke",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      isFree: true,
      freeStatus: "verified_free",
    }],
    streamEvents: [
      [...createSmokeToolCall("read_file", { path: "src/calc.ts" }, "smoke-read-1"), finishToolCalls],
      [...createSmokeToolCall("edit_file", {
        path: "src/calc.ts",
        oldText: "  return a - b;",
        newText: "  return a * b;",
        expectedHash: originalHash,
      }, "smoke-edit-1"), finishToolCalls],
      [{ type: "text_delta", delta: "Initial proposal applied" }, finishStop],
      [...createSmokeToolCall("read_file", { path: "src/calc.ts" }, "smoke-read-2"), finishToolCalls],
      [...createSmokeToolCall("edit_file", {
        path: "src/calc.ts",
        oldText: "  return a * b;",
        newText: "  return a + b;",
        expectedHash: wrongHash,
      }, "smoke-edit-2"), finishToolCalls],
      [{ type: "text_delta", delta: "Bounded repair applied" }, finishStop],
    ],
  }));
}

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

function decryptCredential(value: string): string | undefined {
  if (!value) return value;
  if (value.startsWith("enc:")) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(value.slice(4), "base64");
        return safeStorage.decryptString(buf);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  return value;
}

function encryptCredential(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable; the credential was not saved.");
  }
  const buf = safeStorage.encryptString(value);
  return `enc:${buf.toString("base64")}`;
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
    const decrypted = decryptCredential(v);
    if (decrypted !== undefined) result[k] = decrypted;
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
  smokeRecord("INIT_SERVER_START");
  try {
    const hasCredentials = !!providerCatalog && (
      providerCatalog.get("opencode") ||
      providerCatalog.get("openrouter")
    );
    smokeRecord(`INIT_SERVER_HAS_CREDS_${Boolean(hasCredentials)}`);
    server = new CodeForgeServer({
      port: 3210,
      dbPath,
      firewall: firewall ?? undefined,
      providerCatalog: providerCatalog ?? undefined,
      useRealRuntime: hasCredentials ? true : undefined,
    });
    smokeRecord("INIT_SERVER_INSTANCE_CREATED");
    await server.start();
    const recent = getRecentProjects()[0];
    if (recent && fs.existsSync(recent.path)) {
      try {
        server.setWorkspace(recent.path);
      } catch {
        // ignore
      }
    }
    smokeRecord("INIT_SERVER_STARTED");
  } catch (err) {
    smokeRecord(`INIT_SERVER_ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    throw err;
  }
}

function registerFreeModels(fw: ForgeZero): void {
  fw.register(createGenericFreeRecord());
  fw.register(createMuseSparkRecord());
}

function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.png"),
    path.join(__dirname, "assets", "icon.ico"),
    path.join(__dirname, "assets", "icon.png"),
    process.resourcesPath ? path.join(process.resourcesPath, "assets", "icon.ico") : "",
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try next candidate
    }
  }
  return undefined;
}

function createWindow(): void {
  smokeRecord("CREATE_WINDOW_START");
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "CodeForge",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
    show: false,
    backgroundColor: "#0f1012",
  });

  mainWindow.once("ready-to-show", () => {
    smokeRecord("WINDOW_READY_TO_SHOW");
    mainWindow?.show();
  });

  // Handle in-window navigation (plain <a href> clicks, form submissions, etc.)
  // The renderer is a single-page app: internal navigation stays in-window, and any
  // external link is opened in the user's real browser via the OS instead of
  // replacing the app. Without the shell.openExternal() call here, external links
  // were silently swallowed (preventDefault with no handoff) — the "dead links" bug.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      const allowedOrigin = "http://localhost:3210";
      const isFile = parsed.protocol === "file:";
      const isAllowedHttp = parsed.origin === allowedOrigin;

      // Allow internal navigation (file: or localhost:3210) to proceed in-window.
      if (isFile || isAllowedHttp) {
        return;
      }

      // Everything else must never replace the app window.
      event.preventDefault();

      // Hand safe external links (https, or http on localhost) to the OS browser.
      if (parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost")) {
        void shell.openExternal(url);
      }
      // All other schemes (javascript:, data:, file: to elsewhere, etc.) are dropped.
    } catch {
      event.preventDefault();
    }
  });

  // Handle window.open() and target="_blank" links
  mainWindow.webContents.setWindowOpenHandler(({ url, disposition }) => {
    try {
      const parsed = new URL(url);
      const allowedOrigin = "http://localhost:3210";
      const isFile = parsed.protocol === "file:";
      const isAllowedHttp = parsed.origin === allowedOrigin;

      // Allow internal navigation in new window
      if (isFile || isAllowedHttp) {
        return { action: "allow" };
      }

      // Only allow https: (and http: for localhost) for external links
      if (parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost")) {
        shell.openExternal(url);
      }
      // Deny all other schemes (javascript:, data:, etc.)
      return { action: "deny" };
    } catch {
      return { action: "deny" };
    }
  });

  Menu.setApplicationMenu(null);

  const isDev = process.env.ELECTRON_DEV === "true";
  const rendererPath = isDev
    ? "http://localhost:5173"
    : `file://${path.join(__dirname, "renderer", "index.html")}`;

  smokeRecord(`LOAD_URL_${rendererPath}`);
  mainWindow.loadURL(rendererPath);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRenderer(): Promise<void> {
  smokeRecord("WAIT_RENDERER_START");
  const window = mainWindow;
  if (!window) throw new Error("Main window was not created");
  if (window.webContents.isLoadingMainFrame()) {
    await new Promise<void>((resolve, reject) => {
      window.webContents.once("did-finish-load", () => resolve());
      window.webContents.once("did-fail-load", (_event, code, description) => {
        reject(new Error(`Renderer load failed (${code}): ${description}`));
      });
    });
  }
  smokeRecord("WAIT_RENDERER_FRAME_LOADED");
  await delay(150);
}

async function reloadRenderer(): Promise<void> {
  const window = mainWindow;
  if (!window) throw new Error("Main window was not created");
  const loaded = new Promise<void>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.once("did-fail-load", (_event, code, description) => {
      reject(new Error(`Renderer reload failed (${code}): ${description}`));
    });
  });
  window.webContents.reload();
  await loaded;
  await delay(250);
}

async function evaluateRenderer<T>(source: string): Promise<T> {
  const window = mainWindow;
  if (!window) throw new Error("Main window was not created");
  return window.webContents.executeJavaScript(source, true) as Promise<T>;
}

async function apiJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost:3210${pathname}`, init);
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for packaged smoke condition");
}

async function waitForTask(taskId: string, sessionId: string, resolveApprovals: boolean): Promise<{ phase: string; status: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (resolveApprovals) {
      const snapshot = await apiJson(`/api/sessions/${sessionId}`);
      for (const approval of snapshot.body?.pendingApprovals ?? []) {
        smokeRecord(`RESOLVING_APPROVAL_${approval.approvalId}`);
        await apiJson(`/api/approvals/${approval.approvalId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow_once" }),
        });
      }
    }
    const workflow = await apiJson(`/api/workflow/${taskId}`);
    const task = workflow.body?.task as { phase: string; status: string; error?: string; summary?: string };
    if (task && ["completed", "failed", "cancelled"].includes(task.phase)) {
      smokeRecord(`TASK_TERMINAL_PHASE_${task.phase}_SUMMARY_${task.summary ?? ""}_ERROR_${task.error ?? ""}`);
      return task;
    }
    await delay(100);
  }
  throw new Error("Packaged workflow did not reach a terminal state");
}

async function rendererWorkflowRequest(payload: Record<string, unknown>, endpoint = "/api/workflow/run"): Promise<any> {
  const serialized = JSON.stringify(payload).replace(/</g, "\\u003c");
  return evaluateRenderer<any>(`fetch("http://localhost:3210${endpoint}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(${serialized})
  }).then(async response => ({ status: response.status, body: await response.json() }))`);
}

function verifyCredentialPersistence(testSecret: string): void {
  const raw = fs.readFileSync(getStorePath(), "utf8");
  if (raw.includes(testSecret)) throw new Error("Credential was written in plaintext");
  if (!raw.includes("enc:")) throw new Error("Encrypted credential payload was not persisted");
  smokeRecord("credential_plaintext_absent=PASS");
  smokeRecord("credential_encrypted_payload=PASS");
}

function verifyCorruptCredentialFailsClosed(): void {
  const storePath = getStorePath();
  const original = fs.readFileSync(storePath, "utf8");
  const parsed = JSON.parse(original) as Record<string, unknown>;
  const credentials = { ...((parsed[PROVIDER_CREDENTIALS_KEY] as Record<string, string> | undefined) ?? {}) };
  credentials.opencode = "enc:not-valid-encrypted-data";
  parsed[PROVIDER_CREDENTIALS_KEY] = credentials;
  writeSettingsAtomic(parsed);
  desktopCredentialStore?.reload();
  if (getProviderCredentialStatus().opencode) throw new Error("Corrupt encrypted credential was accepted");
  fs.writeFileSync(storePath, original, "utf8");
  desktopCredentialStore?.reload();
  smokeRecord("corrupt_credential_fails_closed=PASS");
}

async function runPackagedFullSmoke(workspacePath: string, testSecret: string): Promise<void> {
  await waitForCondition(async () =>
    (await evaluateRenderer<string>("document.body.innerText")).includes("Welcome to CodeForge"),
  );
  const firstRunText = await evaluateRenderer<string>("document.body.innerText");
  if (!firstRunText.includes("Welcome to CodeForge")) throw new Error("Packaged first-run onboarding was not visible");
  if (!firstRunText.includes("OpenCode Zen") || !firstRunText.includes("OpenRouter")) {
    throw new Error("Packaged provider metadata was not visible");
  }
  const bridgeBoundary = await evaluateRenderer<boolean>(
    "Boolean(window.electronAPI) && typeof window.electronAPI.getProviderCredentials === 'undefined'",
  );
  if (!bridgeBoundary) throw new Error("Renderer credential boundary is not enforced");
  smokeRecord("packaged_welcome=PASS");
  smokeRecord("packaged_provider_metadata=PASS");
  smokeRecord("renderer_raw_credential_api_absent=PASS");

  await waitForCondition(async () => {
    const text = await evaluateRenderer<string>("document.body.innerText");
    await evaluateRenderer<void>(`(() => {
      const b = Array.from(document.querySelectorAll("button")).find(b => b.textContent && b.textContent.includes("Configure Providers"));
      if (b) { b.click(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
    })()`);
    return text.toLowerCase().includes("api key");
  });
  smokeRecord("packaged_provider_setup_ui=PASS");

  await evaluateRenderer<void>(`window.electronAPI.setOnboardingCompleted(true)`);
  await evaluateRenderer<void>(`window.electronAPI.openProject(${JSON.stringify(workspacePath)})`);
  await reloadRenderer();
  await waitForCondition(async () => (await evaluateRenderer<string>("document.body.innerText")).toLowerCase().includes(path.basename(workspacePath).toLowerCase()));
  await waitForCondition(async () => (await apiJson("/api/workspace/tree")).status === 200);
  const escape = await apiJson(`/api/workspace/tree?path=${encodeURIComponent(path.dirname(workspacePath))}`);
  if (escape.status !== 403) throw new Error(`Workspace escape returned ${escape.status}`);
  smokeRecord("packaged_workspace_restore=PASS");
  smokeRecord("packaged_workspace_escape_blocked=PASS");

  const workflow = await rendererWorkflowRequest({
    sessionId: "packaged-workflow",
    message: "Fix add function through packaged failure repair pass",
    forceHeuristic: true,
    verificationCommands: [
      "node -e \"const c=require('fs').readFileSync('src/calc.ts','utf8');if(c.includes('a + b')){console.log('1 passed')}else{console.log('1 failed');console.log('FAIL src/calc.ts');process.exit(1)}\"",
    ],
  });
  if (workflow.status !== 200) throw new Error(`Packaged workflow start returned ${workflow.status}: ${JSON.stringify(workflow.body)}`);
  const terminal = await waitForTask(workflow.body.taskId, "packaged-workflow", true);
  if (terminal.phase !== "completed") throw new Error(`Packaged workflow ended in ${terminal.phase}`);
  const fixed = fs.readFileSync(path.join(workspacePath, "src", "calc.ts"), "utf8");
  if (!fixed.includes("a + b")) throw new Error("Packaged workflow did not apply the repaired file content");
  const session = await apiJson("/api/sessions/packaged-workflow");
  const repairingSeen = JSON.stringify(session.body.events).includes("repairing");
  if (!repairingSeen) throw new Error("Packaged workflow did not traverse bounded repair");
  smokeRecord("packaged_workflow=PASS");
  smokeRecord("packaged_failure_repair_pass=PASS");

  await delay(300);
  for (let reload = 0; reload < 5; reload++) {
    await reloadRenderer();
    await waitForCondition(async () => {
      const text = await evaluateRenderer<string>("document.body.innerText");
      return text.toLowerCase().includes("completed");
    });
  }
  smokeRecord("packaged_renderer_reload_count=5");
  smokeRecord("packaged_renderer_reload=PASS");

  await evaluateRenderer<void>(`window.electronAPI.setProviderCredential("opencode", ${JSON.stringify(testSecret)})`);
  const status = await evaluateRenderer<Record<string, boolean>>(`window.electronAPI.getProviderCredentialStatus()`);
  if (!status.opencode) throw new Error("Packaged credential status was not persisted");
  verifyCredentialPersistence(testSecret);
  smokeRecord("safe_storage_available=PASS");
  smokeRecord("credential_round_trip=PASS");
  smokeRecord("PACKAGED_FULL_SMOKE_OK");
}

async function runPackagedInterruptionSmoke(): Promise<void> {
  await waitForCondition(async () => {
    const restored = await evaluateRenderer<string>("document.body.innerText");
    return restored.toLowerCase().includes("completed");
  });
  const workflow = await rendererWorkflowRequest({
    sessionId: "packaged-interrupt",
    message: "Implement multi file feature for restart interruption",
    forceHeuristic: true,
    verificationCommands: ["node -e \"process.exit(0)\""],
  });
  if (workflow.status !== 200) throw new Error("Interrupt workflow did not start");
  await waitForCondition(async () => {
    const snapshot = await apiJson("/api/sessions/packaged-interrupt");
    return (snapshot.body.pendingApprovals?.length ?? 0) > 0;
  });
  smokeRecord("electron_restart_interruption_ready=PASS");
  smokeRecord("PACKAGED_INTERRUPT_EXPECTED_EXIT");
  app.exit(73);
}

async function runPackagedRecoverySmoke(testSecret: string): Promise<void> {
  const recovered = await apiJson("/api/sessions/packaged-interrupt");
  if (recovered.body.session?.status !== "failed") throw new Error("Interrupted session was not failed safely");
  if ((recovered.body.pendingApprovals?.length ?? 0) !== 0) throw new Error("Interrupted approval survived restart");
  if (!JSON.stringify(recovered.body.events).includes("recovery_required")) {
    throw new Error("Recovery-required event was not reconstructed");
  }
  smokeRecord("electron_restart_failed_safely=PASS");
  smokeRecord("electron_restart_no_approval_replay=PASS");

  const credentialStatus = await evaluateRenderer<Record<string, boolean>>(`window.electronAPI.getProviderCredentialStatus()`);
  if (!credentialStatus.opencode) throw new Error("Encrypted credential did not decrypt after restart");
  if (desktopCredentialStore?.get("opencode") !== testSecret) throw new Error("Restarted credential did not match the encrypted smoke value");
  verifyCredentialPersistence(testSecret);
  verifyCorruptCredentialFailsClosed();
  smokeRecord("credential_restart_decrypt=PASS");

  const fresh = await rendererWorkflowRequest({
    sessionId: "packaged-fresh",
    message: "Document current add function after restart recovery",
    useWorkflow: true,
    forceHeuristic: true,
    verificationCommands: ["node -e \"process.exit(0)\""],
  }, "/api/send");
  if (fresh.status !== 200 || !fresh.body.taskId) throw new Error("Fresh workflow could not start after recovery");
  const terminal = await waitForTask(fresh.body.taskId, "packaged-fresh", true);
  if (terminal.phase !== "completed") throw new Error("Fresh post-restart workflow did not complete");
  smokeRecord("electron_restart_fresh_task=PASS");
  smokeRecord("PACKAGED_RECOVERY_SMOKE_OK");
}

async function runPackagedSmoke(): Promise<void> {
  const mode = process.env.CODEFORGE_PACKAGED_SMOKE_MODE ?? "full";
  const workspacePath = process.env.CODEFORGE_SMOKE_WORKSPACE;
  const testSecret = process.env.CODEFORGE_TEST_SECRET;
  if (!app.isPackaged) throw new Error("Packaged smoke was not running from a packaged executable");
  if (!workspacePath || !testSecret) throw new Error("Packaged smoke inputs are missing");
  await waitForRenderer();
  smokeRecord(`smoke_mode=${mode}`);
  smokeRecord(`smoke_run_id=${process.env.CODEFORGE_SMOKE_RUN_ID ?? "missing"}`);
  smokeRecord(`electron_version=${process.versions.electron}`);
  smokeRecord(`electron_node_version=${process.versions.node}`);
  smokeRecord(`app_is_packaged=${app.isPackaged}`);
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage encryption is unavailable");

  if (mode === "full") await runPackagedFullSmoke(workspacePath, testSecret);
  else if (mode === "interrupt") {
    await runPackagedInterruptionSmoke();
    return;
  } else if (mode === "recover") await runPackagedRecoverySmoke(testSecret);
  else throw new Error(`Unknown packaged smoke mode: ${mode}`);

  if (server) {
    await server.stop();
    server = null;
  }
  app.exit(0);
}

app.whenReady().then(async () => {
  smokeRecord("WHEN_READY_START");
  desktopCredentialStore = new DesktopCredentialStore();
  smokeRecord("WHEN_READY_CRED_STORE_DONE");
  firewall = new ForgeZero();
  smokeRecord("WHEN_READY_FIREWALL_DONE");
  providerCatalog = new InMemoryProviderCatalog();
  smokeRecord("WHEN_READY_CATALOG_DONE");
  registerPackagedSmokeProvider(providerCatalog);
  smokeRecord("WHEN_READY_SMOKE_PROV_DONE");

  // Register provider adapters with credentials from storage
  const credentials = getProviderCredentials();
  smokeRecord("WHEN_READY_CREDS_LOADED");

  // NOTE: Do NOT register a scripted/mock provider for "codeforge" here.
  // createMockProvider() is a test-only adapter and ForgeZero's provider
  // isolation guard (assertRegistrable) refuses to register it outside test
  // mode — doing so threw TestProviderIsolationError and crashed startup before
  // the window opened. The free/GEMS/paid model *records* are still registered
  // with the firewall (registerFreeModels / server catalog) so the model
  // selector populates. With no real provider credentials the server falls back
  // to the demo runtime, which drives a visible scripted task so the workspace
  // is usable out of the box; connecting OpenCode/OpenRouter switches it to the
  // real runtime.
  if (credentials.opencode && !PACKAGED_SMOKE) {
    const opencodeAdapter = createOpencodeAdapter({ credentialStore: desktopCredentialStore });
    providerCatalog.register(opencodeAdapter);
  }

  if (credentials.openrouter && !PACKAGED_SMOKE) {
    const openrouterAdapter = createOpenRouterAdapter({ credentialStore: desktopCredentialStore });
    providerCatalog.register(openrouterAdapter);
  }

  registerFreeModels(firewall);
  smokeRecord("WHEN_READY_MODELS_REGISTERED");

  const dbPath = path.join(app.getPath("userData"), "codeforge.db");
  smokeRecord(`WHEN_READY_DBPATH_${dbPath}`);
  await initializeServer(dbPath);
  smokeRecord("WHEN_READY_SERVER_INITIALIZED");

  createWindow();
  smokeRecord("WHEN_READY_WINDOW_CREATED");

  if (PACKAGED_SMOKE) {
    smokeRecord("WHEN_READY_LAUNCHING_SMOKE");
    void runPackagedSmoke().catch((error) => {
      smokeRecord(`PACKAGED_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    });
  }

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
  try {
    server?.setWorkspace(normalized);
  } catch {
    // Ignore workspace set failure if path doesn't exist
  }
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
  try {
    server?.setWorkspace(selectedPath);
  } catch {
    // Ignore workspace set failure if path doesn't exist
  }
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

ipcMain.handle("provider:getCredentialStatus", async () => {
  return getProviderCredentialStatus();
});

ipcMain.handle("provider:setCredential", async (_event, providerId: string, apiKey: string) => {
  if (!isValidProviderId(providerId)) throw new Error("Invalid providerId");
  if (!isValidApiKey(apiKey)) throw new Error("Invalid API key");
  setProviderCredential(providerId, apiKey);
  desktopCredentialStore?.reload();

  if (providerCatalog && desktopCredentialStore && !PACKAGED_SMOKE) {
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

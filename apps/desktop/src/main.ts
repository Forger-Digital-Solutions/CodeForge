import { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage, Tray, nativeImage, screen, Notification } from "electron";
import { resolveCloudCatalogSyncMode } from "./cloud-catalog-sync.js";
import { checkGitExecArgs } from "./git-exec-allowlist.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { resolveCloseAction, summarizeActiveWork, countRunningWork, type CloseBehavior } from "./close-lifecycle.js";
import {
  APP_SETTINGS_KEY,
  CloseBehaviorSchema,
  applySettingsPatch,
  parseAppSettings,
  parseAppSettingsPatch,
  type AppSettings,
  type SettingsSnapshot,
} from "./app-settings.js";

if (process.env.CODEFORGE_SMOKE_OUT) {
  try {
    fs.appendFileSync(process.env.CODEFORGE_SMOKE_OUT, "MAIN_TS_LOADED\n", "utf8");
  } catch {}
}

import { CodeForgeServer, type CodeForgeRuntimeStatus } from "@codeforge/server";
import { ForgeZero, createGenericFreeRecord, type ProviderAvailabilityOracle } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider, createOpencodeAdapter, createOpenRouterAdapter, createProviderAdapterById, HostedProviderAdapter, type ProviderAdapter, type CredentialStore, type ProviderHealthResponse, type StreamEvent } from "@codeforge/providers";
import { NormalizedModelRegistry, discoverAndVerifyFree, verifyAllowanceViaProbe, getProviderPolicy, type LiveModelInfo } from "@codeforge/model-registry";
import { runOpenRouterOAuth } from "./openrouter-oauth-flow.js";
import { describeCloudAuthFailure, CloudAuthError, runCodeForgeCloudAuth, type CloudAuthResult } from "./cloud-auth-flow.js";
import {
  installSingleInstanceGuard,
  activateWindow,
  bindErrorCode,
  describeStartupFailure,
} from "./single-instance.js";
import {
  resolveCloudEndpoint,
  parseCloudEndpointManifest,
  describeCloudEndpoint,
  CloudEndpointError,
  type CloudEndpointManifest,
} from "./cloud-endpoint.js";
import { parsePersistedWindowState, restoreWindowState, type PersistedWindowState } from "./window-state.js";

// Some Windows environments ship an Electron-incompatible graphics stack. CodeForge's
// renderer does not require GPU acceleration, so prefer a reliable software compositor over
// allowing Chromium's GPU subprocess to take down the packaged desktop before first paint.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
// Some Windows installations still spawn a GPU utility process after the Electron
// hardware-acceleration opt-out and fail before first paint when ANGLE DLLs are absent.
// Keep the software compositor in-process so packaged startup remains usable there.
app.commandLine.appendSwitch("in-process-gpu");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: CodeForgeServer | null = null;
let mainWindow: BrowserWindow | null = null;
let firewall: ForgeZero | null = null;
let providerCatalog: InMemoryProviderCatalog | null = null;
let desktopCredentialStore: DesktopCredentialStore | null = null;
let modelRegistry: NormalizedModelRegistry | null = null;
let tray: Tray | null = null;
let trayStatusTimer: NodeJS.Timeout | null = null;
let isQuitting = false;
let closeRequestInFlight = false;
let shutdownPromise: Promise<void> | null = null;
let cloudCatalogRefreshTimer: NodeJS.Timeout | null = null;
/** Mirrors CloudProviderRegistry's own DEFAULT_REFRESH_TTL_MS on the cloud side. */
const CLOUD_CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Per-provider auth/health signal used by the orphan-model oracle and to exclude
// invalid-auth providers from routing (a 401 marks a provider auth_required — it is
// never hammered on every task; the UI prompts to reconnect).
const providerAuthState = new Map<string, "ok" | "auth_required" | "rate_limited">();

interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  lastOpened: string;
}

const RECENT_PROJECTS_KEY = "codeforge:recent-projects";
const PROVIDER_CREDENTIALS_KEY = "codeforge:provider-credentials";
const ONBOARDING_COMPLETED_KEY = "codeforge:onboarding-completed";
// R1 legal remediation (ENG-P1-02 age gate, ENG-P1-03 host-execution disclosure). Deliberately
// separate from ONBOARDING_COMPLETED_KEY: that flag is a general product-tour concept that could
// be repurposed later, whereas this one carries actual evidentiary weight (R1 spec §34) and must
// keep its own stable meaning.
const FIRST_RUN_LEGAL_ACK_KEY = "codeforge:first-run-legal-ack";
const CLOUD_ACCESS_TOKEN_KEY = "codeforge:cloud-access-token";
const CLOUD_REFRESH_TOKEN_KEY = "codeforge:cloud-refresh-token";
const CLOUD_USER_KEY = "codeforge:cloud-user";
const WINDOW_STATE_KEY = "codeforge:window-state";
const CLOSE_BEHAVIOR_KEY = "codeforge:close-behavior";
/**
 * Resolve the Cloud endpoint ONCE, in the main process, from the build manifest. The renderer has no
 * IPC channel that accepts a Cloud URL, and a packaged staging/production build ignores the
 * environment override entirely — so privileged authentication and accounting traffic cannot be
 * redirected by anything the user or a page can reach.
 */
function loadCloudEndpointManifest(): CloudEndpointManifest {
  // Packaged builds read the manifest from the app resources; from source it sits next to package.json.
  const candidates = [
    path.join(app.getAppPath(), "cloud-endpoints.json"),
    path.join(__dirname, "..", "cloud-endpoints.json"),
    path.join(__dirname, "..", "..", "cloud-endpoints.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return parseCloudEndpointManifest(JSON.parse(fs.readFileSync(candidate, "utf8")));
      }
    } catch (err) {
      // A manifest that exists but is malformed is a build error, not something to shrug off:
      // guessing the endpoint is exactly the failure mode this module exists to prevent.
      throw new CloudEndpointError(`Invalid CodeForge Cloud endpoint manifest at ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A missing manifest is only a valid source-checkout condition. A packaged app without its
  // stamped authority must still open far enough to show the safe sign-in failure, but it must
  // never guess a local endpoint.
  if (app.isPackaged) {
    throw new CloudEndpointError("Packaged CodeForge build is missing cloud-endpoints.json; refusing to guess an authentication endpoint.");
  }
  return { channel: "development", endpoints: {} };
}

let endpointResolutionError: CloudEndpointError | undefined;
let RESOLVED_CLOUD_ENDPOINT: ReturnType<typeof resolveCloudEndpoint>;
try {
  RESOLVED_CLOUD_ENDPOINT = resolveCloudEndpoint({
    manifest: loadCloudEndpointManifest(),
    env: process.env,
    isPackaged: app.isPackaged,
  });
} catch (error) {
  if (!(error instanceof CloudEndpointError) || !app.isPackaged) throw error;
  endpointResolutionError = error;
  RESOLVED_CLOUD_ENDPOINT = {
    url: "",
    channel: "production",
    overridden: false,
    overrideReason: "packaged build has no usable Cloud endpoint; Cloud traffic disabled",
  };
  console.error(`[CodeForge] cloud endpoint unavailable: ${error.message}`);
}
const CLOUD_API_URL = RESOLVED_CLOUD_ENDPOINT.url;
console.log(`[CodeForge] cloud endpoint ${endpointResolutionError ? "unavailable=true" : describeCloudEndpoint(RESOLVED_CLOUD_ENDPOINT)}`);
const ALLOWED_PROVIDER_IDS = new Set([
  "opencode",
  "openrouter",
  "zai",
  "google",
  "groq",
  "cloudflare-workers-ai",
  "cloudflare-account-id",
  "openai",
  "anthropic",
]);
// Providers CodeForge can build a real adapter for (excludes the cloudflare account-id pseudo-credential).
const ROUTABLE_PROVIDER_IDS = ["opencode", "openrouter", "zai", "google", "groq", "cloudflare-workers-ai", "openai", "anthropic"] as const;
const MAX_API_KEY_LENGTH = 512;
const SETTINGS_FILE = "settings.json";
const PACKAGED_SMOKE = process.env.CODEFORGE_PACKAGED_SMOKE === "1";
/** Port the local CodeForge API binds to; the renderer and the VS Code extension both target it. */
const LOCAL_SERVER_PORT = 3210;

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
  const status: Record<string, boolean> = {};
  for (const id of ROUTABLE_PROVIDER_IDS) status[id] = !!creds[id];
  return status;
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

interface FirstRunLegalAck {
  ageConfirmed: true;
  hostExecutionAcknowledged: true;
  acknowledgedAt: string;
}

function getFirstRunLegalAck(): FirstRunLegalAck | null {
  const settings = readSettings();
  const raw = settings[FIRST_RUN_LEGAL_ACK_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.ageConfirmed === true && r.hostExecutionAcknowledged === true && typeof r.acknowledgedAt === "string") {
    return { ageConfirmed: true, hostExecutionAcknowledged: true, acknowledgedAt: r.acknowledgedAt };
  }
  return null;
}

type CloseDecision = "cancel" | "tray" | "quit" | "quit-anyway";

function getCloseBehavior(): CloseBehavior {
  const value = readSettings()[CLOSE_BEHAVIOR_KEY];
  return value === "tray" || value === "quit-safe" ? value : "ask";
}

function setCloseBehavior(value: CloseBehavior): void {
  const settings = readSettings();
  settings[CLOSE_BEHAVIOR_KEY] = value;
  writeSettingsAtomic(settings);
}

// Canonical Settings surface (see app-settings.ts). `fresh` reports whether the canonical store
// existed when this process started, so the renderer can seed it from pre-canonical renderer-local
// values exactly once instead of overwriting real preferences on every launch.
let appSettingsFreshAtStartup = true;

function readAppSettings(): AppSettings {
  return parseAppSettings(readSettings()[APP_SETTINGS_KEY]);
}

function writeAppSettings(settings: AppSettings): void {
  const store = readSettings();
  store[APP_SETTINGS_KEY] = settings;
  writeSettingsAtomic(store);
}

function getSettingsSnapshot(): SettingsSnapshot {
  return { settings: readAppSettings(), closeBehavior: getCloseBehavior(), fresh: appSettingsFreshAtStartup };
}

function updateSettings(payload: { settings?: unknown; closeBehavior?: unknown }): SettingsSnapshot {
  if (payload.settings !== undefined) {
    const patch = parseAppSettingsPatch(payload.settings);
    writeAppSettings(applySettingsPatch(readAppSettings(), patch));
    // After a successful write the store is no longer "fresh" — it is an authoritative preference.
    appSettingsFreshAtStartup = false;
  }
  if (payload.closeBehavior !== undefined) {
    const behavior = CloseBehaviorSchema.safeParse(payload.closeBehavior);
    if (!behavior.success) throw new Error("Invalid close behavior");
    setCloseBehavior(behavior.data);
  }
  return getSettingsSnapshot();
}

function resetAppSettings(): SettingsSnapshot {
  const store = readSettings();
  delete store[APP_SETTINGS_KEY];
  writeSettingsAtomic(store);
  appSettingsFreshAtStartup = true;
  return getSettingsSnapshot();
}

function getPersistedWindowState(): PersistedWindowState | undefined {
  return parsePersistedWindowState(readSettings()[WINDOW_STATE_KEY]);
}

function persistWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const settings = readSettings();
  settings[WINDOW_STATE_KEY] = {
    bounds: mainWindow.getNormalBounds(),
    isMaximized: mainWindow.isMaximized(),
  } satisfies PersistedWindowState;
  writeSettingsAtomic(settings);
}

function restoreMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const TRAY_STATUS_REFRESH_MS = 15_000;

/**
 * Keeps the tray tooltip honest about whether anything is actually running while the window is
 * hidden — the same `summarizeActiveWork()` text the close dialog shows, so the two surfaces can
 * never describe active work differently. A no-op if the tray doesn't currently exist.
 */
async function updateTrayStatus(): Promise<void> {
  if (!tray) return;
  const status = await currentRuntimeStatus();
  const running = countRunningWork(status);
  tray.setToolTip(running > 0 ? `CodeForge — ${summarizeActiveWork(status)}` : "CodeForge");
}

function ensureTray(): void {
  if (tray) return;
  const iconPath = resolveAppIcon();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("CodeForge");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open CodeForge", click: restoreMainWindow },
    { type: "separator" },
    { label: "Quit CodeForge", click: () => { void requestClose(); } },
  ]));
  tray.on("double-click", restoreMainWindow);
  void updateTrayStatus();
  trayStatusTimer = setInterval(() => { void updateTrayStatus(); }, TRAY_STATUS_REFRESH_MS);
  trayStatusTimer.unref?.();
}

function hideToTray(): void {
  ensureTray();
  mainWindow?.hide();
}

async function currentRuntimeStatus(): Promise<CodeForgeRuntimeStatus> {
  if (!server) {
    return {
      activeWork: false,
      activeWorkflows: 0,
      activeAgentTurns: 0,
      activeCommands: 0,
      pendingApprovals: 0,
      activeVerifications: 0,
      hostedContinuations: 0,
      backgroundTasks: 0,
      recoverable: true,
      unrecoverableResources: [],
    };
  }
  return server.getRuntimeStatus();
}

async function completeSafeQuit(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  isQuitting = true;
  persistWindowState();
  tray?.destroy();
  tray = null;
  if (trayStatusTimer) {
    clearInterval(trayStatusTimer);
    trayStatusTimer = null;
  }
  shutdownPromise = (async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    app.quit();
  })();
  return shutdownPromise;
}

async function requestClose(): Promise<void> {
  if (isQuitting || closeRequestInFlight) return;
  closeRequestInFlight = true;
  const status = await currentRuntimeStatus();
  const behavior = getCloseBehavior();
  const action = resolveCloseAction(status, behavior);

  if (action === "tray") {
    closeRequestInFlight = false;
    hideToTray();
    return;
  }
  if (action === "quit") {
    closeRequestInFlight = false;
    await completeSafeQuit();
    return;
  }

  // action === "ask"
  if (!mainWindow || mainWindow.isDestroyed()) {
    closeRequestInFlight = false;
    if (status.recoverable) await completeSafeQuit();
    return;
  }
  mainWindow.webContents.send("app:close-requested", { status, preference: behavior });
}

function setOnboardingCompleted(completed: boolean): void {
  if (typeof completed !== "boolean") throw new Error("Invalid onboarding value");
  const settings = readSettings();
  settings[ONBOARDING_COMPLETED_KEY] = completed;
  writeSettingsAtomic(settings);
}

/** Takes no parameters from the caller — the only valid call is "the user just checked the
 *  acknowledgement box," so both flags are always set true with a fresh timestamp rather than
 *  trusting a renderer-supplied value that could claim acknowledgement without it happening. */
function setFirstRunLegalAck(): FirstRunLegalAck {
  const ack: FirstRunLegalAck = { ageConfirmed: true, hostExecutionAcknowledged: true, acknowledgedAt: new Date().toISOString() };
  const settings = readSettings();
  settings[FIRST_RUN_LEGAL_ACK_KEY] = ack;
  writeSettingsAtomic(settings);
  return ack;
}

function getStoredCloudTokens(): { accessToken?: string; refreshToken?: string; user?: any } {
  const settings = readSettings();
  const rawAccess = settings[CLOUD_ACCESS_TOKEN_KEY];
  const rawRefresh = settings[CLOUD_REFRESH_TOKEN_KEY];
  const rawUser = settings[CLOUD_USER_KEY];
  return {
    accessToken: typeof rawAccess === "string" ? decryptCredential(rawAccess) : undefined,
    refreshToken: typeof rawRefresh === "string" ? decryptCredential(rawRefresh) : undefined,
    user: typeof rawUser === "object" && rawUser !== null ? rawUser : undefined,
  };
}

function saveCloudTokens(accessToken: string, refreshToken: string, user: any): void {
  const settings = readSettings();
  settings[CLOUD_ACCESS_TOKEN_KEY] = encryptCredential(accessToken);
  settings[CLOUD_REFRESH_TOKEN_KEY] = encryptCredential(refreshToken);
  settings[CLOUD_USER_KEY] = user;
  writeSettingsAtomic(settings);
}

function clearCloudTokens(): void {
  const settings = readSettings();
  delete settings[CLOUD_ACCESS_TOKEN_KEY];
  delete settings[CLOUD_REFRESH_TOKEN_KEY];
  delete settings[CLOUD_USER_KEY];
  writeSettingsAtomic(settings);
}

function createCloudAdapter(): HostedProviderAdapter {
  return new HostedProviderAdapter({
    cloudApiUrl: CLOUD_API_URL,
    getAccessToken: () => {
      const tokens = getStoredCloudTokens();
      return tokens.accessToken ?? null;
    },
    onAuthExpired: async () => {
      const tokens = getStoredCloudTokens();
      if (!tokens.refreshToken) return null;
      try {
        const refreshRes = await fetch(`${CLOUD_API_URL}/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        });
        if (refreshRes.ok) {
          const data = (await refreshRes.json()) as any;
          saveCloudTokens(data.accessToken, data.refreshToken, data.user);
          return data.accessToken;
        }
      } catch {}
      return null;
    },
  });
}

/**
 * Reconciles ForgeZero's "codeforge-cloud" records against what the adapter's listModels()
 * currently reports — registering newly verified-free models and dropping ones no longer
 * verified-free (cost-transition safety: a model can never silently keep a stale free grant).
 */
async function syncCloudFreeModelsIntoFirewall(cloudAdapter: HostedProviderAdapter): Promise<void> {
  if (!firewall) return;
  for (const model of firewall.allModels()) {
    if (model.providerId === "codeforge-cloud") firewall.unregister(model.providerId, model.modelId);
  }

  const now = new Date().toISOString();
  const models = await cloudAdapter.listModels();
  for (const model of models) {
    if (!model.isFree || model.freeStatus !== "verified_free") continue;
    firewall.register({
      providerId: "codeforge-cloud",
      modelId: model.modelId,
      displayName: model.displayName,
      tier: "free",
      freeStatus: "verified_free",
      freeStatusVerifiedAt: now,
      isRemote: true,
      isCloudHosted: true,
      contextWindow: model.contextWindow,
      capabilities: model.capabilities,
      costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, freeTierVerifiedAt: now, paidFallbackPossible: false, paidFallbackDisabled: true, source: "codeforge:cloud" },
      health: { status: "available", lastCheckedAt: now },
    });
  }
}

/**
 * Signed-in path: registers the hosted adapter into providerCatalog (which is what flips the
 * server from demo to real runtime, per CodeForgeServer.realRuntimeEnabled()) AND syncs the
 * catalog. Only call this once the user actually has cloud credentials — registering the adapter
 * while signed out would make the server attempt real (but doomed-to-401) hosted inference instead
 * of the safe scripted demo the very first time someone sends a message.
 */
async function registerCloudAdapter(): Promise<void> {
  if (!providerCatalog || !firewall) return;
  const existing = providerCatalog.get("codeforge-cloud");
  const cloudAdapter = existing instanceof HostedProviderAdapter ? existing : createCloudAdapter();
  if (!(existing instanceof HostedProviderAdapter)) providerCatalog.register(cloudAdapter);
  providerAuthState.set("codeforge-cloud", "ok");
  await syncCloudFreeModelsIntoFirewall(cloudAdapter);
}

/**
 * Signed-out path: CodeForge Free's catalog listing (`GET /v1/hosted/models`) requires no auth —
 * only actually running a model does. So a fresh, signed-out install still gets the real catalog
 * for browsing/selection, WITHOUT registering the adapter into providerCatalog. That keeps
 * realRuntimeEnabled() false until the user connects a real provider (BYOK) or signs in, so
 * selecting one of these models before then still runs the existing safe scripted demo runtime
 * instead of a confusing 401 from an adapter that has no credential yet.
 */
async function registerCloudFreeCatalogOnly(): Promise<void> {
  if (!firewall) return;
  const listOnlyAdapter = createCloudAdapter();
  await syncCloudFreeModelsIntoFirewall(listOnlyAdapter);
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

/**
 * Orphan-model invariant oracle: a model is routable only if a provider adapter is registered
 * AND its auth state permits execution. A model whose provider has no adapter (or a 401'd
 * provider) is excluded from ForgeZero eligibility — never routed, never hammered.
 */
const providerOracle: ProviderAvailabilityOracle = {
  isActive(providerId: string): boolean {
    if (!providerCatalog?.get(providerId)) return false;
    return providerAuthState.get(providerId) !== "auth_required";
  },
};

/** Build + register a provider adapter by id using the desktop credential store. Idempotent. */
function registerProviderAdapter(providerId: string): ProviderAdapter | undefined {
  if (!providerCatalog || !desktopCredentialStore) return undefined;
  const existing = providerCatalog.get(providerId);
  if (existing) return existing;
  let adapter: ProviderAdapter | undefined;
  if (providerId === "opencode") {
    adapter = createOpencodeAdapter({ credentialStore: desktopCredentialStore });
  } else if (providerId === "openrouter") {
    adapter = createOpenRouterAdapter({ credentialStore: desktopCredentialStore });
  } else {
    adapter = createProviderAdapterById(providerId, { credentialStore: desktopCredentialStore });
  }
  if (adapter) {
    providerCatalog.register(adapter);
    providerAuthState.set(providerId, "ok");
  }
  return adapter;
}

/**
 * Discover + verify free models from a connected provider's LIVE catalog and register the
 * verified-free records into ForgeZero. This is the ONLY path that grants "verified free"
 * — Models.dev facts alone never do. A 401 marks the provider auth_required (excluded from routing).
 */
async function discoverProviderFree(providerId: string): Promise<number> {
  if (!providerCatalog || !firewall || !modelRegistry) return 0;
  const adapter = providerCatalog.get(providerId);
  if (!adapter) return 0;
  try {
    const models = await adapter.listModels();
    const live: LiveModelInfo[] = models.map((m) => ({
      modelId: m.modelId,
      isFree: m.isFree,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      toolCalling: m.capabilities.toolCalling,
      vision: m.capabilities.vision,
      structuredOutput: m.capabilities.structuredOutput,
    }));
    const result = discoverAndVerifyFree(modelRegistry, providerId, live);
    for (const rec of result.records) firewall.register(rec);
    providerAuthState.set(providerId, "ok");

    // Allowance providers (Gemini/Groq/Cloudflare) list paid unit prices, so no $0 model is
    // found above. Verify their free tier by an actual no-charge probe request instead.
    if (result.verifiedCount === 0 && getProviderPolicy(providerId)?.hasAllowanceFree) {
      const probe = async (modelId: string): Promise<{ ok: boolean }> => {
        try {
          let ok = false;
          for await (const ev of adapter.streamChat({ model: modelId, messages: [{ role: "user", content: "hi" }], maxTokens: 5 })) {
            if (ev.type === "text_delta" || ev.type === "finish") ok = true;
          }
          return { ok };
        } catch {
          return { ok: false };
        }
      };
      const allowance = await verifyAllowanceViaProbe(modelRegistry, providerId, live, probe);
      for (const rec of allowance.records) firewall.register(rec);
      return allowance.verifiedCount;
    }
    return result.verifiedCount;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b401\b|auth|unauthor/i.test(msg)) {
      providerAuthState.set(providerId, "auth_required");
    }
    return 0;
  }
}

async function initializeServer(dbPath: string): Promise<void> {
  smokeRecord("INIT_SERVER_START");
  try {
    const hasCredentials = PACKAGED_SMOKE || (!!providerCatalog && (
      providerCatalog.get("opencode") ||
      providerCatalog.get("openrouter") ||
      providerCatalog.get("codeforge")
    ));
    smokeRecord(`INIT_SERVER_HAS_CREDS_${Boolean(hasCredentials)}`);
    server = new CodeForgeServer({
      port: LOCAL_SERVER_PORT,
      dbPath,
      firewall: firewall ?? undefined,
      providerCatalog: providerCatalog ?? undefined,
      useRealRuntime: hasCredentials ? true : undefined,
    });
    smokeRecord("INIT_SERVER_INSTANCE_CREATED");
    await server.start();
    if (readAppSettings().general.openLastWorkspaceOnStartup) {
      const recent = getRecentProjects()[0];
      if (recent && fs.existsSync(recent.path)) {
        try {
          server.setWorkspace(recent.path);
        } catch {
          // ignore
        }
      }
    }
    smokeRecord("INIT_SERVER_STARTED");
    await applyStartupServerSettings();
  } catch (err) {
    smokeRecord(`INIT_SERVER_ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    throw err;
  }
}

/**
 * Re-applies persisted preferences to the freshly started local server and continues eligible
 * interrupted work. The server holds privacy-routing mode in memory only, so without this the
 * user's ForgeZero routing choice silently reset on every launch. Both steps are fail-safe:
 * a failure leaves the server in its defaults and never blocks startup.
 */
async function applyStartupServerSettings(): Promise<void> {
  const settings = readAppSettings();
  try {
    await fetch(`http://localhost:${LOCAL_SERVER_PORT}/api/privacy-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: settings.privacy.routingMode }),
    });
  } catch {}
  if (PACKAGED_SMOKE || !settings.general.continueInterruptedAgents) return;
  void continueRecoverableAgents();
}

/**
 * Continue interrupted agents after a restart — the durable-recovery scope of that preference,
 * nothing more. Sessions left in the visible recovery hold are inspected via the local API, and
 * only turns that were persisted mid-run are resumed (a turn the user paused on purpose stays
 * paused). Resume re-plans from durable facts; no interrupted tool execution is ever replayed,
 * and anything risky still goes through the unchanged approval gate.
 */
async function continueRecoverableAgents(): Promise<void> {
  if (!server) return;
  try {
    const res = await fetch(`http://localhost:${LOCAL_SERVER_PORT}/api/sessions`);
    if (!res.ok) return;
    const sessions = (await res.json()) as Array<{ id?: string; status?: string }>;
    const recovering = sessions.filter((s) => s.status === "recovering" && typeof s.id === "string").slice(0, 5);
    for (const session of recovering) {
      const detailRes = await fetch(`http://localhost:${LOCAL_SERVER_PORT}/api/sessions/${encodeURIComponent(session.id!)}`);
      if (!detailRes.ok) continue;
      const detail = (await detailRes.json()) as { turns?: Array<{ id?: string; status?: string }> };
      for (const turn of detail.turns ?? []) {
        if (!turn.id || (turn.status !== "running" && turn.status !== "recovering")) continue;
        smokeRecord(`CONTINUE_INTERRUPTED_TURN_${session.id}_${turn.id}`);
        await fetch(
          `http://localhost:${LOCAL_SERVER_PORT}/api/sessions/${encodeURIComponent(session.id!)}/turns/${encodeURIComponent(turn.id)}/resume`,
          { method: "POST" },
        ).catch(() => {});
      }
    }
  } catch {}
}

function registerFreeModels(fw: ForgeZero): void {
  // Muse Spark is intentionally NOT registered — it is a promotional model excluded from
  // normal/default routing (free-first policy). Real free models are discovered from
  // connected providers and verified by ForgeZero before Auto can route to them.
  fw.register(createGenericFreeRecord());
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

async function createWindow(): Promise<void> {
  smokeRecord("CREATE_WINDOW_START");
  const iconPath = resolveAppIcon();
  const primaryDisplay = screen.getPrimaryDisplay();
  const displayShape = (display: Electron.Display) => ({ workArea: display.workArea });
  const restored = restoreWindowState(
    getPersistedWindowState(),
    displayShape(primaryDisplay),
    screen.getAllDisplays().map(displayShape),
  );
  mainWindow = new BrowserWindow({
    ...restored.bounds,
    minWidth: restored.minWidth,
    minHeight: restored.minHeight,
    title: "CodeForge",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      webSecurity: true,
    },
    show: false,
    backgroundColor: "#0f1012",
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const detail = `RENDER_PROCESS_GONE=${details.reason}:${details.exitCode}`;
    smokeRecord(detail);
    console.error(`[CodeForge] ${detail}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    const detail = `RENDER_DID_FAIL_LOAD=${code}:${description}`;
    smokeRecord(detail);
    console.error(`[CodeForge] ${detail}`);
  });

  mainWindow.once("ready-to-show", () => {
    smokeRecord("WINDOW_READY_TO_SHOW");
    mainWindow?.show();
    if (restored.isMaximized) mainWindow?.maximize();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      persistWindowState();
      return;
    }
    event.preventDefault();
    void requestClose();
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
  if (isDev) {
    smokeRecord("LOAD_URL_http://localhost:5173");
    await mainWindow.loadURL("http://localhost:5173");
  } else {
    const rendererFile = path.join(__dirname, "renderer", "index.html");
    smokeRecord(`LOAD_FILE_${rendererFile}`);
    // loadFile builds a canonical file URL for Windows drive letters and ASAR paths. Hand-building
    // `file://${path}` produced `file://G:\\...`, which is malformed and can make a sandboxed
    // renderer fail during launch before the document gets a chance to paint.
    await mainWindow.loadFile(rendererFile);
  }
  smokeRecord("WINDOW_CONTENT_LOADED");

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

async function capturePackagedSmokeScreenshot(name: string): Promise<void> {
  const directory = process.env.CODEFORGE_SMOKE_SCREENSHOT_DIR;
  const window = mainWindow;
  if (!directory || !window) return;
  fs.mkdirSync(directory, { recursive: true });
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(directory, `${name}.png`), image.toPNG());
  smokeRecord(`packaged_screenshot_${name}=PASS`);
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

async function waitForTask(taskId: string, sessionId: string, resolveApprovals: boolean): Promise<{ phase: string; status: string; error?: string }> {
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
    if (task && ["completed", "failed", "cancelled", "blocked"].includes(task.phase)) {
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
  await evaluateRenderer<void>(`window.electronAPI.openProject(${JSON.stringify(workspacePath)})`);
  await reloadRenderer();
  await waitForCondition(async () =>
    (await evaluateRenderer<string>("document.body.innerText")).toLowerCase().includes(path.basename(workspacePath).toLowerCase()),
  );
  const authenticatedText = await evaluateRenderer<string>("document.body.innerText");
  if (authenticatedText.includes("Continue with GitHub")) throw new Error("Packaged auth fixture did not restore into the authenticated UI");
  // The shell's Repository Intelligence surface is an icon-only header button; open its live
  // status popover so the smoke verifies the real status UI (title + state text) rather than an
  // attribute innerText never contains.
  await evaluateRenderer<void>(`(() => { const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === 'Repository Intelligence'); if (button) button.click(); })()`);
  await delay(150);
  const shellVisibleText = await evaluateRenderer<string>("document.body.innerText");
  // Case-insensitive: the popover title is uppercased by CSS text-transform, which innerText reflects.
  if (!shellVisibleText.toLowerCase().includes("repository intelligence")) {
    throw new Error(`Packaged workspace shell was not visible; body text: ${shellVisibleText.slice(0, 500).replace(/\s+/g, " | ")}`);
  }
  const bridgeBoundary = await evaluateRenderer<boolean>(
    "Boolean(window.electronAPI) && typeof window.electronAPI.getProviderCredentials === 'undefined'",
  );
  if (!bridgeBoundary) throw new Error("Renderer credential boundary is not enforced");
  smokeRecord("packaged_auth_restore=PASS");
  smokeRecord("packaged_authenticated_workspace=PASS");
  smokeRecord("renderer_raw_credential_api_absent=PASS");
  await capturePackagedSmokeScreenshot("01-authenticated-zero-state");
  // Collapse the popover again so later programmatic interactions start from a clean surface.
  await evaluateRenderer<void>(`(() => { const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === 'Repository Intelligence'); if (button) button.click(); })()`);
  await delay(100);

  smokeRecord("packaged_workspace_name_visible=PASS");
  await waitForCondition(async () => (await apiJson("/api/workspace/tree")).status === 200);
  smokeRecord("packaged_workspace_tree_ready=PASS");
  let lastIndexStatus: any;
  try {
    await waitForCondition(async () => {
      const index = await apiJson("/api/repository-index/status");
      lastIndexStatus = index.body;
      return index.status === 200 && ["READY", "DEGRADED"].includes(index.body?.state);
    }, 30_000);
  } catch (error) {
    smokeRecord(`packaged_repository_status_diagnostic=${JSON.stringify(lastIndexStatus)}`);
    throw error;
  }
  smokeRecord("packaged_repository_status_terminal=PASS");
  const indexStatus = await apiJson("/api/repository-index/status");
  smokeRecord(`packaged_repository_status=${JSON.stringify(indexStatus.body)}`);
  if ((indexStatus.body?.fileCount ?? 0) < 258 || (indexStatus.body?.symbolCount ?? 0) < 257) throw new Error("Packaged substantial repository index did not contain workspace structure");
  const indexQuery = await apiJson("/api/repository-index/search?q=add");
  if (indexQuery.status !== 200 || !indexQuery.body?.items?.some((item: { path?: string }) => item.path === "src/calc.ts")) throw new Error("Packaged repository search did not return the known implementation");
  // Open the Repository Intelligence popover again now that the index is READY, so the smoke
  // verifies the live status surface (READY + file/symbol counts) actually renders.
  await evaluateRenderer<void>(`(() => { const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === 'Repository Intelligence'); if (button) button.click(); })()`);
  await delay(150);
  const shellText = await evaluateRenderer<string>("document.body.innerText");
  smokeRecord("packaged_repository_query_known_answer=PASS");
  const shellTextLower = shellText.toLowerCase();
  if (!shellTextLower.includes("repository intelligence") || !shellTextLower.includes("local structural index")) throw new Error("Packaged repository status UX was not visible");
  await evaluateRenderer<void>(`(() => { const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === 'Repository Intelligence'); if (button) button.click(); })()`);
  await delay(100);
  const escape = await apiJson(`/api/workspace/tree?path=${encodeURIComponent(path.dirname(workspacePath))}`);
  if (escape.status !== 403) throw new Error(`Workspace escape returned ${escape.status}`);
  smokeRecord("packaged_workspace_restore=PASS");
  smokeRecord("packaged_workspace_escape_blocked=PASS");
  smokeRecord("packaged_repository_index_ready=PASS");
  smokeRecord("packaged_repository_search=PASS");
  smokeRecord("packaged_repository_index_ui_responsive=PASS");
  smokeRecord("packaged_substantial_repository=PASS");
  await capturePackagedSmokeScreenshot("02-workspace-ready");
  await evaluateRenderer<void>(`(() => { const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === 'Select model'); if (button) button.click(); })()`);
  await delay(100);
  await capturePackagedSmokeScreenshot("02a-model-catalog");
  await evaluateRenderer<void>(`(() => { const input = document.querySelector('input[aria-label="Filter models or providers"]'); const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); if (input && descriptor && descriptor.set) { descriptor.set.call(input, 'auto'); input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await delay(100);
  await capturePackagedSmokeScreenshot("02b-model-filter");
  await evaluateRenderer<void>(`(() => { const input = document.querySelector('input[aria-label="Filter models or providers"]'); if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);

  // Run the workflow in the SAME session the renderer follows ("default"). SSE is now scoped
  // per session (isolation), so the reload-rehydration check below must observe the session the
  // renderer is actually viewing — mirroring real usage (work happens in the viewed session).
  const workflow = await rendererWorkflowRequest({
    sessionId: "default",
    message: "Fix add function through packaged failure repair pass",
    forceHeuristic: true,
    verificationCommands: [
      "node -e \"const c=require('fs').readFileSync('src/calc.ts','utf8');if(c.includes('a + b')){console.log('1 passed')}else{console.log('1 failed');console.log('FAIL src/calc.ts');process.exit(1)}\"",
    ],
  });
  if (workflow.status !== 200) throw new Error(`Packaged workflow start returned ${workflow.status}: ${JSON.stringify(workflow.body)}`);
  const terminal = await waitForTask(workflow.body.taskId, "default", true);
  if (terminal.phase !== "completed") throw new Error(`Packaged workflow ended in ${terminal.phase}`);
  const fixed = fs.readFileSync(path.join(workspacePath, "src", "calc.ts"), "utf8");
  if (!fixed.includes("a + b")) throw new Error("Packaged workflow did not apply the repaired file content");
  const session = await apiJson("/api/sessions/default");
  const repairingSeen = JSON.stringify(session.body.events).includes("repairing");
  if (!repairingSeen) throw new Error("Packaged workflow did not traverse bounded repair");
  smokeRecord("packaged_workflow=PASS");
  smokeRecord("packaged_failure_repair_pass=PASS");
  await capturePackagedSmokeScreenshot("03-workflow-completed");

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

  // --- Settings application walkthrough (Settings & Identity R1 packaged evidence) ---
  // Drives the real Settings UI in the packaged app: open, section navigation, the header
  // account menu deep link, functional search, and back-to-workspace. Every visited surface
  // is captured as screenshot evidence; any dead control fails the run.
  const clickButtonWithText = (text: string): Promise<void> =>
    evaluateRenderer<void>(`(() => {
      const target = ${JSON.stringify(text)};
      const button = Array.from(document.querySelectorAll('button')).find((element) => (element.textContent ?? '').trim() === target);
      if (!button) throw new Error('settings walkthrough: button not found: ' + target);
      button.click();
    })()`);
  const clickSettingsNav = (label: string): Promise<void> =>
    evaluateRenderer<void>(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-nav-item')).find((element) => (element.textContent ?? '') === ${JSON.stringify(label)});
      if (!item) throw new Error('settings walkthrough: nav item not found: ' + ${JSON.stringify(label)});
      item.click();
    })()`);
  const captureSettings = async (name: string, mustContain: string): Promise<void> => {
    await delay(250);
    const text = await evaluateRenderer<string>("document.body.innerText");
    if (!text.toLowerCase().includes(mustContain.toLowerCase())) {
      throw new Error(`settings walkthrough: expected "${mustContain}" on screen for ${name}; body text: ${text.slice(0, 1400).replace(/\s+/g, " | ")}`);
    }
    await capturePackagedSmokeScreenshot(name);
  };

  await clickButtonWithText("Settings");
  await captureSettings("05-settings-general", "Open last workspace on startup");
  smokeRecord("settings_open=PASS");

  // Header account menu -> Profile & Account deep link (the account identity surface).
  await evaluateRenderer<void>(`(() => { const button = document.querySelector('.cloud-account-btn'); if (!button) throw new Error('settings walkthrough: account button not found'); button.click(); })()`);
  await delay(200);
  await capturePackagedSmokeScreenshot("05a-account-menu");
  await clickButtonWithText("Profile & Account");
  await captureSettings("06-settings-profile", "CodeForge account");
  smokeRecord("account_menu_profile_deeplink=PASS");

  await clickSettingsNav("Models & Routing");
  await captureSettings("07-settings-models", "ForgeZero");
  await clickSettingsNav("Agents");
  await captureSettings("08-settings-agents", "Agent steering");
  await clickSettingsNav("Verification & Safety");
  await captureSettings("09-settings-safety", "Completion gate");
  await clickSettingsNav("Connected Providers");
  await captureSettings("10-settings-providers", "OpenRouter");
  await clickSettingsNav("About");
  await captureSettings("11-settings-about", "License");

  // Functional search: "tray" must find the close-behavior surface and land on it.
  await evaluateRenderer<void>(`(() => {
    const input = document.querySelector('input[aria-label="Search settings"]');
    if (!input) throw new Error('settings walkthrough: search input not found');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor.set.call(input, 'tray');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(250);
  await capturePackagedSmokeScreenshot("12-settings-search");
  const searchResultText = await evaluateRenderer<string>("document.body.innerText");
  if (!searchResultText.includes("Application & Background")) throw new Error("settings walkthrough: search for 'tray' did not surface Application & Background");
  await evaluateRenderer<void>(`(() => {
    const result = Array.from(document.querySelectorAll('.settings-search-result')).find((element) => (element.textContent ?? '').includes('Application & Background'));
    if (!result) throw new Error('settings walkthrough: search result not clickable');
    result.click();
  })()`);
  await captureSettings("13-settings-close-behavior", "When tasks are active and I close CodeForge");
  smokeRecord("settings_search=PASS");

  await evaluateRenderer<void>(`(() => { const button = document.querySelector('.settings-back-btn'); if (!button) throw new Error('settings walkthrough: back button not found'); button.click(); })()`);
  await delay(250);
  const backText = await evaluateRenderer<string>("document.body.innerText");
  if (backText.includes("Search settings")) throw new Error("settings walkthrough: Back did not return to the workspace");
  smokeRecord("settings_back_to_workspace=PASS");

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
  if (recovered.body.session?.status !== "recovering") throw new Error("Interrupted session was not placed in safe recovery");
  if ((recovered.body.pendingApprovals?.length ?? 0) !== 0) throw new Error("Interrupted approval survived restart");
  const recoveryEvents = JSON.stringify(recovered.body.events);
  if (!recoveryEvents.includes("turn.recovery") || !recoveryEvents.includes("replan_required")) {
    throw new Error("No-replay recovery event was not reconstructed");
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
    executionMode: "agent",
    forceHeuristic: true,
    verificationCommands: ["node -e \"process.exit(0)\""],
  }, "/api/send");
  if (fresh.status !== 200 || !fresh.body.taskId) throw new Error("Fresh workflow could not start after recovery");
  const terminal = await waitForTask(fresh.body.taskId, "packaged-fresh", true);
  const freshSession = await apiJson("/api/sessions/packaged-fresh");
  if (terminal.phase !== "blocked" || !JSON.stringify(freshSession.body.events).includes("no_effective_change")) {
    throw new Error("Fresh post-restart workflow did not fail closed for its no-op plan");
  }
  smokeRecord("electron_restart_fresh_task=PASS");
  await capturePackagedSmokeScreenshot("04-recovery");
  smokeRecord("PACKAGED_RECOVERY_SMOKE_OK");
}

async function runPackagedSmoke(): Promise<void> {
  const mode = process.env.CODEFORGE_PACKAGED_SMOKE_MODE ?? "full";
  const workspacePath = process.env.CODEFORGE_SMOKE_WORKSPACE;
  const testSecret = process.env.CODEFORGE_TEST_SECRET;
  if (!app.isPackaged) throw new Error("Packaged smoke was not running from a packaged executable");
  if (!workspacePath || !testSecret) throw new Error("Packaged smoke inputs are missing");
  await waitForRenderer();
  smokeRecord("PACKAGED_STARTUP=PASS");
  await import("@codeforge/forge-green");
  smokeRecord("FORGEGREEN_RUNTIME=PASS");
  await import("@codeforge/eight-bit");
  smokeRecord("EIGHT_BIT_RUNTIME=PASS");
  await import("@codeforge/cloud-db");
  smokeRecord("CLOUD_DB_PACKAGED_RUNTIME=PASS");
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

async function startPrimaryInstance(): Promise<void> {
  smokeRecord("WHEN_READY_START");
  // One-time freshness probe for the canonical settings store: a first launch with no stored
  // settings object lets the renderer seed defaults from its pre-canonical local values.
  appSettingsFreshAtStartup = !(APP_SETTINGS_KEY in readSettings());
  desktopCredentialStore = new DesktopCredentialStore();
  smokeRecord("WHEN_READY_CRED_STORE_DONE");
  // Firewall enforces the orphan-model invariant via the provider oracle: a model can be
  // routed only when a live, authenticated provider adapter backs it.
  firewall = new ForgeZero({ providerOracle });
  smokeRecord("WHEN_READY_FIREWALL_DONE");
  providerCatalog = new InMemoryProviderCatalog();
  smokeRecord("WHEN_READY_CATALOG_DONE");
  registerPackagedSmokeProvider(providerCatalog);
  smokeRecord("WHEN_READY_SMOKE_PROV_DONE");
  // Normalized model registry: bundled snapshot immediately (offline-safe); live refresh below.
  modelRegistry = new NormalizedModelRegistry();
  modelRegistry.loadSnapshot();

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
  if (!PACKAGED_SMOKE) {
    for (const id of ROUTABLE_PROVIDER_IDS) {
      if (credentials[id]) registerProviderAdapter(id);
    }
    const cloudTokens = getStoredCloudTokens();
    if (resolveCloudCatalogSyncMode(Boolean(cloudTokens.accessToken)) === "register-adapter-and-sync") {
      // Signed-in: eagerly register before window paint so the account's hosted models are
      // selectable the instant the workspace opens (existing behavior, unchanged).
      await registerCloudAdapter();
    } else {
      // CodeForge's hosted free catalog (CloudProviderRegistry, backed by CodeForge's own
      // server-owned provider keys) requires no sign-in to LIST — only /v1/hosted/inference
      // (actually running a model) checks auth. A fresh, signed-out install must still see the
      // real qualified free-model catalog instead of falling back to the single generic
      // placeholder record, so populate it here too (catalog only — see
      // registerCloudFreeCatalogOnly for why the adapter itself isn't registered yet).
      // Fire-and-forget: never block window paint; a cloud-api outage silently leaves the
      // generic fallback in place (HostedProviderAdapter already swallows fetch failures).
      void registerCloudFreeCatalogOnly().catch(() => {});
    }
  }

  registerFreeModels(firewall);
  smokeRecord("WHEN_READY_MODELS_REGISTERED");

  const dbPath = path.join(app.getPath("userData"), "codeforge.db");
  smokeRecord(`WHEN_READY_DBPATH_${dbPath}`);
  // Complete the renderer launch before local runtime recovery begins. Chromium creates a
  // restricted Windows token for this sandboxed renderer; keeping that boundary explicit also
  // prevents database startup work from obscuring a genuine launch failure.
  await createWindow();
  smokeRecord("WHEN_READY_WINDOW_CREATED");
  await initializeServer(dbPath);
  smokeRecord("WHEN_READY_SERVER_INITIALIZED");

  // Background: refresh the live Models.dev catalog, then discover + verify free models for any
  // already-connected providers. Failures are non-fatal (snapshot remains); the UI refreshes when
  // provider-updated fires. Never blocks window paint.
  if (!PACKAGED_SMOKE && modelRegistry) {
    void modelRegistry
      .refresh()
      .catch(() => {})
      .finally(() => {
        for (const id of ROUTABLE_PROVIDER_IDS) {
          if (providerCatalog?.get(id)) void discoverProviderFree(id);
        }
      });
  }

  // Keep the CodeForge Free (hosted) catalog current: capacity CodeForge's own server-owned
  // provider keys back can appear, rotate, or drop out after this process has already started.
  // Mirrors CloudProviderRegistry's own 5-minute discovery TTL on the cloud side so the desktop
  // never displays a materially stale view of what is actually routable. Re-registering is
  // idempotent (registerCloudAdapter reconciles the existing "codeforge-cloud" records each time)
  // and any failure (offline cloud-api) is swallowed the same way the initial registration is.
  if (!PACKAGED_SMOKE) {
    cloudCatalogRefreshTimer = setInterval(() => {
      const mode = resolveCloudCatalogSyncMode(Boolean(getStoredCloudTokens().accessToken));
      const refresh = mode === "register-adapter-and-sync" ? registerCloudAdapter() : registerCloudFreeCatalogOnly();
      void refresh.catch(() => {});
    }, CLOUD_CATALOG_REFRESH_INTERVAL_MS);
    cloudCatalogRefreshTimer.unref?.();
  }

  if (PACKAGED_SMOKE) {
    smokeRecord("WHEN_READY_LAUNCHING_SMOKE");
    void runPackagedSmoke().catch((error) => {
      smokeRecord(`PACKAGED_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(handleStartupFailure);
    }
  });
}

/**
 * Bring the running primary instance forward. This is what a second launch gets instead of a
 * second application: the existing window is un-minimized, un-hidden and focused, and no user
 * state is touched.
 */
function focusPrimaryWindow(): void {
  const target = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  activateWindow(target);
}

/**
 * A predictable local-server bind failure must not reach the user as Electron's raw
 * "A JavaScript error occurred in the main process" dialog. Report it in the app's own terms and
 * exit — the local API is what the workspace talks to, so continuing without it would only
 * present a broken window.
 */
function handleStartupFailure(error: unknown): void {
  const code = bindErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  smokeRecord(`STARTUP_FAILED ${code ?? "UNKNOWN"} ${detail}`);
  console.error(`[CodeForge] startup failed (${code ?? "UNKNOWN"}): ${detail}`);

  if (PACKAGED_SMOKE) {
    app.exit(1);
    return;
  }

  const message = describeStartupFailure(error, LOCAL_SERVER_PORT);
  try {
    dialog.showErrorBox("CodeForge could not start", message);
  } catch {
    // A failure before Electron can draw a dialog still has the console diagnostic above.
  }
  app.exit(1);
}

// Single-instance ownership is settled before anything that assumes this process is the only
// CodeForge: the local server bind, IPC ownership and the primary window all live inside
// startPrimaryInstance(), which a losing process never registers. Electron scopes the lock to the
// user-data directory, so separate --user-data-dir profiles (the packaged smoke suites) still run
// independently.
const IS_PRIMARY_INSTANCE = installSingleInstanceGuard({
  app,
  startPrimary: startPrimaryInstance,
  onSecondInstance: () => {
    smokeRecord("SECOND_INSTANCE_ACTIVATED");
    focusPrimaryWindow();
  },
  onStartupFailure: handleStartupFailure,
});
if (!IS_PRIMARY_INSTANCE) smokeRecord("SECOND_INSTANCE_EXIT");

app.on("child-process-gone", (_event, details) => {
  const detail = `CHILD_PROCESS_GONE=${details.type}:${details.reason}:${details.exitCode}`;
  smokeRecord(detail);
  console.error(`[CodeForge] ${detail}`);
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  void requestClose();
});

app.on("will-quit", () => {
  tray?.destroy();
  tray = null;
  if (trayStatusTimer) {
    clearInterval(trayStatusTimer);
    trayStatusTimer = null;
  }
  if (cloudCatalogRefreshTimer) {
    clearInterval(cloudCatalogRefreshTimer);
    cloudCatalogRefreshTimer = null;
  }
});

app.on("window-all-closed", () => {
  if (isQuitting) return;
  if (process.platform !== "darwin") void requestClose();
});

ipcMain.handle("app:close-decision", async (event, payload: { decision?: unknown; remember?: unknown }) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Invalid close decision sender");
  const decision = payload?.decision;
  if (decision !== "cancel" && decision !== "tray" && decision !== "quit" && decision !== "quit-anyway") {
    throw new Error("Invalid close decision");
  }
  const status = await currentRuntimeStatus();
  closeRequestInFlight = false;
  if (decision === "cancel") return;
  if (Boolean(payload.remember) && status.recoverable && (decision === "tray" || decision === "quit")) {
    setCloseBehavior(decision === "tray" ? "tray" : "quit-safe");
  }
  if (decision === "tray") {
    hideToTray();
    return;
  }
  if (decision === "quit-anyway" || (decision === "quit" && status.recoverable)) {
    await completeSafeQuit();
    return;
  }
  // Work became unrecoverable while the dialog was open. Re-present the current facts instead of
  // silently converting a safe quit into a destructive one.
  closeRequestInFlight = true;
  mainWindow?.webContents.send("app:close-requested", { status, preference: getCloseBehavior() });
});

/**
 * Read-only git introspection for the desktop's workspace context chips (branch/worktree
 * detection — see `apps/desktop/src/renderer/git-workspace-info.ts`). Deliberately allowlisted to
 * `git` only: this is not a general command-execution bridge across the renderer/main boundary.
 */
ipcMain.handle("shell:execCommand", async (event, payload: { command?: unknown; args?: unknown; cwd?: unknown }) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Invalid execCommand sender");
  if (payload?.command !== "git") throw new Error("execCommand only supports 'git'");
  const args = payload.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("Invalid execCommand args");
  // Strict read-only subcommand/argument allowlist (R2 GAP-4): this bridge is for workspace git
  // introspection only, never a general git-command tunnel. Rejects push/reset/clean/config-write/
  // credential/global-flag-injection even though the binary is already pinned to `git`.
  const gitCheck = checkGitExecArgs(args);
  if (!gitCheck.ok) throw new Error(`execCommand rejected: ${gitCheck.reason}`);
  const cwd = payload.cwd;
  if (cwd !== undefined && typeof cwd !== "string") throw new Error("Invalid execCommand cwd");
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ exitCode: code, stdout, stderr });
    });
  });
});

/** Lets the renderer show a compact "N tasks running" indicator backed by the same authoritative
 * runtime status the close-safety dialog uses — never a separate, potentially-inconsistent count. */
ipcMain.handle("app:runtime-status", async () => currentRuntimeStatus());

ipcMain.handle("dialog:selectDirectory", async () => {
  return selectDirectory();
});

ipcMain.handle("project:getRecent", async () => {
  if (PACKAGED_SMOKE && process.env.CODEFORGE_SMOKE_WORKSPACE && fs.existsSync(process.env.CODEFORGE_SMOKE_WORKSPACE)) {
    return [{
      id: "packaged-smoke-workspace",
      path: path.resolve(process.env.CODEFORGE_SMOKE_WORKSPACE),
      name: path.basename(process.env.CODEFORGE_SMOKE_WORKSPACE),
      lastOpened: new Date().toISOString(),
    } satisfies ProjectInfo];
  }
  return getRecentProjects();
});

ipcMain.handle("project:clearRecent", async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Invalid clearRecent sender");
  const settings = readSettings();
  delete settings[RECENT_PROJECTS_KEY];
  writeSettingsAtomic(settings);
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

// --- Settings surface (canonical schema in app-settings.ts) ---

ipcMain.handle("settings:get", (): SettingsSnapshot => getSettingsSnapshot());

ipcMain.handle("settings:set", (_event, payload: { settings?: unknown; closeBehavior?: unknown }) => {
  if (payload === null || typeof payload !== "object") throw new Error("Invalid settings payload");
  return updateSettings(payload);
});

ipcMain.handle("settings:reset", (): SettingsSnapshot => resetAppSettings());

ipcMain.handle("app:getSystemInfo", () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron ?? "unknown",
  node: process.versions.node ?? "unknown",
  chrome: process.versions.chrome ?? "unknown",
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  buildChannel: RESOLVED_CLOUD_ENDPOINT.channel,
  isPackaged: app.isPackaged,
}));

ipcMain.handle("app:openDataFolder", async () => {
  const result = await shell.openPath(app.getPath("userData"));
  return { ok: !result, error: result || undefined };
});

ipcMain.handle("notifications:show", (event, payload: { title?: unknown; body?: unknown }) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Invalid notification sender");
  if (typeof payload?.title !== "string" || payload.title.length === 0 || typeof payload?.body !== "string") {
    throw new Error("Invalid notification payload");
  }
  if (!Notification.isSupported()) return { ok: false, reason: "unsupported" };
  const notification = new Notification({
    title: payload.title.slice(0, 120),
    body: payload.body.slice(0, 250),
    // CodeForge has no sound infrastructure; silent keeps notifications from inventing one.
    silent: true,
  });
  notification.on("click", () => restoreMainWindow());
  notification.show();
  return { ok: true };
});

/**
 * Manual free-catalog refresh — the exact refresh the 5-minute background timer performs
 * (cloud catalog sync + live Models.dev refresh + re-verification for connected providers),
 * triggered on demand. Never grants free status by itself: ForgeZero verification rules apply
 * identically to this path.
 */
ipcMain.handle("catalog:refresh", async () => {
  try {
    if (!firewall) return { ok: false, freeModels: 0, error: "Runtime is not ready" };
    if (modelRegistry) await modelRegistry.refresh().catch(() => {});
    const mode = resolveCloudCatalogSyncMode(Boolean(getStoredCloudTokens().accessToken));
    if (mode === "register-adapter-and-sync") await registerCloudAdapter();
    else await registerCloudFreeCatalogOnly();
    await Promise.allSettled(
      ROUTABLE_PROVIDER_IDS.filter((id) => providerCatalog?.get(id)).map((id) => discoverProviderFree(id)),
    );
    const freeModels = firewall.allModels().filter((m) => m.costProfile?.isFree).length;
    return { ok: true, freeModels };
  } catch (error) {
    return { ok: false, freeModels: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
});

ipcMain.handle("provider:getCredentialStatus", async () => {
  return getProviderCredentialStatus();
});

ipcMain.handle("provider:setCredential", async (_event, providerId: string, apiKey: string) => {
  if (!isValidProviderId(providerId)) throw new Error("Invalid providerId");
  if (!isValidApiKey(apiKey)) throw new Error("Invalid API key");
  setProviderCredential(providerId, apiKey);
  desktopCredentialStore?.reload();

  // Register the real adapter (BYOK) for any routable provider and discover its verified-free
  // models. The cloudflare-account-id pseudo-credential is stored but not itself a provider.
  if (!PACKAGED_SMOKE && (ROUTABLE_PROVIDER_IDS as readonly string[]).includes(providerId)) {
    registerProviderAdapter(providerId);
    await discoverProviderFree(providerId);
  }
});

/**
 * Preferred OpenRouter connect path: OAuth PKCE via the system browser + loopback callback.
 * No API key is ever typed or logged; the resulting user-controlled key is stored encrypted via
 * safeStorage, the adapter is registered, and free models are discovered + verified immediately.
 */
ipcMain.handle("oauth:openrouter:start", async () => {
  if (PACKAGED_SMOKE) return { ok: false, error: "Unavailable in smoke mode" };
  try {
    const key = await runOpenRouterOAuth();
    setProviderCredential("openrouter", key);
    desktopCredentialStore?.reload();
    registerProviderAdapter("openrouter");
    const verifiedFree = await discoverProviderFree("openrouter");
    return { ok: true, verifiedFree };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
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

ipcMain.handle("legal:getFirstRunAck", async () => {
  return getFirstRunLegalAck();
});

ipcMain.handle("legal:setFirstRunAck", async () => {
  return setFirstRunLegalAck();
});

// --- CodeForge Cloud IPC Handlers ---

ipcMain.handle("cloud:auth:start", async () => {
  try {
    if (!CLOUD_API_URL) throw new CloudAuthError("configuration", "CodeForge Cloud endpoint is not configured");
    const result = await runCodeForgeCloudAuth({
      cloudApiUrl: CLOUD_API_URL,
    });
    saveCloudTokens(result.accessToken, result.refreshToken, result.user);
    await registerCloudAdapter();
    return { ok: true, user: result.user };
  } catch (error) {
    const kind = error instanceof CloudAuthError ? error.kind : "network";
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[CodeForge] cloud auth failed kind=${kind} endpointConfigured=${Boolean(CLOUD_API_URL)} detail=${detail}`);
    return { ok: false, error: describeCloudAuthFailure(error) };
  }
});

ipcMain.handle("cloud:account:get", async () => {
  if (PACKAGED_SMOKE) {
    return {
      user: { displayName: "Packaged smoke" },
      planId: "free",
      planName: "Free",
      creditBalance: 500000,
    };
  }
  const tokens = getStoredCloudTokens();
  if (!tokens.accessToken) return null;

  try {
    const res = await fetch(`${CLOUD_API_URL}/v1/account`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (res.status === 401 && tokens.refreshToken) {
      const refreshRes = await fetch(`${CLOUD_API_URL}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (refreshRes.ok) {
        const data = (await refreshRes.json()) as any;
        saveCloudTokens(data.accessToken, data.refreshToken, data.user);
        const retryRes = await fetch(`${CLOUD_API_URL}/v1/account`, {
          headers: { Authorization: `Bearer ${data.accessToken}` },
        });
        if (retryRes.ok) return await retryRes.json();
      }
    }
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    return null;
  }
});

// GDPR Article 17 erasure (LEG-P0-02). No parameters accepted from the renderer beyond the
// explicit confirmation — the account acted on is always whichever one is currently signed in on
// this device, exactly like cloud:account:get / cloud:auth:logout above.
ipcMain.handle("cloud:account:delete", async () => {
  const tokens = getStoredCloudTokens();
  if (!tokens.accessToken) throw new Error("Must be signed in to CodeForge Cloud to delete your account");
  const res = await fetch(`${CLOUD_API_URL}/v1/account`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Account deletion failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const receipt = await res.json();
  clearCloudTokens();
  providerAuthState.delete("codeforge-cloud");
  if (firewall) {
    for (const model of firewall.allModels()) {
      if (model.providerId === "codeforge-cloud") firewall.unregister(model.providerId, model.modelId);
    }
  }
  return receipt;
});

ipcMain.handle("cloud:auth:logout", async () => {
  const tokens = getStoredCloudTokens();
  if (tokens.refreshToken) {
    try {
      await fetch(`${CLOUD_API_URL}/v1/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
    } catch {}
  }
  clearCloudTokens();
  providerAuthState.delete("codeforge-cloud");
  if (firewall) {
    for (const model of firewall.allModels()) {
      if (model.providerId === "codeforge-cloud") firewall.unregister(model.providerId, model.modelId);
    }
  }
});

ipcMain.handle("cloud:billing:checkout", async () => {
  const tokens = getStoredCloudTokens();
  if (!tokens.accessToken) throw new Error("Must be logged in to CodeForge Cloud");
  const res = await fetch(`${CLOUD_API_URL}/v1/billing/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({
      planId: "pro",
      successUrl: "https://codeforge.dev/app/billing/success",
      cancelUrl: "https://codeforge.dev/app/billing/cancel",
    }),
  });
  if (!res.ok) throw new Error(`Failed to create checkout session: HTTP ${res.status}`);
  const data = (await res.json()) as { checkoutUrl?: string };
  if (data.checkoutUrl) {
    await shell.openExternal(data.checkoutUrl);
  }
});

ipcMain.handle("cloud:billing:portal", async () => {
  const tokens = getStoredCloudTokens();
  if (!tokens.accessToken) throw new Error("Must be logged in to CodeForge Cloud");
  const res = await fetch(`${CLOUD_API_URL}/v1/billing/portal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({
      returnUrl: "https://codeforge.dev/app/billing/portal",
    }),
  });
  if (!res.ok) throw new Error(`Failed to create portal session: HTTP ${res.status}`);
  const data = (await res.json()) as { portalUrl?: string };
  if (data.portalUrl) {
    await shell.openExternal(data.portalUrl);
  }
});

ipcMain.handle("cloud:usage:get", async () => {
  const tokens = getStoredCloudTokens();
  if (!tokens.accessToken) return null;
  const res = await fetch(`${CLOUD_API_URL}/v1/usage`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (res.ok) return await res.json();
  return null;
});

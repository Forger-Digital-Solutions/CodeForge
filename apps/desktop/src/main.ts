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
import { ForgeZero, createGenericFreeRecord, type ProviderAvailabilityOracle } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider, createOpencodeAdapter, createOpenRouterAdapter, createProviderAdapterById, HostedProviderAdapter, type ProviderAdapter, type CredentialStore, type ProviderHealthResponse, type StreamEvent } from "@codeforge/providers";
import { NormalizedModelRegistry, discoverAndVerifyFree, verifyAllowanceViaProbe, getProviderPolicy, type LiveModelInfo } from "@codeforge/model-registry";
import { runOpenRouterOAuth } from "./openrouter-oauth-flow.js";
import { runCodeForgeCloudAuth, type CloudAuthResult } from "./cloud-auth-flow.js";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: CodeForgeServer | null = null;
let mainWindow: BrowserWindow | null = null;
let firewall: ForgeZero | null = null;
let providerCatalog: InMemoryProviderCatalog | null = null;
let desktopCredentialStore: DesktopCredentialStore | null = null;
let modelRegistry: NormalizedModelRegistry | null = null;
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
const CLOUD_ACCESS_TOKEN_KEY = "codeforge:cloud-access-token";
const CLOUD_REFRESH_TOKEN_KEY = "codeforge:cloud-refresh-token";
const CLOUD_USER_KEY = "codeforge:cloud-user";
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
  // No manifest at all: treat this as a development checkout.
  return { channel: "development", endpoints: {} };
}

const RESOLVED_CLOUD_ENDPOINT = resolveCloudEndpoint({
  manifest: loadCloudEndpointManifest(),
  env: process.env,
  isPackaged: app.isPackaged,
});
const CLOUD_API_URL = RESOLVED_CLOUD_ENDPOINT.url;
console.log(`[CodeForge] cloud endpoint ${describeCloudEndpoint(RESOLVED_CLOUD_ENDPOINT)}`);
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

function setOnboardingCompleted(completed: boolean): void {
  if (typeof completed !== "boolean") throw new Error("Invalid onboarding value");
  const settings = readSettings();
  settings[ONBOARDING_COMPLETED_KEY] = completed;
  writeSettingsAtomic(settings);
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

async function registerCloudAdapter(): Promise<void> {
  if (!providerCatalog || !firewall) return;
  const existing = providerCatalog.get("codeforge-cloud");
  const cloudAdapter = existing instanceof HostedProviderAdapter
    ? existing
    : new HostedProviderAdapter({
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
  if (!(existing instanceof HostedProviderAdapter)) providerCatalog.register(cloudAdapter);
  providerAuthState.set("codeforge-cloud", "ok");

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
  const shellText = await evaluateRenderer<string>("document.body.innerText");
  smokeRecord("packaged_repository_query_known_answer=PASS");
  if (!shellText.includes("Repository Intelligence") || !shellText.includes("Local structural index")) throw new Error("Packaged repository status UX was not visible");
  const escape = await apiJson(`/api/workspace/tree?path=${encodeURIComponent(path.dirname(workspacePath))}`);
  if (escape.status !== 403) throw new Error(`Workspace escape returned ${escape.status}`);
  smokeRecord("packaged_workspace_restore=PASS");
  smokeRecord("packaged_workspace_escape_blocked=PASS");
  smokeRecord("packaged_repository_index_ready=PASS");
  smokeRecord("packaged_repository_search=PASS");
  smokeRecord("packaged_repository_index_ui_responsive=PASS");
  smokeRecord("packaged_substantial_repository=PASS");

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

async function startPrimaryInstance(): Promise<void> {
  smokeRecord("WHEN_READY_START");
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
    if (cloudTokens.accessToken) {
      await registerCloudAdapter();
    }
  }

  registerFreeModels(firewall);
  smokeRecord("WHEN_READY_MODELS_REGISTERED");

  const dbPath = path.join(app.getPath("userData"), "codeforge.db");
  smokeRecord(`WHEN_READY_DBPATH_${dbPath}`);
  await initializeServer(dbPath);
  smokeRecord("WHEN_READY_SERVER_INITIALIZED");

  createWindow();
  smokeRecord("WHEN_READY_WINDOW_CREATED");

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

// --- CodeForge Cloud IPC Handlers ---

ipcMain.handle("cloud:auth:start", async () => {
  try {
    const result = await runCodeForgeCloudAuth({
      cloudApiUrl: CLOUD_API_URL,
    });
    saveCloudTokens(result.accessToken, result.refreshToken, result.user);
    await registerCloudAdapter();
    return { ok: true, user: result.user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

ipcMain.handle("cloud:account:get", async () => {
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

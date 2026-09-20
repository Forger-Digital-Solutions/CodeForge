import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Download, type Page } from "playwright-core";
import { redactSecrets } from "@codeforge/secrets";
import {
  assertUrlAllowed,
  checkUrl,
  DEFAULT_BROWSER_POLICY,
  type BrowserPolicy,
  type UrlNetworkClass,
} from "./policy.js";
import { resolveBrowserCandidates, type BrowserExecutableCandidate } from "./resolver.js";

/**
 * Governed browser runtime (R22).
 *
 * Boundaries:
 * - Every session runs in a fresh isolated context: no shared cookies, no user profile reuse.
 * - Every navigation passes URL policy (scheme + SSRF/metadata + DNS rebinding checks).
 * - Page content is evidence, never authority — tool output is wrapped by the executor layer.
 * - Downloads are captured to a quarantine directory, hashed, and never executed.
 * - Console/network observations are sanitized: no cookies, no Authorization headers, bounded size.
 * - Nothing here decides permissions; the tool layer classifies effects and the authority engine
 *   (packages/permissions) decides.
 */

export const BROWSER_RUNTIME_ERRORS = {
  BROWSER_UNAVAILABLE: "BROWSER_UNAVAILABLE",
  BROWSER_SESSION_NOT_FOUND: "BROWSER_SESSION_NOT_FOUND",
  BROWSER_TAB_NOT_FOUND: "BROWSER_TAB_NOT_FOUND",
  BROWSER_NAVIGATION_DENIED: "BROWSER_NAVIGATION_DENIED",
  BROWSER_NAVIGATION_FAILED: "BROWSER_NAVIGATION_FAILED",
  BROWSER_TARGET_NOT_FOUND: "BROWSER_TARGET_NOT_FOUND",
  BROWSER_TIMEOUT: "BROWSER_TIMEOUT",
  BROWSER_CLOSED: "BROWSER_CLOSED",
  BROWSER_DOWNLOAD_DENIED: "BROWSER_DOWNLOAD_DENIED",
  BROWSER_ARGUMENT_INVALID: "BROWSER_ARGUMENT_INVALID",
} as const;
export type BrowserRuntimeErrorCode = (typeof BROWSER_RUNTIME_ERRORS)[keyof typeof BROWSER_RUNTIME_ERRORS];

export class BrowserRuntimeError extends Error {
  constructor(readonly code: BrowserRuntimeErrorCode, message: string) {
    super(message);
    this.name = "BrowserRuntimeError";
  }
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
}

export interface NetworkObservation {
  method: string;
  /** Scheme + host only — never query strings, which can carry tokens. */
  host: string;
  pathHash: string;
  status?: number;
  failure?: string;
  durationMs?: number;
}

export interface DownloadRecord {
  downloadId: string;
  suggestedFilename: string;
  savedAs: string;
  sha256: string;
  bytes: number;
  sourceUrlHost: string;
  canceled: boolean;
  at: string;
}

export interface ScreenshotRecord {
  screenshotId: string;
  sha256: string;
  bytes: number;
  path?: string;
  at: string;
}

export interface DomInteractiveElement {
  index: number;
  tag: string;
  role?: string;
  accessibleName?: string;
  testId?: string;
  selectorHint: string;
  hrefHost?: string;
  disabled?: boolean;
}

export interface DomSnapshot {
  url: string;
  title: string;
  snapshotHash: string;
  interactiveElements: DomInteractiveElement[];
  textExcerpt: string;
  truncated: boolean;
}

export interface BrowserActionReceipt {
  sessionId: string;
  tabId: string;
  action: string;
  url: string;
  title: string;
  networkClass?: UrlNetworkClass;
  targetRevision?: string;
  consoleErrorCount: number;
  failedRequestCount: number;
  snapshotHash?: string;
  screenshotHash?: string;
  at: string;
}

export type BrowserSessionStatus = "active" | "crashed" | "closed";

export interface BrowserSessionInfo {
  sessionId: string;
  status: BrowserSessionStatus;
  headless: boolean;
  executableSource: string;
  targetRevision?: string;
  createdAt: string;
  closedAt?: string;
}

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

export type InteractionTarget =
  | { selector: string }
  | { role: string; name?: string }
  | { testId: string }
  | { label: string }
  | { text: string };

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 400;
const MAX_TEXT_EXCERPT = 4000;
const MAX_INTERACTIVE_ELEMENTS = 120;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

/**
 * In-page DOM extraction, evaluated as a string so this module keeps strict Node types. Returns
 * the interactive element inventory (semantic targets first) plus a bounded text excerpt.
 */
const DOM_INSPECT_FN = `function domInspect(opts) {
  var maxElements = opts.maxElements, maxText = opts.maxText;
  function implicitRole(tag, el) {
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : undefined;
      case "button": return "button";
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "summary": return "button";
      case "input": {
        var type = el.type;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (["button", "submit", "reset"].indexOf(type) !== -1) return "button";
        return "textbox";
      }
      default: return undefined;
    }
  }
  var interactive = Array.prototype.slice.call(
    document.querySelectorAll("a, button, input, select, textarea, [role], [data-testid], [data-test-id], [onclick], summary")
  ).slice(0, maxElements);
  var elements = interactive.map(function (el, index) {
    var style = window.getComputedStyle(el);
    var visible = style.display !== "none" && style.visibility !== "hidden";
    var rect = el.getBoundingClientRect();
    var onscreen = rect.width > 0 && rect.height > 0;
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role") || implicitRole(tag, el);
    var name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")
      || (el instanceof HTMLInputElement ? (el.placeholder || el.name) : undefined)
      || (el.textContent ? el.textContent.trim().slice(0, 120) : undefined);
    var testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || undefined;
    var id = el.id ? "#" + el.id : undefined;
    var href = el instanceof HTMLAnchorElement ? el.href : undefined;
    return {
      index: index,
      tag: tag,
      role: role || undefined,
      accessibleName: visible && onscreen ? (name || undefined) : (name ? name + " (hidden)" : undefined),
      testId: testId,
      selectorHint: testId ? '[data-testid="' + testId + '"]' : (id || tag + ":nth-of-type(" + (index + 1) + ")"),
      hrefHost: href ? new URL(href, location.href).host : undefined,
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
    };
  });
  var text = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim();
  return { elements: elements, text: text.slice(0, maxText), textBytes: text.length };
}`;

export interface GovernedBrowserRuntimeOptions {
  policy?: BrowserPolicy;
  /** Directory downloads are quarantined into. Required — downloads never land in the workspace. */
  downloadDir: string;
  /** Optional directory for persisted screenshot evidence. */
  screenshotDir?: string;
  headless?: boolean;
  candidates?: BrowserExecutableCandidate[];
  resolveHost?: (host: string) => Promise<string[]>;
  /** Bound on concurrently open sessions; prevents a runaway agent from spawning browsers. */
  maxSessions?: number;
}

interface TabState {
  page: Page;
  console: ConsoleEntry[];
  network: NetworkObservation[];
  downloads: DownloadRecord[];
}

export class GovernedBrowserRuntime {
  private readonly policy: BrowserPolicy;
  private readonly downloadDir: string;
  private readonly screenshotDir?: string;
  private readonly headless: boolean;
  private readonly candidates: BrowserExecutableCandidate[];
  private readonly resolveHost?: (host: string) => Promise<string[]>;
  private readonly maxSessions: number;
  private browser?: Browser;
  private browserSource?: string;
  private launchPromise?: Promise<Browser>;
  private readonly sessions = new Map<string, BrowserSessionImpl>();

  constructor(options: GovernedBrowserRuntimeOptions) {
    if (!options.downloadDir) throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_ARGUMENT_INVALID, "downloadDir is required");
    this.policy = options.policy ?? DEFAULT_BROWSER_POLICY;
    this.downloadDir = options.downloadDir;
    this.screenshotDir = options.screenshotDir;
    this.headless = options.headless ?? true;
    this.candidates = options.candidates ?? resolveBrowserCandidates();
    this.resolveHost = options.resolveHost;
    this.maxSessions = options.maxSessions ?? 4;
    fs.mkdirSync(this.downloadDir, { recursive: true });
    if (this.screenshotDir) fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launchPromise) {
      this.launchPromise = this.launchChain();
      this.launchPromise.catch(() => {
        this.launchPromise = undefined;
      });
    }
    return this.launchPromise;
  }

  private async launchChain(): Promise<Browser> {
    if (this.candidates.length === 0) {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_UNAVAILABLE, "No Chromium-family browser found (Edge/Chrome/Chromium)");
    }
    const failures: string[] = [];
    for (const candidate of this.candidates) {
      try {
        const browser = await chromium.launch({
          headless: this.headless,
          ...(candidate.kind === "channel" ? { channel: candidate.channel } : { executablePath: candidate.executablePath }),
          args: ["--disable-features=TranslateUI", "--no-first-run", "--no-default-browser-check"],
        });
        this.browser = browser;
        this.browserSource = candidate.source;
        browser.on("disconnected", () => {
          for (const session of this.sessions.values()) {
            if (session.status === "active") session.status = "crashed";
          }
        });
        return browser;
      } catch (error) {
        failures.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_UNAVAILABLE, `No browser candidate launched (${failures.join("; ")})`);
  }

  async openSession(options: { headless?: boolean; targetRevision?: string; viewport?: { width: number; height: number } } = {}): Promise<BrowserSessionImpl> {
    const live = [...this.sessions.values()].filter((s) => s.status === "active").length;
    if (live >= this.maxSessions) {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_UNAVAILABLE, `Session limit reached (${this.maxSessions})`);
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: options.viewport ?? { width: 1280, height: 800 },
      ignoreHTTPSErrors: false,
    });
    // SSRF hard boundary: every request the page issues — including redirect hops, subresource
    // fetches, XHR/fetch, and WebSocket upgrades — is re-checked against URL policy. The initial
    // navigation check alone cannot see a 302 into a metadata or private-network target.
    await context.route("**/*", async (route) => {
      const decision = await this.checkNavigation(route.request().url());
      if (!decision.allowed) {
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
    const session = new BrowserSessionImpl(this, context, {
      headless: options.headless ?? this.headless,
      targetRevision: options.targetRevision,
      executableSource: this.browserSource ?? "unknown",
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(sessionId: string): BrowserSessionImpl | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): BrowserSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  async checkNavigation(url: string): Promise<{ allowed: true; networkClass: UrlNetworkClass } | { allowed: false; reason: string }> {
    const decision = await assertUrlAllowed(url, this.policy, this.resolveHost);
    if (!decision.allowed) return decision;
    return { allowed: true, networkClass: decision.networkClass };
  }

  policyCheck(url: string): ReturnType<typeof checkUrl> {
    return checkUrl(url, this.policy);
  }

  quarantinePath(suggestedFilename: string): string {
    const safe = suggestedFilename.replace(/[\\/:*?"<>| -]/g, "_").replace(/^\.+$/, "_") || "download.bin";
    return path.join(this.downloadDir, `${crypto.randomUUID()}-${safe}`);
  }

  screenshotPath(screenshotId: string): string | undefined {
    return this.screenshotDir ? path.join(this.screenshotDir, `${screenshotId}.png`) : undefined;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.close();
    return true;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close().catch(() => undefined);
    }
    this.sessions.clear();
    const browser = this.browser;
    this.browser = undefined;
    this.launchPromise = undefined;
    if (browser) await browser.close().catch(() => undefined);
  }
}

let tabCounter = 0;

export class BrowserSessionImpl {
  readonly sessionId = `browser-${crypto.randomUUID()}`;
  status: BrowserSessionStatus = "active";
  private readonly context: BrowserContext;
  private readonly tabs = new Map<string, TabState>();
  private activeTabId?: string;
  private readonly createdAt = new Date().toISOString();
  private closedAt?: string;
  private readonly headless: boolean;
  private readonly executableSource: string;
  private readonly targetRevision?: string;

  constructor(
    private readonly runtime: GovernedBrowserRuntime,
    context: BrowserContext,
    meta: { headless: boolean; targetRevision?: string; executableSource: string },
  ) {
    this.context = context;
    this.headless = meta.headless;
    this.executableSource = meta.executableSource;
    this.targetRevision = meta.targetRevision;
    context.on("close", () => {
      if (this.status === "active") this.status = "closed";
      this.closedAt ??= new Date().toISOString();
    });
  }

  info(): BrowserSessionInfo {
    return {
      sessionId: this.sessionId,
      status: this.status,
      headless: this.headless,
      executableSource: this.executableSource,
      ...(this.targetRevision ? { targetRevision: this.targetRevision } : {}),
      createdAt: this.createdAt,
      ...(this.closedAt ? { closedAt: this.closedAt } : {}),
    };
  }

  private assertActive(): void {
    if (this.status !== "active") {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_CLOSED, `Browser session is ${this.status}`);
    }
  }

  private instrumentPage(page: Page, tab: TabState): void {
    page.on("console", (message) => {
      if (tab.console.length >= MAX_CONSOLE_ENTRIES) tab.console.shift();
      const location = message.location();
      tab.console.push({
        type: message.type(),
        text: redactSecrets(message.text()).slice(0, 1000),
        ...(location?.url ? { location: sanitizeLocation(location.url) } : {}),
      });
    });
    page.on("pageerror", (error) => {
      if (tab.console.length >= MAX_CONSOLE_ENTRIES) tab.console.shift();
      tab.console.push({ type: "pageerror", text: redactSecrets(String(error?.message ?? error)).slice(0, 1000) });
    });
    page.on("response", (response) => {
      if (tab.network.length >= MAX_NETWORK_ENTRIES) tab.network.shift();
      const timing = response.request().timing();
      tab.network.push({
        method: response.request().method(),
        host: hostOf(response.url()),
        pathHash: pathHash(response.url()),
        status: response.status(),
        ...(timing ? { durationMs: Math.max(0, Math.round(timing.responseEnd)) } : {}),
      });
    });
    page.on("requestfailed", (request) => {
      if (tab.network.length >= MAX_NETWORK_ENTRIES) tab.network.shift();
      tab.network.push({
        method: request.method(),
        host: hostOf(request.url()),
        pathHash: pathHash(request.url()),
        failure: redactSecrets(request.failure()?.errorText ?? "unknown").slice(0, 300),
      });
    });
    page.on("download", (download) => {
      void this.captureDownload(tab, download);
    });
    page.on("crash", () => {
      this.status = "crashed";
    });
  }

  private async captureDownload(tab: TabState, download: Download): Promise<void> {
    const suggested = download.suggestedFilename() || "download.bin";
    const destination = this.runtime.quarantinePath(suggested);
    const record: DownloadRecord = {
      downloadId: `dl-${crypto.randomUUID()}`,
      suggestedFilename: suggested,
      savedAs: destination,
      sha256: "",
      bytes: 0,
      sourceUrlHost: hostOf(download.url()),
      canceled: false,
      at: new Date().toISOString(),
    };
    try {
      await download.saveAs(destination);
      const buf = fs.readFileSync(destination);
      record.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      record.bytes = buf.length;
    } catch {
      record.canceled = true;
    }
    tab.downloads.push(record);
  }

  private async newTab(): Promise<{ tabId: string; state: TabState }> {
    this.assertActive();
    const page = await this.context.newPage();
    const tabId = `tab-${++tabCounter}-${crypto.randomUUID().slice(0, 8)}`;
    const state: TabState = { page, console: [], network: [], downloads: [] };
    this.instrumentPage(page, state);
    this.tabs.set(tabId, state);
    this.activeTabId = tabId;
    return { tabId, state };
  }

  private tab(tabId?: string): { tabId: string; state: TabState } {
    const id = tabId ?? this.activeTabId;
    if (!id) throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_TAB_NOT_FOUND, "No tab is open");
    const state = this.tabs.get(id);
    if (!state) throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_TAB_NOT_FOUND, `Tab ${id} does not exist`);
    return { tabId: id, state };
  }

  private receipt(tabId: string, action: string, extra: Partial<BrowserActionReceipt> = {}): BrowserActionReceipt {
    const state = this.tabs.get(tabId);
    return {
      sessionId: this.sessionId,
      tabId,
      action,
      url: state?.page.url() ?? "",
      title: "",
      consoleErrorCount: state?.console.filter((c) => c.type === "error" || c.type === "pageerror").length ?? 0,
      failedRequestCount: state?.network.filter((n) => n.failure !== undefined || (n.status !== undefined && n.status >= 400)).length ?? 0,
      ...(this.targetRevision ? { targetRevision: this.targetRevision } : {}),
      at: new Date().toISOString(),
      ...extra,
    };
  }

  async navigate(url: string, options: { tabId?: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" } = {}): Promise<BrowserActionReceipt> {
    this.assertActive();
    const decision = await this.runtime.checkNavigation(url);
    if (!decision.allowed) {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_NAVIGATION_DENIED, `Navigation denied: ${decision.reason}`);
    }
    const { tabId, state } = options.tabId ? this.tab(options.tabId) : await this.newTab();
    try {
      await state.page.goto(url, { waitUntil: options.waitUntil ?? "load", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERRORS.BROWSER_NAVIGATION_FAILED,
        `Navigation failed: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      );
    }
    const title = await state.page.title().catch(() => "");
    return this.receipt(tabId, "navigate", { url: state.page.url(), title, networkClass: decision.networkClass });
  }

  private locator(state: TabState, target: InteractionTarget) {
    if ("selector" in target) return state.page.locator(target.selector);
    if ("role" in target) {
      const role = target.role as Parameters<Page["getByRole"]>[0];
      return state.page.getByRole(role, target.name ? { name: target.name } : {});
    }
    if ("testId" in target) return state.page.getByTestId(target.testId);
    if ("label" in target) return state.page.getByLabel(target.label);
    return state.page.getByText(target.text);
  }

  private static targetDescription(target: InteractionTarget): string {
    if ("selector" in target) return `selector ${target.selector}`;
    if ("role" in target) return `role ${target.role}${target.name ? ` named "${target.name}"` : ""}`;
    if ("testId" in target) return `test id ${target.testId}`;
    if ("label" in target) return `label ${target.label}`;
    return `text "${target.text}"`;
  }

  private async actionable(state: TabState, target: InteractionTarget) {
    const locator = this.locator(state, target);
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERRORS.BROWSER_TARGET_NOT_FOUND,
        `No element matches ${BrowserSessionImpl.targetDescription(target)}`,
      );
    }
    return locator.first();
  }

  async click(target: InteractionTarget, options: { tabId?: string } = {}): Promise<BrowserActionReceipt> {
    this.assertActive();
    const { tabId, state } = this.tab(options.tabId);
    const element = await this.actionable(state, target);
    await element.click({ timeout: ACTION_TIMEOUT_MS });
    const title = await state.page.title().catch(() => "");
    return this.receipt(tabId, "click", { url: state.page.url(), title });
  }

  /**
   * `sensitive: true` marks typed content as a credential: the value is never echoed into
   * receipts, console capture of the keystroke is impossible anyway, and callers must route the
   * value from an approved secret store — never from model-generated text.
   */
  async type(target: InteractionTarget, text: string, options: { tabId?: string; sensitive?: boolean; submit?: boolean } = {}): Promise<BrowserActionReceipt> {
    this.assertActive();
    if (typeof text !== "string" || text.length > 10_000) {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_ARGUMENT_INVALID, "type text must be a string ≤10000 chars");
    }
    const { tabId, state } = this.tab(options.tabId);
    const element = await this.actionable(state, target);
    await element.fill(text, { timeout: ACTION_TIMEOUT_MS });
    if (options.submit) await element.press("Enter", { timeout: ACTION_TIMEOUT_MS });
    const title = await state.page.title().catch(() => "");
    return this.receipt(tabId, options.submit ? "type+submit" : "type", { url: state.page.url(), title });
  }

  async select(target: InteractionTarget, values: string[], options: { tabId?: string } = {}): Promise<BrowserActionReceipt> {
    this.assertActive();
    const { tabId, state } = this.tab(options.tabId);
    const element = await this.actionable(state, target);
    await element.selectOption(values, { timeout: ACTION_TIMEOUT_MS });
    return this.receipt(tabId, "select", { url: state.page.url(), title: await state.page.title().catch(() => "") });
  }

  /** Submit is an external-write-capable action: the caller's authority layer classifies it. */
  async submit(target: InteractionTarget, options: { tabId?: string } = {}): Promise<BrowserActionReceipt> {
    this.assertActive();
    const { tabId, state } = this.tab(options.tabId);
    const element = await this.actionable(state, target);
    await Promise.all([
      state.page.waitForLoadState("load", { timeout: ACTION_TIMEOUT_MS }).catch(() => undefined),
      element.press("Enter", { timeout: ACTION_TIMEOUT_MS }).catch(async () => element.click({ timeout: ACTION_TIMEOUT_MS })),
    ]);
    return this.receipt(tabId, "submit", { url: state.page.url(), title: await state.page.title().catch(() => "") });
  }

  async waitFor(options: { tabId?: string; selector?: string; state?: "attached" | "visible" | "hidden"; url?: string; timeoutMs?: number } = {}): Promise<BrowserActionReceipt> {
    this.assertActive();
    const { tabId, state } = this.tab(options.tabId);
    const timeout = Math.min(options.timeoutMs ?? ACTION_TIMEOUT_MS, 60_000);
    try {
      if (options.selector) {
        await state.page.locator(options.selector).first().waitFor({ state: options.state ?? "visible", timeout });
      } else if (options.url) {
        await state.page.waitForURL(options.url, { timeout });
      } else {
        await state.page.waitForLoadState("load", { timeout });
      }
    } catch {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_TIMEOUT, "waitFor timed out");
    }
    return this.receipt(tabId, "wait", { url: state.page.url(), title: await state.page.title().catch(() => "") });
  }

  async inspect(options: { tabId?: string } = {}): Promise<{ snapshot: DomSnapshot; receipt: BrowserActionReceipt }> {
    this.assertActive();
    const { tabId, state } = this.tab(options.tabId);
    const raw = (await state.page.evaluate(
      `(${DOM_INSPECT_FN})(${JSON.stringify({ maxElements: MAX_INTERACTIVE_ELEMENTS, maxText: MAX_TEXT_EXCERPT })})`,
    )) as { elements: DomInteractiveElement[]; text: string; textBytes: number };
    const snapshotHash = crypto.createHash("sha256").update(JSON.stringify(raw.elements)).digest("hex");
    const snapshot: DomSnapshot = {
      url: state.page.url(),
      title: await state.page.title().catch(() => ""),
      snapshotHash,
      interactiveElements: raw.elements,
      textExcerpt: redactSecrets(raw.text),
      truncated: raw.textBytes > MAX_TEXT_EXCERPT,
    };
    const receipt = this.receipt(tabId, "inspect", { url: snapshot.url, title: snapshot.title, snapshotHash });
    return { snapshot, receipt };
  }

  async screenshot(options: { tabId?: string; persist?: boolean } = {}): Promise<{ record: ScreenshotRecord; receipt: BrowserActionReceipt; pngBase64?: string }> {
    this.assertActive();
    const { tabId, state } = this.tab(options.tabId);
    const buffer = await state.page.screenshot({ type: "png", fullPage: false, timeout: ACTION_TIMEOUT_MS });
    const screenshotId = `shot-${crypto.randomUUID()}`;
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    let savedPath: string | undefined;
    if (options.persist) {
      savedPath = this.runtime.screenshotPath(screenshotId);
      if (savedPath) fs.writeFileSync(savedPath, buffer);
    }
    const record: ScreenshotRecord = {
      screenshotId,
      sha256,
      bytes: buffer.length,
      ...(savedPath ? { path: savedPath } : {}),
      at: new Date().toISOString(),
    };
    const receipt = this.receipt(tabId, "screenshot", { url: state.page.url(), screenshotHash: sha256 });
    return { record, receipt, pngBase64: options.persist ? undefined : buffer.toString("base64") };
  }

  listTabs(): TabInfo[] {
    const result: TabInfo[] = [];
    for (const [tabId, state] of this.tabs) {
      result.push({ tabId, url: state.page.url(), title: "", active: tabId === this.activeTabId });
    }
    return result;
  }

  async switchTab(tabId: string): Promise<BrowserActionReceipt> {
    this.assertActive();
    const { state } = this.tab(tabId);
    this.activeTabId = tabId;
    await state.page.bringToFront().catch(() => undefined);
    return this.receipt(tabId, "switch_tab", { url: state.page.url(), title: await state.page.title().catch(() => "") });
  }

  async closeTab(tabId?: string): Promise<boolean> {
    const { tabId: id, state } = this.tab(tabId);
    this.tabs.delete(id);
    await state.page.close().catch(() => undefined);
    if (this.activeTabId === id) this.activeTabId = this.tabs.keys().next().value;
    return true;
  }

  consoleLog(tabId?: string): ConsoleEntry[] {
    const { state } = this.tab(tabId);
    return [...state.console];
  }

  networkLog(tabId?: string): NetworkObservation[] {
    const { state } = this.tab(tabId);
    return [...state.network];
  }

  downloads(tabId?: string): DownloadRecord[] {
    const { state } = this.tab(tabId);
    return [...state.downloads];
  }

  /** Current-page text excerpt for verification assertions — sanitized, untrusted evidence. */
  async pageText(tabId?: string, maxChars = 2000): Promise<string> {
    const { state } = this.tab(tabId);
    const text = await state.page.evaluate("document.body ? document.body.innerText : ''");
    return redactSecrets(String(text).replace(/\s+/g, " ").trim().slice(0, maxChars));
  }

  async isVisible(selector: string, tabId?: string): Promise<boolean> {
    const { state } = this.tab(tabId);
    return state.page.locator(selector).first().isVisible().catch(() => false);
  }

  async close(): Promise<void> {
    if (this.status === "closed") return;
    this.status = "closed";
    this.closedAt = new Date().toISOString();
    await this.context.close().catch(() => undefined);
  }
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "unknown";
  }
}

function pathHash(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return crypto.createHash("sha256").update(url.pathname + url.search).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function sanitizeLocation(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

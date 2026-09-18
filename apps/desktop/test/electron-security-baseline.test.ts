/**
 * Electron security baseline (Security R1, Phases 21/56).
 *
 * Static assertions over the desktop main process, preload, and renderer CSP. They are
 * deliberately source-level: a regression that weakens the sandbox must fail here before any
 * packaged build exists. The packaged bundle is re-checked by
 * scripts/audit-packaged-browser-security.mjs at release time.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productionRendererCsp } from "../vite.config.js";

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(here, "..", "src", "main.ts"), "utf8");
const preloadSource = readFileSync(resolve(here, "..", "src", "preload.ts"), "utf8");
const preloadShipped = readFileSync(resolve(here, "..", "src", "preload.cjs"), "utf8");
const rendererHtml = readFileSync(resolve(here, "..", "src", "renderer", "index.html"), "utf8");

/** Every `new BrowserWindow({ ... })` block in main.ts, with its webPreferences text. */
function browserWindowBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /new BrowserWindow\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + "new BrowserWindow(".length;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(match.index, i + 1));
  }
  return blocks;
}

describe("Electron security baseline", () => {
  it("every BrowserWindow enforces nodeIntegration=false, contextIsolation=true, sandbox=true, webSecurity=true", () => {
    const blocks = browserWindowBlocks(mainSource);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).toMatch(/nodeIntegration:\s*false/);
      expect(block).toMatch(/contextIsolation:\s*true/);
      expect(block).toMatch(/sandbox:\s*true/);
      expect(block).toMatch(/webSecurity:\s*true/);
      expect(block).not.toMatch(/allowRunningInsecureContent:\s*true/);
      expect(block).not.toMatch(/webviewTag:\s*true/);
      expect(block).not.toMatch(/enableRemoteModule/);
      expect(block).not.toMatch(/nodeIntegrationInWorker:\s*true/);
      expect(block).not.toMatch(/nodeIntegrationInSubFrames:\s*true/);
      expect(block).not.toMatch(/experimentalFeatures:\s*true/);
      expect(block).not.toMatch(/additionalArguments/);
    }
  });

  it("never disables the Chromium sandbox or web security via command-line switches", () => {
    expect(mainSource).not.toMatch(/appendSwitch\(\s*["'](no-sandbox|disable-web-security|disable-site-isolation-trials|allow-running-insecure-content|ignore-certificate-errors)["']/);
    expect(mainSource).not.toMatch(/setCertificateVerifyProc/);
    expect(mainSource).not.toMatch(/certificate-error/);
    expect(mainSource).not.toMatch(/\bremote\b.*require\(["']@electron\/remote["']\)/);
  });

  it("governs navigation, popups, and external links", () => {
    expect(mainSource).toMatch(/webContents\.on\("will-navigate"/);
    expect(mainSource).toMatch(/setWindowOpenHandler\(/);
    expect(mainSource).toMatch(/return \{ action: "deny" \}/);
    expect(mainSource).toMatch(/isExternalLinkAllowed\(url\)/);
    // No `will-attach-webview` needed because webviewTag is never enabled; assert that stays true.
    expect(mainSource).not.toMatch(/webviewTag/);
  });

  it("denies web permission requests and downloads for the renderer session by default", () => {
    expect(mainSource).toMatch(/setPermissionRequestHandler\(\(_webContents, permission, callback\) => \{[\s\S]{0,200}callback\(false\)/);
    expect(mainSource).toMatch(/setPermissionCheckHandler\(\(\) => false\)/);
    expect(mainSource).toMatch(/session\.on\("will-download", \(event\) => \{\s*event\.preventDefault\(\);/);
  });

  it("validates the IPC sender on every privileged handler", () => {
    const handlers = [...mainSource.matchAll(/ipcMain\.handle\("([^"]+)",\s*(?:async\s*)?\((event[^)]*)\)\s*(?::[^=]+)?=>\s*\{([\s\S]*?)\n\}\);/g)];
    expect(handlers.length).toBeGreaterThan(30);
    const unguarded: string[] = [];
    for (const [, channel, , body] of handlers) {
      const guarded = /assertMainWindowSender\(event\)/.test(body) || /event\.sender !== mainWindow\?\.webContents/.test(body);
      if (!guarded) unguarded.push(channel);
    }
    expect(unguarded).toEqual([]);
  });

  it("exposes only narrow IPC-backed methods in the preload — no raw ipcRenderer, fs, shell, process, or require", () => {
    for (const source of [preloadSource, preloadShipped]) {
      expect(source).toMatch(/contextBridge\.exposeInMainWorld\("electronAPI"/);
      expect(source).not.toMatch(/exposeInMainWorld\("electronAPI",\s*ipcRenderer\)/);
      expect(source).not.toMatch(/exposeInMainWorld\(\s*["'](ipcRenderer|require|process|fs|shell|child_process)["']/);
      expect(source).not.toMatch(/ipcRenderer:\s*ipcRenderer/);
      expect(source).not.toMatch(/invoke:\s*\(channel/); // no generic invoke(channel, ...) passthrough
      expect(source).not.toMatch(/send:\s*\(channel/);
      expect(source).not.toMatch(/require\(["']child_process["']\)/);
      expect(source).not.toMatch(/require\(["']fs["']\)/);
      expect(source).not.toMatch(/controlPlaneToken/);
      expect(source).not.toMatch(/getProviderCredentials\b/);
      expect(source).not.toMatch(/getCloudTokens\b/);
    }
  });

  it("ships a renderer CSP with no wildcard sources and no inline scripts in production", () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(rendererHtml)![1]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(csp).not.toMatch(/connect-src[^;]*https?:\/\/\*/);
    expect(csp).not.toContain("unsafe-eval");
    const production = /Content-Security-Policy" content="([^"]+)"/.exec(productionRendererCsp(rendererHtml))![1]!;
    expect(production).toContain("script-src 'self';");
    expect(production).not.toMatch(/script-src[^;]*unsafe-inline/);
    // The only remote image source is GitHub avatars; the only network targets are loopback.
    expect(production).toContain("img-src 'self' data: https://avatars.githubusercontent.com");
    expect(production).toContain("connect-src 'self' http://127.0.0.1:* http://localhost:*");
  });

  it("stores local secrets only through the OS-backed codec and never reads plaintext fallbacks", () => {
    expect(mainSource).toMatch(/return openCredential\(safeStorage, value\);/);
    expect(mainSource).toMatch(/return sealCredential\(safeStorage, value\);/);
    expect(mainSource).not.toMatch(/if \(value\.startsWith\("enc:"\)\)[\s\S]{0,400}return value;/);
    expect(mainSource).toMatch(/migrateLegacyPlaintextSecrets\(\)/);
  });
});

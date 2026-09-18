import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("packaged desktop startup reliability", () => {
  it("disables the unsupported GPU compositor before Electron initialization", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    const disableIndex = source.indexOf("app.disableHardwareAcceleration();");
    const serverImportIndex = source.indexOf('from "@codeforge/server"');
    expect(disableIndex).toBeGreaterThan(-1);
    expect(source).toContain('app.commandLine.appendSwitch("disable-gpu");');
    expect(serverImportIndex).toBeGreaterThan(-1);
    expect(disableIndex).toBeLessThan(source.indexOf("const __dirname"));
  });

  it("loads the packaged renderer through a canonical ASAR-safe file URL", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    expect(source).toContain("async function createWindow(loadDocument = true): Promise<void>");
    expect(source).toContain("await window.loadURL(pathToFileURL(rendererFile).href);");
    expect(source).not.toContain("`file://${path.join(__dirname, \"renderer\", \"index.html\")}`");
  });

  it("binds the local runtime before the renderer loads so the real endpoint is available", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    const documentIndex = source.indexOf("await createWindowDocument();", source.indexOf('smokeRecord("WHEN_READY_SERVER_INITIALIZED")'));
    const serverIndex = source.indexOf("await initializeServer(dbPath);");
    expect(documentIndex).toBeGreaterThan(-1);
    expect(serverIndex).toBeGreaterThan(-1);
    expect(serverIndex).toBeLessThan(documentIndex);
    expect(source).toContain("port: 0,");
    expect(source).toContain('ipcMain.handle("app:runtime-endpoint"');
  });

  it("installs the control-plane bearer filter only once the runtime origin is bound", () => {
    // R2 installed the filter at window construction, before initializeServer had bound the
    // ephemeral port: the URL filter matched the preferred port instead, so no renderer request
    // ever carried the bearer and the packaged workspace was refused with 401 (found by R5).
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    const createWindowStart = source.indexOf("async function createWindow(loadDocument = true)");
    const createWindowEnd = source.indexOf("\n}", createWindowStart);
    expect(createWindowStart).toBeGreaterThan(-1);
    expect(source.slice(createWindowStart, createWindowEnd)).not.toContain("installControlPlaneBearerInjection(");
    const documentStart = source.indexOf("async function createWindowDocument()");
    const guardIndex = source.indexOf("if (localServerPort <= 0) throw new Error(", documentStart);
    const installIndex = source.indexOf("installControlPlaneBearerInjection(window);", documentStart);
    const loadIndex = source.indexOf("await window.loadURL(pathToFileURL(rendererFile).href);", documentStart);
    expect(guardIndex).toBeGreaterThan(documentStart);
    expect(installIndex).toBeGreaterThan(guardIndex);
    expect(loadIndex).toBeGreaterThan(installIndex);
  });

  it("waits for the renderer's loading state to settle instead of a second did-finish-load", () => {
    // loadURL() resolves on did-finish-load while the main frame still reports loading until
    // did-stop-loading; waiting for another did-finish-load at that point never returns (the R4
    // stall after WINDOW_READY_TO_SHOW).
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    const start = source.indexOf("async function waitForRenderer()");
    const end = source.indexOf("\n}", start);
    const body = source.slice(start, end);
    expect(body).toContain('contents.on("did-stop-loading", settle)');
    expect(body).not.toContain('once("did-finish-load"');
  });
});

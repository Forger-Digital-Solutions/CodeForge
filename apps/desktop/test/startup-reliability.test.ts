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

  it("loads the packaged renderer through Electron's canonical file-path API", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    expect(source).toContain("async function createWindow(loadDocument = true): Promise<void>");
    expect(source).toContain("await window.loadFile(rendererFile);");
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
});

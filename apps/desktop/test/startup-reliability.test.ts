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
    expect(source).toContain("async function createWindow(): Promise<void>");
    expect(source).toContain("await mainWindow.loadFile(rendererFile);");
    expect(source).not.toContain("`file://${path.join(__dirname, \"renderer\", \"index.html\")}`");
  });

  it("finishes the secure renderer launch before starting the local runtime", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    const windowIndex = source.indexOf("await createWindow();");
    const serverIndex = source.indexOf("await initializeServer(dbPath);");
    expect(windowIndex).toBeGreaterThan(-1);
    expect(serverIndex).toBeGreaterThan(-1);
    expect(windowIndex).toBeLessThan(serverIndex);
  });
});

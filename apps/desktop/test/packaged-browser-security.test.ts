import { describe, expect, it } from "vitest";
import { validatePackagedBrowserSecuritySource } from "../scripts/audit-packaged-browser-security.mjs";

const secureWindow = `
  new BrowserWindow({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: ["http://localhost:3210/*"] }, (details, callback) => {
    requestHeaders["X-CodeForge-Control-Token"] = controlPlaneToken;
  });
`;

const securePreload = `
const api = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
};
contextBridge.exposeInMainWorld("electronAPI", api);
`;

describe("packaged browser security gate", () => {
  it("accepts the complete secure BrowserWindow policy", () => {
    expect(validatePackagedBrowserSecuritySource(secureWindow, securePreload)).toEqual({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      controlPlaneBearerInjection: true,
      preloadBearerFree: true,
    });
  });

  it("requires the control-plane bearer injection contract in the shipped main bundle", () => {
    expect(() => validatePackagedBrowserSecuritySource(secureWindow.replace("webRequest.onBeforeSendHeaders(", "noop("), securePreload))
      .toThrow(/missing required control-plane bearer injection hook/);
    expect(() => validatePackagedBrowserSecuritySource(secureWindow.replace("X-CodeForge-Control-Token", "X-Other"), securePreload))
      .toThrow(/missing required control-plane bearer header/);
  });

  it("rejects a preload that hands the bearer to the renderer", () => {
    for (const leak of [
      "const controlPlaneToken = process.argv.find((a) => a.startsWith('--codeforge-control-plane-token='));",
      "const token = process.argv[3];",
    ]) {
      expect(() => validatePackagedBrowserSecuritySource(secureWindow, `${securePreload}\n${leak}`)).toThrow(/preload bridge exposes forbidden/);
    }
    expect(() => validatePackagedBrowserSecuritySource(secureWindow, "")).toThrow(/preload bridge is empty/);
  });

  it("rejects passing renderer arguments from the main process", () => {
    const source = secureWindow.replace("sandbox: true,", "sandbox: true,\n      additionalArguments: [`--token=${token}`],");
    expect(() => validatePackagedBrowserSecuritySource(source, securePreload)).toThrow(/forbidden browser security bypass additionalArguments/);
  });

  it.each([
    ["sandbox", secureWindow.replace("sandbox: true", "sandbox: false")],
    ["node integration", secureWindow.replace("nodeIntegration: false", "nodeIntegration: true")],
    ["context isolation", secureWindow.replace("contextIsolation: true", "contextIsolation: false")],
    ["web security", secureWindow.replace("webSecurity: true", "webSecurity: false")],
    ["no-sandbox switch", `${secureWindow}\napp.commandLine.appendSwitch("no-sandbox");`],
    ["disable-setuid-sandbox switch", `${secureWindow}\napp.commandLine.appendSwitch("disable-setuid-sandbox");`],
  ])("rejects the %s bypass", (_name, source) => {
    expect(() => validatePackagedBrowserSecuritySource(source)).toThrow(/missing|required|forbidden/);
  });
});

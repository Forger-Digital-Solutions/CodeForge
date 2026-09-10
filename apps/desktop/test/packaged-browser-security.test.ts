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
`;

describe("packaged browser security gate", () => {
  it("accepts the complete secure BrowserWindow policy", () => {
    expect(validatePackagedBrowserSecuritySource(secureWindow)).toEqual({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    });
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

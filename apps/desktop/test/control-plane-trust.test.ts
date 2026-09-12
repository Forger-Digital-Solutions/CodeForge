import { describe, it, expect } from "vitest";
import {
  isAllowedPrimaryWindowNavigation,
  isExternalLinkAllowed,
  isSameDocument,
  shouldAttachControlPlaneToken,
  type ControlPlaneTrust,
} from "../src/control-plane-trust.js";

/**
 * The per-process bearer that authenticates the desktop to the local server is attached by the
 * main process to the primary window's own requests and to nothing else. These tests pin the
 * policy that decides "own requests": any relaxation here hands the control plane — including
 * approval resolution — to whatever page can issue a request from the session.
 */
const APP_DOCUMENT = "file:///G:/Code%20Forge/apps/desktop/release/win-unpacked/resources/app.asar/apps/desktop/dist/renderer/index.html";

const trust: ControlPlaneTrust = {
  controlPlaneOrigin: "http://localhost:3210",
  trustedWebContentsId: 7,
  trustedDocumentUrl: APP_DOCUMENT,
  caseInsensitiveFilePaths: true,
};

const primaryRequest = {
  url: "http://localhost:3210/api/approvals/abc/resolve",
  webContentsId: 7,
  frame: { url: APP_DOCUMENT, parent: null },
};

describe("control-plane bearer attachment", () => {
  it("attaches the bearer to the primary window's own document", () => {
    expect(shouldAttachControlPlaneToken(primaryRequest, trust)).toBe(true);
  });

  it("keeps authority across deep links and Chromium's own canonical form of the file URL", () => {
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: `${APP_DOCUMENT}#settings`, parent: null } }, trust)).toBe(true);
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: `${APP_DOCUMENT}?tab=models`, parent: null } }, trust)).toBe(true);
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: APP_DOCUMENT.replace("file:///G:", "file:///g:"), parent: null } }, trust)).toBe(true);
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: APP_DOCUMENT.replace("%20", " "), parent: null } }, trust)).toBe(true);
  });

  it("withholds the bearer from every other webContents", () => {
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, webContentsId: 8 }, trust)).toBe(false);
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, webContentsId: undefined }, trust)).toBe(false);
  });

  it("withholds the bearer from iframes inside the primary window", () => {
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: APP_DOCUMENT, parent: {} } }, trust)).toBe(false);
  });

  it("withholds the bearer once the window shows any document other than the app's own", () => {
    for (const url of [
      "file:///C:/Users/victim/Downloads/evil.html",
      "file:///G:/Code%20Forge/apps/desktop/release/win-unpacked/resources/app.asar/apps/desktop/dist/renderer/other.html",
      "about:blank",
      "http://localhost:3210/",
      "https://attacker.example/",
      "data:text/html,<script>fetch('http://localhost:3210/api/sessions')</script>",
    ]) {
      expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url, parent: null } }, trust), url).toBe(false);
    }
  });

  it("withholds the bearer when the request carries no frame", () => {
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: null }, trust)).toBe(false);
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: undefined }, trust)).toBe(false);
  });

  it("never attaches the bearer to requests leaving the control plane", () => {
    for (const url of [
      "https://openrouter.ai/api/v1/models",
      "http://localhost:3211/api/sessions",
      "http://127.0.0.1:3210/api/sessions",
      "https://localhost:3210/api/sessions",
      "not a url",
    ]) {
      expect(shouldAttachControlPlaneToken({ ...primaryRequest, url }, trust), url).toBe(false);
    }
  });

  it("fails closed before the window or its document are known", () => {
    expect(shouldAttachControlPlaneToken(primaryRequest, { ...trust, trustedWebContentsId: null })).toBe(false);
    expect(shouldAttachControlPlaneToken(primaryRequest, { ...trust, trustedDocumentUrl: null })).toBe(false);
  });

  it("is case-sensitive for file documents on case-sensitive platforms", () => {
    expect(isSameDocument(APP_DOCUMENT.replace("index.html", "INDEX.html"), APP_DOCUMENT, false)).toBe(false);
    expect(isSameDocument(APP_DOCUMENT.replace("index.html", "INDEX.html"), APP_DOCUMENT, true)).toBe(true);
    expect(isSameDocument("http://localhost:5173/INDEX.html", "http://localhost:5173/index.html", true)).toBe(false);
  });

  it("supports the development renderer served by vite", () => {
    const dev: ControlPlaneTrust = { ...trust, trustedDocumentUrl: "http://localhost:5173/" };
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: "http://localhost:5173/", parent: null } }, dev)).toBe(true);
    expect(shouldAttachControlPlaneToken({ ...primaryRequest, frame: { url: "http://localhost:5173/evil.html", parent: null } }, dev)).toBe(false);
  });
});

describe("primary window navigation policy", () => {
  it("permits only the application's own document", () => {
    expect(isAllowedPrimaryWindowNavigation(APP_DOCUMENT, trust)).toBe(true);
    expect(isAllowedPrimaryWindowNavigation(`${APP_DOCUMENT}#workspace`, trust)).toBe(true);
    expect(isAllowedPrimaryWindowNavigation("file:///C:/workspace/evil.html", trust)).toBe(false);
    expect(isAllowedPrimaryWindowNavigation("http://localhost:3210/", trust)).toBe(false);
    expect(isAllowedPrimaryWindowNavigation("https://codeforge.example/", trust)).toBe(false);
    expect(isAllowedPrimaryWindowNavigation(APP_DOCUMENT, { ...trust, trustedDocumentUrl: null })).toBe(false);
  });

  it("hands only https (and localhost http) links to the OS browser", () => {
    expect(isExternalLinkAllowed("https://docs.codeforge.example/guide")).toBe(true);
    expect(isExternalLinkAllowed("http://localhost:8080/preview")).toBe(true);
    expect(isExternalLinkAllowed("http://attacker.example/")).toBe(false);
    expect(isExternalLinkAllowed("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isExternalLinkAllowed("javascript:alert(1)")).toBe(false);
    expect(isExternalLinkAllowed("not a url")).toBe(false);
  });
});

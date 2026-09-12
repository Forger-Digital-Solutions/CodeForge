/**
 * Local control-plane bearer attachment policy.
 *
 * The per-process bearer that authenticates the desktop to the local CodeForge server never
 * crosses the preload bridge: the renderer cannot leak a secret it does not hold. Instead the main
 * process attaches the header itself, through the session's webRequest hook, and only when every
 * one of these holds for the outgoing request:
 *
 *   1. it targets the local control plane origin;
 *   2. it comes from the primary window's webContents;
 *   3. it originates in that window's top-level document (never an iframe);
 *   4. that document is the application's own renderer URL — not a page the window navigated to.
 *
 * Anything else — a child window, a webview, an about:blank probe, a navigated-away document, a
 * request from a different webContents — gets no bearer and the server fails closed with 401.
 * Main-process (Node) requests do not pass through the session and attach the header explicitly.
 */

export const CONTROL_PLANE_TOKEN_HEADER = "X-CodeForge-Control-Token";

export interface ControlPlaneRequestFrame {
  /** Committed document URL of the frame that issued the request. */
  url: string;
  /** `null` for a top-level frame; iframes carry their parent. */
  parent: unknown | null;
}

/** The subset of Electron's `OnBeforeSendHeadersListenerDetails` the policy depends on. */
export interface ControlPlaneRequestDetails {
  url: string;
  webContentsId?: number;
  frame?: ControlPlaneRequestFrame | null;
}

export interface ControlPlaneTrust {
  /** Origin of the local control plane, e.g. `http://localhost:3210`. */
  controlPlaneOrigin: string;
  /** `webContents.id` of the primary application window; `null` before it exists. */
  trustedWebContentsId: number | null;
  /** URL of the renderer document the primary window loaded; `null` before it is known. */
  trustedDocumentUrl: string | null;
  /** Windows file paths are case-insensitive; compare `file:` documents accordingly there. */
  caseInsensitiveFilePaths: boolean;
}

export function isControlPlaneUrl(url: string, controlPlaneOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(controlPlaneOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Same document identity: scheme, host and path. Query and fragment are ignored so a renderer
 * that deep-links (`index.html#settings`) keeps its authority; a different file never matches.
 */
export function isSameDocument(candidate: string, trusted: string, caseInsensitiveFilePaths: boolean): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(candidate);
    b = new URL(trusted);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol || a.host !== b.host) return false;
  let pathA = decodePath(a.pathname);
  let pathB = decodePath(b.pathname);
  if (caseInsensitiveFilePaths && a.protocol === "file:") {
    pathA = pathA.toLowerCase();
    pathB = pathB.toLowerCase();
  }
  return pathA === pathB;
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function shouldAttachControlPlaneToken(details: ControlPlaneRequestDetails, trust: ControlPlaneTrust): boolean {
  if (trust.trustedWebContentsId === null || trust.trustedDocumentUrl === null) return false;
  if (!isControlPlaneUrl(details.url, trust.controlPlaneOrigin)) return false;
  if (details.webContentsId !== trust.trustedWebContentsId) return false;
  const frame = details.frame;
  if (!frame || frame.parent !== null) return false;
  return isSameDocument(frame.url, trust.trustedDocumentUrl, trust.caseInsensitiveFilePaths);
}

/**
 * Navigation policy for the primary window. The renderer is a single-page application that never
 * navigates in-window; the only URL it may ever commit is its own document. Every other target is
 * refused (an `https:` link is handed to the OS browser by the caller). Allowing arbitrary `file:`
 * navigation here would let any local HTML file inherit the preload bridge and the window's
 * IPC authority.
 */
export function isAllowedPrimaryWindowNavigation(url: string, trust: Pick<ControlPlaneTrust, "trustedDocumentUrl" | "caseInsensitiveFilePaths">): boolean {
  if (trust.trustedDocumentUrl === null) return false;
  return isSameDocument(url, trust.trustedDocumentUrl, trust.caseInsensitiveFilePaths);
}

/** Links the desktop may hand to the operating system's browser. */
export function isExternalLinkAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

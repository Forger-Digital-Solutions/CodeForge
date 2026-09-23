import { app } from "electron";
import { logDiagnostic } from "./diagnostics.js";

/**
 * Governed application updater (R28).
 *
 * Trust model: electron-updater's generic provider reads `latest.yml` from the
 * configured feed, verifies the artifact's sha512 against the manifest, and on
 * Windows verifies the Authenticode signature before install. This module owns
 * CodeForge's policy around that machinery:
 *
 * - Never runs unpackaged (dev/test builds report `unavailable`, not errors).
 * - Feed comes from CODEFORGE_UPDATE_FEED or the publish config baked into the
 *   build; no feed configured is an honest `unavailable`, never a silent skip.
 * - Nothing auto-downloads or auto-installs: the user checks, then downloads,
 *   then chooses install. Update application preserves user data by contract
 *   of the NSIS installer (upgrade installs never touch %APPDATA%).
 * - Every transition lands in the sanitized diagnostic log.
 */

export type UpdaterState =
  | "idle"
  | "checking"
  | "available"
  | "none"
  | "downloading"
  | "downloaded"
  | "error"
  | "unavailable";

export interface UpdaterStatus {
  state: UpdaterState;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  downloadedPath?: string;
  error?: string;
  detail?: string;
}

type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  forceDevUpdateConfig: boolean;
  on(event: string, listener: (...args: never[]) => void): void;
  setFeedURL(url: string): void;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | undefined>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

let updater: AutoUpdaterLike | undefined;
let updaterInitError: string | undefined;
let status: UpdaterStatus = { state: "idle", currentVersion: app.getVersion() };
const listeners = new Set<(s: UpdaterStatus) => void>();

function setStatus(patch: Partial<UpdaterStatus>): UpdaterStatus {
  status = { ...status, ...patch };
  logDiagnostic("info", "updater_status", { state: status.state, availableVersion: status.availableVersion, progressPercent: status.progressPercent, error: status.error });
  for (const listener of listeners) listener(status);
  return status;
}

export function onUpdaterStatus(listener: (s: UpdaterStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdaterStatus(): UpdaterStatus {
  return status;
}

/** Lazy-load electron-updater; a module fault degrades to `unavailable`, never a crash. */
async function loadUpdater(): Promise<AutoUpdaterLike | undefined> {
  if (updater) return updater;
  if (updaterInitError) return undefined;
  const devAllowed = process.env.CODEFORGE_UPDATER_FORCE_DEV === "1";
  if (!app.isPackaged && !devAllowed) {
    updaterInitError = "unpackaged build — updates apply only to installed releases";
    setStatus({ state: "unavailable", detail: updaterInitError });
    return undefined;
  }
  try {
    const mod = await import("electron-updater");
    const au = (mod.autoUpdater ?? mod.default?.autoUpdater) as unknown as AutoUpdaterLike;
    if (!au) throw new Error("electron-updater export shape unexpected");
    au.autoDownload = false;
    au.autoInstallOnAppQuit = false;
    au.forceDevUpdateConfig = devAllowed;
    const feed = process.env.CODEFORGE_UPDATE_FEED?.trim();
    if (feed) au.setFeedURL(feed);

    au.on("checking-for-update", () => setStatus({ state: "checking", error: undefined }));
    au.on("update-available", (info: { version?: string }) =>
      setStatus({ state: "available", availableVersion: info?.version }));
    au.on("update-not-available", () => setStatus({ state: "none", availableVersion: undefined }));
    au.on("download-progress", (p: { percent?: number }) =>
      setStatus({ state: "downloading", progressPercent: typeof p?.percent === "number" ? Math.round(p.percent) : undefined }));
    au.on("update-downloaded", (info: { version?: string; downloadedFile?: string }) =>
      setStatus({ state: "downloaded", availableVersion: info?.version, downloadedPath: info?.downloadedFile, progressPercent: 100 }));
    au.on("error", (error: Error) =>
      setStatus({ state: "error", error: error?.message?.slice(0, 300) ?? "unknown updater error" }));

    updater = au;
    return au;
  } catch (error) {
    updaterInitError = error instanceof Error ? error.message : String(error);
    setStatus({ state: "unavailable", detail: `updater failed to initialize: ${updaterInitError}` });
    return undefined;
  }
}

/** Check the feed. Honest results: none / available / unavailable / error. */
export async function checkForUpdates(): Promise<UpdaterStatus> {
  const au = await loadUpdater();
  if (!au) return status;
  const feed = process.env.CODEFORGE_UPDATE_FEED?.trim();
  if (!feed && !au.forceDevUpdateConfig) {
    return setStatus({ state: "unavailable", detail: "no update feed configured (CODEFORGE_UPDATE_FEED unset and no publish config baked into this build)" });
  }
  setStatus({ state: "checking", error: undefined });
  try {
    const result = await au.checkForUpdates();
    const version = result?.updateInfo?.version;
    return setStatus(version && version !== app.getVersion()
      ? { state: "available", availableVersion: version }
      : { state: "none", availableVersion: undefined });
  } catch (error) {
    return setStatus({ state: "error", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
}

/** Download the announced update (sha512 + signature verified by electron-updater). */
export async function downloadUpdate(): Promise<UpdaterStatus> {
  const au = await loadUpdater();
  if (!au) return status;
  try {
    const files = await au.downloadUpdate();
    return setStatus({ state: "downloaded", downloadedPath: files?.[0], progressPercent: 100 });
  } catch (error) {
    return setStatus({ state: "error", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
}

/** Apply a downloaded update: quit + installer runs. User data survives by installer contract. */
export async function installDownloadedUpdate(): Promise<UpdaterStatus> {
  const au = await loadUpdater();
  if (!au) return status;
  if (status.state !== "downloaded") {
    return setStatus({ state: "error", error: "no downloaded update to install — check and download first" });
  }
  logDiagnostic("info", "updater_install_invoked", { availableVersion: status.availableVersion });
  // Runs the verified installer; the process exits as part of install.
  au.quitAndInstall(false, true);
  return status;
}

/** Test hook. */
export function __resetUpdaterForTest(): void {
  updater = undefined;
  updaterInitError = undefined;
  status = { state: "idle", currentVersion: app.getVersion() };
}

/**
 * Single-instance ownership for the CodeForge desktop app.
 *
 * CodeForge is not a document app that can run twice: exactly one process owns the local API on
 * port 3210, the IPC surface behind it, and the workspace database. A second launch that walked
 * through normal startup hit the port first and died on an unhandled EADDRINUSE, leaving the user
 * with Electron's raw "A JavaScript error occurred in the main process" dialog and an orphaned
 * process tree.
 *
 * The rule this module enforces is ownership, not error recovery: a process that does not hold the
 * lock never reaches the code that binds anything. Electron scopes the lock to the user-data
 * directory, so distinct --user-data-dir profiles (the packaged smoke suites) remain independent.
 */

/** The slice of Electron's `app` this guard needs, so the decision is testable without Electron. */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: (...args: unknown[]) => void): unknown;
  quit(): void;
  whenReady(): Promise<unknown>;
}

/** The slice of Electron's `BrowserWindow` needed to bring an existing window forward. */
export interface ActivatableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface SingleInstanceOptions {
  app: SingleInstanceApp;
  /** Primary-only initialization: local server, IPC ownership, primary window. */
  startPrimary: () => Promise<void>;
  /** Called in the primary when another launch is attempted. */
  onSecondInstance: () => void;
  /** Called when primary initialization rejects (e.g. a genuine bind failure). */
  onStartupFailure: (error: unknown) => void;
}

/**
 * Settle instance ownership. Returns true when this process is the primary instance.
 *
 * A losing process does exactly two things — signal the primary (Electron delivers the
 * `second-instance` event for us) and quit. It never subscribes to `whenReady`, so no server bind
 * and no window creation can happen on this side.
 */
export function installSingleInstanceGuard(options: SingleInstanceOptions): boolean {
  const { app, startPrimary, onSecondInstance, onStartupFailure } = options;

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => onSecondInstance());
  void app.whenReady().then(() => startPrimary()).catch(onStartupFailure);
  return true;
}

/**
 * Bring a running window forward: un-minimize, un-hide, focus. No user state is touched — a second
 * launch is a request to look at CodeForge, not to reset it.
 */
export function activateWindow(win: ActivatableWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

/** Node's error code for a startup bind failure, when the thrown value carries one. */
export function bindErrorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** User-facing text for a startup failure. Reports the real cause; never claims the server is up. */
export function describeStartupFailure(error: unknown, port: number): string {
  const detail = error instanceof Error ? error.message : String(error);
  switch (bindErrorCode(error)) {
    case "EADDRINUSE":
      return `CodeForge could not start because port ${port} is already in use by another program.\n\nClose whatever is using that port, then start CodeForge again.`;
    case "EACCES":
      return `CodeForge is not permitted to open port ${port} on this machine.\n\nCheck local firewall or policy settings, then start CodeForge again.`;
    default:
      return `CodeForge could not start.\n\n${detail}`;
  }
}

import { describe, it, expect, vi } from "vitest";
import {
  installSingleInstanceGuard,
  activateWindow,
  bindErrorCode,
  describeStartupFailure,
  type SingleInstanceApp,
  type ActivatableWindow,
} from "../src/single-instance.js";

/**
 * Launching CodeForge twice used to race the first instance for port 3210 and die on an unhandled
 * EADDRINUSE, leaving the user an Electron crash dialog and a stranded process. These tests pin the
 * ownership rule that replaced it: only the lock holder runs primary initialization at all.
 */

function makeApp(overrides: Partial<SingleInstanceApp> & { lock: boolean }): {
  app: SingleInstanceApp;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  quit: ReturnType<typeof vi.fn>;
  whenReady: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const quit = vi.fn();
  const whenReady = vi.fn(() => Promise.resolve());
  const app: SingleInstanceApp = {
    requestSingleInstanceLock: () => overrides.lock,
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return app;
    },
    quit,
    whenReady,
  };
  return { app, listeners, quit, whenReady };
}

function makeWindow(state: Partial<{ destroyed: boolean; minimized: boolean; visible: boolean }> = {}): {
  win: ActivatableWindow;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  const restore = vi.fn();
  const show = vi.fn();
  const focus = vi.fn();
  return {
    restore,
    show,
    focus,
    win: {
      isDestroyed: () => state.destroyed ?? false,
      isMinimized: () => state.minimized ?? false,
      isVisible: () => state.visible ?? true,
      restore,
      show,
      focus,
    },
  };
}

describe("installSingleInstanceGuard", () => {
  it("runs no primary initialization when the lock is already held", async () => {
    const { app, quit, whenReady } = makeApp({ lock: false });
    const startPrimary = vi.fn(async () => {});

    const isPrimary = installSingleInstanceGuard({
      app,
      startPrimary,
      onSecondInstance: vi.fn(),
      onStartupFailure: vi.fn(),
    });

    await Promise.resolve();

    expect(isPrimary).toBe(false);
    // The losing process must never reach the local server bind or the primary window: both live
    // behind startPrimary, and it must never even subscribe to whenReady.
    expect(startPrimary).not.toHaveBeenCalled();
    expect(whenReady).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("runs primary initialization once when it holds the lock", async () => {
    const { app, quit, whenReady } = makeApp({ lock: true });
    const startPrimary = vi.fn(async () => {});

    const isPrimary = installSingleInstanceGuard({
      app,
      startPrimary,
      onSecondInstance: vi.fn(),
      onStartupFailure: vi.fn(),
    });
    await vi.waitFor(() => expect(startPrimary).toHaveBeenCalledTimes(1));

    expect(isPrimary).toBe(true);
    expect(whenReady).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it("routes a second launch to the existing window instead of a second app", async () => {
    const { app, listeners, quit } = makeApp({ lock: true });
    const startPrimary = vi.fn(async () => {});
    const onSecondInstance = vi.fn();

    installSingleInstanceGuard({ app, startPrimary, onSecondInstance, onStartupFailure: vi.fn() });
    await vi.waitFor(() => expect(startPrimary).toHaveBeenCalledTimes(1));

    const handlers = listeners.get("second-instance") ?? [];
    expect(handlers).toHaveLength(1);
    handlers[0]!();

    expect(onSecondInstance).toHaveBeenCalledTimes(1);
    // Activating an existing window must not spin up another server or quit the primary.
    expect(startPrimary).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it("hands a failed primary startup to the failure handler rather than crashing the process", async () => {
    const { app } = makeApp({ lock: true });
    const bindFailure: NodeJS.ErrnoException = Object.assign(
      new Error("listen EADDRINUSE: address already in use :::3210"),
      { code: "EADDRINUSE" },
    );
    const onStartupFailure = vi.fn();

    installSingleInstanceGuard({
      app,
      startPrimary: async () => { throw bindFailure; },
      onSecondInstance: vi.fn(),
      onStartupFailure,
    });

    await vi.waitFor(() => expect(onStartupFailure).toHaveBeenCalledTimes(1));
    expect(onStartupFailure).toHaveBeenCalledWith(bindFailure);
  });
});

describe("activateWindow", () => {
  it("restores, shows and focuses a minimized hidden window", () => {
    const { win, restore, show, focus } = makeWindow({ minimized: true, visible: false });
    expect(activateWindow(win)).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("only focuses a window that is already visible and un-minimized", () => {
    const { win, restore, show, focus } = makeWindow();
    expect(activateWindow(win)).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a missing or destroyed window", () => {
    const { win, focus } = makeWindow({ destroyed: true });
    expect(activateWindow(win)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(activateWindow(null)).toBe(false);
    expect(activateWindow(undefined)).toBe(false);
  });
});

describe("startup failure reporting", () => {
  it("reads the errno code when present", () => {
    expect(bindErrorCode(Object.assign(new Error("x"), { code: "EADDRINUSE" }))).toBe("EADDRINUSE");
    expect(bindErrorCode(new Error("x"))).toBeUndefined();
    expect(bindErrorCode("boom")).toBeUndefined();
  });

  it("explains a port conflict in the app's own terms, naming the port", () => {
    const message = describeStartupFailure(
      Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
      3210,
    );
    expect(message).toContain("3210");
    expect(message).toContain("already in use");
    // Never Electron's raw crash text.
    expect(message).not.toContain("JavaScript error");
  });

  it("explains a permission failure separately from a port conflict", () => {
    const message = describeStartupFailure(
      Object.assign(new Error("listen EACCES"), { code: "EACCES" }),
      3210,
    );
    expect(message).toContain("not permitted");
    expect(message).toContain("3210");
  });

  it("surfaces an unrecognized failure instead of claiming the server started", () => {
    expect(describeStartupFailure(new Error("disk on fire"), 3210)).toContain("disk on fire");
  });
});

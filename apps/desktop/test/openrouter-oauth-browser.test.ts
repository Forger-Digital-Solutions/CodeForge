import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const launcher = vi.hoisted(() => ({ spawn: vi.fn(), openExternal: vi.fn(), exists: vi.fn() }));
vi.mock("electron", () => ({ shell: { openExternal: launcher.openExternal } }));
vi.mock("node:fs", () => ({ existsSync: launcher.exists }));
vi.mock("node:child_process", () => ({ spawn: launcher.spawn }));

import { installedFirefoxPath, runOpenRouterOAuth } from "../src/openrouter-oauth-flow.js";

afterEach(() => { vi.clearAllMocks(); });

describe("OpenRouter authorization browser choice", () => {
  it("opens Firefox directly and preserves the same one-use PKCE callback", async () => {
    launcher.exists.mockReturnValue(true);
    launcher.spawn.mockImplementation((_executable: string, args: string[], options: { shell?: boolean }) => {
      expect(options.shell).toBeUndefined();
      const authorization = new URL(args[1]!);
      expect(authorization.origin).toBe("https://openrouter.ai");
      expect(authorization.searchParams.has("code_verifier")).toBe(false);
      const callback = new URL(authorization.searchParams.get("callback_url")!);
      callback.searchParams.set("code", "fixture-authorization-code");
      const state = new URL(authorization.searchParams.get("callback_url")!).searchParams.get("state") ?? authorization.searchParams.get("state");
      if (state) callback.searchParams.set("state", state);
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => { child.emit("spawn"); void fetch(callback); });
      return child;
    });
    const exchange = vi.fn(async ({ code, codeVerifier }: { code: string; codeVerifier: string }) => {
      expect(code).toBe("fixture-authorization-code");
      expect(codeVerifier.length).toBeGreaterThan(30);
      return "fixture-user-owned-key";
    });
    expect(await runOpenRouterOAuth({ browser: "firefox", exchange, timeoutMs: 2_000 })).toBe("fixture-user-owned-key");
    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(launcher.openExternal).not.toHaveBeenCalled();
  });

  it("does not silently switch account sessions through the default browser when Firefox is absent", async () => {
    launcher.exists.mockReturnValue(false);
    await expect(runOpenRouterOAuth({ browser: "firefox", timeoutMs: 2_000 })).rejects.toThrow("Firefox is not installed");
    expect(launcher.openExternal).not.toHaveBeenCalled();
    expect(launcher.spawn).not.toHaveBeenCalled();
    expect(installedFirefoxPath({ ProgramFiles: "relative-untrusted-path" }, () => true)).toBeUndefined();
  });
});

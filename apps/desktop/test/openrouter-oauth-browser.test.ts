import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const launcher = vi.hoisted(() => ({ spawn: vi.fn(), openExternal: vi.fn(), exists: vi.fn() }));
vi.mock("electron", () => ({ shell: { openExternal: launcher.openExternal } }));
vi.mock("node:fs", () => ({ existsSync: launcher.exists }));
vi.mock("node:child_process", () => ({ spawn: launcher.spawn }));

import { installedFirefoxPath, runOpenRouterOAuth } from "../src/openrouter-oauth-flow.js";

afterEach(() => { vi.clearAllMocks(); });

describe("OpenRouter authorization browser choice", () => {
  it("rejects forged callbacks without cancelling the user's valid authorization", async () => {
    const exchange = vi.fn(async () => "fixture-user-owned-key");
    const key = await runOpenRouterOAuth({ exchange, timeoutMs: 2_000, openExternal: async address => {
      const authorization = new URL(address);
      const callback = new URL(authorization.searchParams.get("callback_url")!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      const forged = new URL(callback);
      forged.searchParams.set("state", "wrong-state");
      expect((await fetch(forged)).status).toBe(400);
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    } });
    expect(key).toBe("fixture-user-owned-key");
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("bounds an exchange that stalls after the one-use callback", async () => {
    await expect(runOpenRouterOAuth({ timeoutMs: 100, exchange: () => new Promise(() => {}), openExternal: async address => {
      const authorization = new URL(address);
      const callback = new URL(authorization.searchParams.get("callback_url")!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      expect((await fetch(callback)).status).toBe(200);
      expect((await fetch(callback)).status).toBe(409);
    } })).rejects.toThrow("OpenRouter authorization timed out");
  });

  it("opens Firefox directly and preserves the same one-use PKCE callback", async () => {
    launcher.exists.mockReturnValue(true);
    launcher.spawn.mockImplementation((_executable: string, args: string[], options: { shell?: boolean }) => {
      expect(options.shell).toBeUndefined();
      const authorization = new URL(args[1]!);
      expect(authorization.origin).toBe("https://openrouter.ai");
      expect(authorization.searchParams.has("code_verifier")).toBe(false);
      const callback = new URL(authorization.searchParams.get("callback_url")!);
      callback.searchParams.set("code", "fixture-authorization-code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
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

  it("handles explicit provider consent denial without exchanging a credential", async () => {
    const exchange = vi.fn(async () => "must-not-be-created");
    await expect(runOpenRouterOAuth({ exchange, timeoutMs: 2_000, openExternal: async address => {
      const authorization = new URL(address);
      const callback = new URL(authorization.searchParams.get("callback_url")!);
      callback.searchParams.set("error", "access_denied");
      expect((await fetch(callback)).status).toBe(200);
    } })).rejects.toThrow("OpenRouter authorization was denied");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("does not silently switch account sessions through the default browser when Firefox is absent", async () => {
    launcher.exists.mockReturnValue(false);
    await expect(runOpenRouterOAuth({ browser: "firefox", timeoutMs: 2_000 })).rejects.toThrow("Firefox is not installed");
    expect(launcher.openExternal).not.toHaveBeenCalled();
    expect(launcher.spawn).not.toHaveBeenCalled();
    expect(installedFirefoxPath({ ProgramFiles: "relative-untrusted-path" }, () => true)).toBeUndefined();
  });
});

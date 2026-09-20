import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_TOOL_DEFINITIONS,
  createBrowserToolExecutor,
  GovernedBrowserRuntime,
  isBrowserTool,
} from "../src/index.js";

let server: http.Server;
let baseUrl: string;
let downloadDir: string;
let runtime: GovernedBrowserRuntime;
let executor: (name: string, args: Record<string, unknown>) => Promise<string | undefined>;

beforeAll(async () => {
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dl-tools-"));
  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<html><body><h1>ok</h1><button data-testid="b">B</button><p>Token-looking text: ghp_${"Z".repeat(40)}</p></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
  runtime = new GovernedBrowserRuntime({ downloadDir, headless: true });
  executor = createBrowserToolExecutor(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(downloadDir, { recursive: true, force: true });
});

describe("browser tool surface", () => {
  it("declares all tools with network permission and network execution class", () => {
    const names = BROWSER_TOOL_DEFINITIONS.map((d) => d.name).sort();
    expect(names).toEqual([
      "browser_click",
      "browser_close",
      "browser_inspect",
      "browser_launch",
      "browser_navigate",
      "browser_screenshot",
      "browser_select",
      "browser_state",
      "browser_submit",
      "browser_type",
      "browser_wait",
    ]);
    for (const def of BROWSER_TOOL_DEFINITIONS) {
      expect(def.requiredPermission).toBe("network");
      expect(def.executionClass).toBe("network");
    }
    // Read-only surface is inspectable by read-only roles; interactions are mutating.
    const readOnly = BROWSER_TOOL_DEFINITIONS.filter((d) => d.readOnly).map((d) => d.name);
    expect(readOnly.sort()).toEqual([
      "browser_inspect",
      "browser_navigate",
      "browser_screenshot",
      "browser_state",
      "browser_wait",
    ]);
    expect(isBrowserTool("browser_click")).toBe(true);
    expect(isBrowserTool("read_file")).toBe(false);
  });

  it("passes through non-browser tools", async () => {
    expect(await executor("read_file", { path: "x" })).toBeUndefined();
    expect(await executor("mcp__x__y", {})).toBeUndefined();
  });

  it("drives a full launch → navigate → inspect → close flow with untrusted wrapping", async () => {
    const launched = await executor("browser_launch", {});
    expect(launched).toContain("UNTRUSTED_DATA");
    const sessionId = JSON.parse(strip(launched!)).sessionId as string;
    expect(sessionId).toMatch(/^browser-/);

    const nav = await executor("browser_navigate", { url: `${baseUrl}/`, sessionId });
    expect(nav).toContain("UNTRUSTED_DATA");
    expect(JSON.parse(strip(nav!)).url).toBe(`${baseUrl}/`);

    const inspected = await executor("browser_inspect", { sessionId });
    const parsed = JSON.parse(strip(inspected!));
    expect(parsed.snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    // Model-facing output must not carry raw secrets even when the page displays one.
    expect(inspected).not.toContain("ghp_");

    const closed = await executor("browser_close", { sessionId });
    expect(closed).toContain("browser-");
  });

  it("rejects navigation policy denials with BROWSER_NAVIGATION_DENIED", async () => {
    const launched = await executor("browser_launch", {});
    const sessionId = JSON.parse(strip(launched!)).sessionId as string;
    await expect(executor("browser_navigate", { url: "file:///etc/passwd", sessionId })).rejects.toMatchObject({
      code: "BROWSER_NAVIGATION_DENIED",
    });
    await expect(executor("browser_navigate", { url: "http://169.254.169.254/", sessionId })).rejects.toMatchObject({
      code: "BROWSER_NAVIGATION_DENIED",
    });
    await executor("browser_close", { sessionId });
  });

  it("requires a session and rejects bad targets", async () => {
    await expect(executor("browser_inspect", {})).rejects.toMatchObject({ code: "BROWSER_SESSION_NOT_FOUND" });
    const launched = await executor("browser_launch", {});
    const sessionId = JSON.parse(strip(launched!)).sessionId as string;
    await executor("browser_navigate", { url: `${baseUrl}/`, sessionId });
    await expect(executor("browser_click", { sessionId, target: {} })).rejects.toMatchObject({
      code: "BROWSER_ARGUMENT_INVALID",
    });
    await expect(executor("browser_click", { sessionId, target: { selector: "#nope" } })).rejects.toMatchObject({
      code: "BROWSER_TARGET_NOT_FOUND",
    });
    await executor("browser_close", { sessionId });
  });
});

function strip(wrapped: string): string {
  const match = /<<<UNTRUSTED_DATA[^>]*>>>\n([\s\S]*?)\n<<<END_UNTRUSTED_DATA>>>/.exec(wrapped);
  return match ? match[1]! : wrapped;
}

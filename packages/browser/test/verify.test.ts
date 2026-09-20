import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GovernedBrowserRuntime, runBrowserVerification, verificationResultToText, verifyCliPath } from "../src/index.js";

/**
 * ForgeVerify browser verification (M9): the verifier launches a *fresh* governed session
 * against a loopback fixture and emits a digested verdict. Assertions cover pass, fail, and
 * fail-closed (policy-denied) outcomes plus evidence-hashable output shape.
 */

let server: http.Server;
let baseUrl: string;
let scratch: string;
let runtime: GovernedBrowserRuntime;

const PASS_PAGE = `<!doctype html><html><head><title>Deploy OK</title></head><body>
<h1>Deployment succeeded</h1><div id="status-banner">healthy</div></body></html>`;

const FAIL_PAGE = `<!doctype html><html><head><title>Error</title></head><body>
<h1>Something else entirely</h1></body></html>`;

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cf-verify-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "text/html");
    res.end(url.pathname === "/fail" ? FAIL_PAGE : PASS_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  runtime = new GovernedBrowserRuntime({
    downloadDir: path.join(scratch, "dl"),
    screenshotDir: path.join(scratch, "shots"),
    headless: true,
  });
});

afterAll(async () => {
  await runtime.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("ForgeVerify browser verification", () => {
  it("passes when all expectations hold and emits digested evidence fields", async () => {
    const result = await runBrowserVerification(runtime, {
      url: `${baseUrl}/`,
      expectTitlePattern: "Deploy OK",
      expectSelector: "#status-banner",
      expectText: "Deployment succeeded",
      screenshot: true,
    });
    expect(result.pass).toBe(true);
    expect(result.finalUrl).toContain(baseUrl);
    expect(result.title).toBe("Deploy OK");
    expect(result.domHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.screenshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    const text = verificationResultToText(result);
    expect(text).toContain("PASSED");
    expect(text).toContain(result.domHash);
  });

  it("fails when expectations do not hold, with per-check detail", async () => {
    const result = await runBrowserVerification(runtime, {
      url: `${baseUrl}/fail`,
      expectTitlePattern: "Deploy OK",
      expectText: "Deployment succeeded",
    });
    expect(result.pass).toBe(false);
    const titleCheck = result.checks.find((c) => c.name === "expectTitle");
    const textCheck = result.checks.find((c) => c.name === "expectText");
    expect(titleCheck?.pass).toBe(false);
    expect(textCheck?.pass).toBe(false);
    expect(verificationResultToText(result)).toContain("FAILED");
  });

  it("fails closed when the target violates URL policy (metadata endpoint)", async () => {
    await expect(
      runBrowserVerification(runtime, { url: "http://169.254.169.254/latest/meta-data", expectText: "x" }),
    ).rejects.toMatchObject({ code: expect.stringContaining("NAVIGATION_DENIED") });
  });

  it("produces identical domHash for identical page state across independent sessions", async () => {
    const a = await runBrowserVerification(runtime, { url: `${baseUrl}/` });
    const b = await runBrowserVerification(runtime, { url: `${baseUrl}/` });
    expect(a.domHash).toBe(b.domHash);
  });

  it("verifyCliPath resolves inside the package dist tree", () => {
    const p = verifyCliPath();
    expect(p).toMatch(/verify-cli\.js$/);
    // The CLI compiles with the package build; when dist is present it must exist on disk.
    if (fs.existsSync(path.dirname(p))) {
      expect(fs.existsSync(p)).toBe(true);
    }
  });
});

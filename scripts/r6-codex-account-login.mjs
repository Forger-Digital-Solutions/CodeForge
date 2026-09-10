import { spawn } from "node:child_process";
import {
  CodexAccountAdapter,
  CodexAppServerProcess,
} from "../packages/providers/dist/index.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;

function isAllowedAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "openai.com"
        || url.hostname.endsWith(".openai.com")
        || url.hostname === "chatgpt.com"
        || url.hostname.endsWith(".chatgpt.com"));
  } catch {
    return false;
  }
}

function openInDefaultBrowser(url) {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $args[0]", url],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transport = new CodexAppServerProcess({
  cwd: process.cwd(),
  onStderr: () => undefined,
});
const adapter = new CodexAccountAdapter({ transport });
let loginId;

try {
  const existing = await adapter.readAccount();
  if (existing) {
    const limits = await adapter.readRateLimits();
    console.log(JSON.stringify({
      authenticated: true,
      existingSession: true,
      authMode: existing.authMode,
      planType: existing.planType ?? null,
      allowanceState: adapter.routeState,
      rateLimitWindows: limits.length,
    }, null, 2));
    process.exitCode = 0;
  } else {
    const login = await adapter.startLogin();
    loginId = login.loginId;
    const authUrl = login.authUrl ?? login.verificationUrl;
    if (!authUrl || !isAllowedAuthUrl(authUrl)) {
      throw new Error("Codex returned no trusted OpenAI authentication URL");
    }

    openInDefaultBrowser(authUrl);
    console.log("CODEFORGE_CODEX_AUTH_BROWSER_OPENED");
    console.log("Complete the OpenAI authorization in the browser; CodeForge is waiting for the official app-server callback.");

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let account = null;
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      account = await adapter.readAccount();
      if (account) break;
    }
    if (!account) throw new Error("Timed out waiting for Codex account authorization");

    const limits = await adapter.readRateLimits();
    console.log(JSON.stringify({
      authenticated: true,
      existingSession: false,
      authMode: account.authMode,
      planType: account.planType ?? null,
      allowanceState: adapter.routeState,
      rateLimitWindows: limits.length,
    }, null, 2));
    process.exitCode = 0;
  }
} catch (error) {
  if (loginId) {
    try {
      await adapter.cancelLogin(loginId);
    } catch {
      // Best-effort cleanup of the app-server login attempt.
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CODEFORGE_CODEX_AUTH_FAILED: ${message}`);
  process.exitCode = 1;
} finally {
  await transport.close();
}

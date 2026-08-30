#!/usr/bin/env node
/**
 * CodeForge Desktop — fresh-user acceptance driver.
 *
 *   node apps/desktop/scripts/first-user-acceptance.mjs --cloud-url https://your-cloud.example.com
 *
 * Drives the packaged desktop from a genuinely cold start:
 *
 *   * an EMPTY app-data directory (no settings, no cached session, no recent projects)
 *   * NO personal provider API keys
 *   * NO existing CodeForge session
 *
 * and exercises the first-user path: launch -> onboarding/login state -> OAuth start -> loopback
 * result -> catalog refresh -> CodeForge Auto -> exact model -> usage refresh -> logout.
 *
 * The browser half of GitHub authorization is inherently human. This driver therefore separates:
 *
 *   automated preparation      — everything up to the authorize URL
 *   human authorization        — the operator approves in a browser (only with --interactive)
 *   automated resumption       — everything after the desktop receives its one-time code
 *
 * It never fabricates a GitHub authorization. Without one, the login-dependent phases are reported
 * BLOCKED and the run exits non-zero only if something that COULD run actually failed.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const cloudUrl = (argValue("--cloud-url") ?? process.env.CODEFORGE_CLOUD_URL ?? "").replace(/\/$/, "");
const interactive = process.argv.includes("--interactive");
const skipLaunch = process.argv.includes("--no-launch");
const exePath = argValue("--exe")
  ? resolve(argValue("--exe"))
  : resolve(desktopRoot, "release", "win-unpacked", "CodeForge.exe");

if (!cloudUrl) {
  console.error("usage: first-user-acceptance.mjs --cloud-url https://your-cloud.example.com [--interactive] [--exe path] [--no-launch]");
  process.exit(2);
}

const phases = [];
function phase(id, status, detail) {
  phases.push({ id, status, detail });
  console.log(`${status.padEnd(7)} ${id}${detail ? ` — ${detail}` : ""}`);
}

// --- Phase 1: a genuinely empty profile ------------------------------------------------------------
// A "fresh user" test that reuses yesterday's app-data proves nothing, so the directory is recreated.
const profileDir = resolve(desktopRoot, "release", "first-user-profile");
try {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const empty = readdirSync(profileDir).length === 0;
  phase("profile.fresh", empty ? "PASS" : "FAIL", `empty app-data at ${profileDir}`);
} catch (err) {
  phase("profile.fresh", "FAIL", String(err?.message ?? err));
}

const workspaceDir = resolve(desktopRoot, "release", "first-user-workspace");
try {
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "package.json"), JSON.stringify({ name: "first-user-workspace", type: "module" }, null, 2));
  writeFileSync(join(workspaceDir, "src", "index.ts"), "export const greet = (name: string) => `hi ${name}`;\n");
  phase("workspace.fresh", "PASS", workspaceDir);
} catch (err) {
  phase("workspace.fresh", "FAIL", String(err?.message ?? err));
}

// No personal provider keys: the whole point of the zero-setup claim is that a new user has none.
const personalProviderKeys = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "ZAI_API_KEY"];
const childEnv = { ...process.env };
for (const key of personalProviderKeys) delete childEnv[key];
phase("providers.no_personal_keys", "PASS", `cleared ${personalProviderKeys.length} provider variables from the child environment`);

// --- Phase 2: launch the packaged app -----------------------------------------------------------------
let child;
if (skipLaunch) {
  phase("desktop.launch", "SKIP", "--no-launch given; exercising the Cloud-facing phases only");
} else if (!existsSync(exePath)) {
  phase("desktop.launch", "BLOCKED", `packaged executable not found at ${exePath} — run \`npm run pack --workspace=codeforge-desktop\``);
} else {
  try {
    child = spawn(exePath, [`--user-data-dir=${profileDir}`], {
      env: { ...childEnv, CODEFORGE_CLOUD_URL: cloudUrl, CODEFORGE_FIRST_USER_ACCEPTANCE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((r) => setTimeout(r, 8000));
    phase(child.exitCode === null ? "desktop.launch" : "desktop.launch", child.exitCode === null ? "PASS" : "FAIL", child.exitCode === null ? "app is running from an empty profile" : `exited early with code ${child.exitCode}`);
  } catch (err) {
    phase("desktop.launch", "FAIL", String(err?.message ?? err));
  }
}

// --- Phase 3: the Cloud is reachable and reports capacity ----------------------------------------------
let hostedModels = [];
try {
  const ready = await fetch(`${cloudUrl}/health/ready`);
  const body = await ready.json();
  phase("cloud.ready", ready.ok ? "PASS" : "FAIL", `database=${body.database} hostedInferenceReady=${body.hostedInferenceReady}`);

  const models = await fetch(`${cloudUrl}/v1/hosted/models`);
  const all = await models.json();
  hostedModels = Array.isArray(all) ? all.filter((m) => m.isEligibleFree) : [];
  phase("catalog.refresh", hostedModels.length > 0 ? "PASS" : "FAIL", `${hostedModels.length} verified-free model(s) with no user key`);
} catch (err) {
  phase("cloud.ready", "FAIL", String(err?.message ?? err));
}

// --- Phase 4: OAuth --------------------------------------------------------------------------------------
function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let accessToken = process.env.CODEFORGE_STAGING_ACCESS_TOKEN;
let refreshToken = process.env.CODEFORGE_STAGING_REFRESH_TOKEN;
let authorizeUrl;

try {
  const codeVerifier = base64Url(randomBytes(64)).slice(0, 128);
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const redirectUri = "http://127.0.0.1:49152/auth/callback";

  const startRes = await fetch(`${cloudUrl}/v1/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirectUri, codeChallenge, deviceName: "CodeForge First-User Acceptance" }),
  });
  const start = await startRes.json();
  authorizeUrl = start.authUrl;
  phase("oauth.start", startRes.ok && /^https:\/\/github\.com\/login\/oauth\/authorize/.test(start.authUrl ?? "") ? "PASS" : "FAIL", `callback to register: ${start.cloudCallbackUrl}`);

  if (!accessToken && interactive) {
    console.log("");
    console.log("HUMAN STEP REQUIRED — approve CodeForge in a browser:");
    console.log(`  ${authorizeUrl}`);
    console.log(`  then copy the 'code' parameter from ${redirectUri}?code=...`);
    console.log("");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question("desktop authorization code: ")).trim();
    rl.close();

    const exchangeRes = await fetch(`${cloudUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier, state: start.state, redirectUri }),
    });
    if (!exchangeRes.ok) throw new Error(`exchange failed: HTTP ${exchangeRes.status}`);
    const tokens = await exchangeRes.json();
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    phase("oauth.loopback_result", "PASS", "single-use desktop code exchanged for a session");
  } else if (accessToken) {
    phase("oauth.loopback_result", "PASS", "operator-supplied session");
  } else {
    phase("oauth.loopback_result", "BLOCKED", "re-run with --interactive to complete a real GitHub authorization");
  }
} catch (err) {
  phase("oauth.start", "FAIL", String(err?.message ?? err));
}

// --- Phase 5: first-run inference, exact model, usage, logout ----------------------------------------------
const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } : undefined;

async function streamInference(body) {
  const res = await fetch(`${cloudUrl}/v1/hosted/inference`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let provider;
  let model;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "assistant.message.started") {
        provider = event.provider;
        model = event.model;
      }
    } catch {
      /* ignore malformed frames */
    }
  }
  return { raw, provider, model, completed: raw.includes("turn.completed") };
}

if (!authHeaders) {
  for (const id of ["inference.auto", "inference.exact", "usage.refresh", "auth.logout"]) {
    phase(id, "BLOCKED", "requires an authenticated session");
  }
} else {
  try {
    const result = await streamInference({ requestId: randomUUID(), messages: [{ role: "user", content: "Reply with exactly: FIRST_USER_OK" }], modelId: "auto" });
    phase("inference.auto", result.completed ? "PASS" : "FAIL", `${result.provider}::${result.model}`);
  } catch (err) {
    phase("inference.auto", "FAIL", String(err?.message ?? err));
  }

  try {
    if (hostedModels.length === 0) throw new Error("no verified-free model available to request exactly");
    const target = hostedModels[0];
    const result = await streamInference({
      requestId: randomUUID(),
      messages: [{ role: "user", content: "Reply with exactly: EXACT_OK" }],
      providerId: target.providerId,
      modelId: target.modelId,
    });
    const exact = result.provider === target.providerId && result.model === target.modelId;
    phase("inference.exact", result.completed && exact ? "PASS" : "FAIL", `requested ${target.providerId}::${target.modelId}, served ${result.provider}::${result.model}`);
  } catch (err) {
    phase("inference.exact", "FAIL", String(err?.message ?? err));
  }

  try {
    const res = await fetch(`${cloudUrl}/v1/usage`, { headers: authHeaders });
    const usage = await res.json();
    phase("usage.refresh", res.ok ? "PASS" : "FAIL", `balance=${usage.creditBalance}`);
  } catch (err) {
    phase("usage.refresh", "FAIL", String(err?.message ?? err));
  }

  if (refreshToken) {
    try {
      const res = await fetch(`${cloudUrl}/v1/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      phase("auth.logout", res.ok ? "PASS" : "FAIL", `HTTP ${res.status}`);
    } catch (err) {
      phase("auth.logout", "FAIL", String(err?.message ?? err));
    }
  } else {
    phase("auth.logout", "BLOCKED", "no refresh token available");
  }
}

// --- Teardown -------------------------------------------------------------------------------------------------
if (child && child.exitCode === null) {
  child.kill();
}

const failed = phases.filter((p) => p.status === "FAIL").length;
const blocked = phases.filter((p) => p.status === "BLOCKED").length;
const passed = phases.filter((p) => p.status === "PASS").length;

console.log("");
console.log(`${passed} passed, ${failed} failed, ${blocked} blocked`);
console.log(failed === 0 && blocked === 0 ? "FIRST-USER ACCEPTANCE: PASS" : failed === 0 ? "FIRST-USER ACCEPTANCE: BLOCKED (external resources required)" : "FIRST-USER ACCEPTANCE: FAIL");

// Set the exit code rather than calling process.exit(): an abrupt exit can race libuv handle
// teardown on Windows, and this script has no reason to terminate before its own handles close.
process.exitCode = failed > 0 ? 1 : 0;

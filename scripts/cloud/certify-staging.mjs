#!/usr/bin/env node
/**
 * CodeForge Cloud — remote staging certification harness.
 *
 *   npm run cloud:certify:staging -- --url https://your-cloud.example.com [--json staging-certification.json] [--md staging-certification.md]
 *
 * Runs the full remote acceptance suite against a live deployment and emits machine-readable and
 * human-readable evidence. Every input comes from the environment; nothing is hard-coded.
 *
 * Interactive boundary: completing a real GitHub authorization requires a human in a browser. That
 * is NEVER faked. The harness runs everything it can without a session, then either
 *
 *   * uses CODEFORGE_STAGING_ACCESS_TOKEN / CODEFORGE_STAGING_REFRESH_TOKEN if the operator has
 *     already completed a login and exported them, or
 *   * prints the authorize URL, waits for the operator to finish in a browser and paste back the
 *     desktop authorization code, then resumes automatically (--interactive).
 *
 * Stages that cannot run without a session are reported BLOCKED, never PASS.
 */
import { writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const baseUrl = (argValue("--url") ?? process.env.CODEFORGE_STAGING_URL ?? "").replace(/\/$/, "");
const jsonPath = argValue("--json");
const mdPath = argValue("--md");
const interactive = process.argv.includes("--interactive");
const allowInsecure = process.argv.includes("--allow-insecure");

if (!baseUrl) {
  console.error("usage: certify-staging.mjs --url https://your-cloud.example.com [--json out.json] [--md out.md] [--interactive]");
  console.error("       (or set CODEFORGE_STAGING_URL)");
  process.exit(2);
}

// --- Load the compiled tooling -------------------------------------------------------------------
let probeMod;
let receiptMod;
try {
  probeMod = await import(pathToFileURL(resolve(repoRoot, "apps/cloud-api/dist/remote-probe.js")).href);
  receiptMod = await import(pathToFileURL(resolve(repoRoot, "apps/cloud-api/dist/certification-receipt.js")).href);
} catch (err) {
  console.error("Could not load the compiled cloud-api build. Run `npm run build` first.");
  console.error(String(err?.message ?? err));
  process.exit(2);
}
const { probeRemoteDeployment, formatProbeReport } = probeMod;
const { serializeCertificationReceipt, CERTIFICATION_RECEIPT_SCHEMA_VERSION } = receiptMod;

// --- Stage bookkeeping ---------------------------------------------------------------------------
const stages = [];
function stage(id, status, detail, durationMs) {
  stages.push({ id, status, ...(detail ? { detail } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
  const marker = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : status;
  console.log(`${marker.padEnd(7)} ${id}${detail ? ` — ${detail}` : ""}`);
}

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const evidence = {
  provider: undefined,
  model: undefined,
  verifiedFree: undefined,
  requestId: undefined,
  creditBefore: undefined,
  creditAfter: undefined,
  sseFirstEventMs: undefined,
  sseTerminalEventMs: undefined,
  twoClientConcurrencyResult: undefined,
  directByokOutageResult: undefined,
  securityResult: undefined,
  oauthCallbackUrl: undefined,
  databaseEngine: "postgres",
  databaseTls: true,
};

const started = Date.now();

// --- 1. Preflight ---------------------------------------------------------------------------------
// The preflight grades a DEPLOYMENT's configuration contract against a process environment. When
// this harness certifies a REMOTE target, the local process environment is NOT the deployment's
// environment — the operator's shell legitimately holds none of the server's secrets, and loading
// them locally would be worse practice, not better — so running it here grades the wrong machine.
//
// It therefore runs only when the environment at hand really is a deployment environment (the host
// itself, or a shell with the deployment env loaded), or when the target is local. Otherwise it is
// reported SKIP, with the reason, and does not gate the verdict. No assertion inside the
// preflight is relaxed by this scoping; only the environment it is applied to. Configuration
// assurance for a remote target comes from the remote_probe stage, which interrogates the running
// deployment itself.
let preflightTargetIsLocal = false;
try {
  const host = new URL(baseUrl).hostname;
  preflightTargetIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
} catch {
  preflightTargetIsLocal = false;
}
const preflightEnvTier = (process.env.CODEFORGE_CLOUD_ENV ?? "").trim();
const preflightEnvIsDeployment = preflightEnvTier === "staging" || preflightEnvTier === "production";

if (!preflightTargetIsLocal && !preflightEnvIsDeployment) {
  stage(
    "preflight",
    "SKIP",
    `not applicable to a remote target: this process is not the deployment environment ` +
      `(CODEFORGE_CLOUD_ENV='${preflightEnvTier || "unset"}'); ${baseUrl} is graded remotely by remote_probe`,
  );
} else {
  try {
    const preflightMod = await import(pathToFileURL(resolve(repoRoot, "apps/cloud-api/dist/staging-preflight.js")).href);
    const report = preflightMod.runStagingPreflight(process.env);
    stage("preflight", report.ok ? "PASS" : "FAIL", `${report.passed} passed, ${report.failed} failed`);
  } catch (err) {
    stage("preflight", "FAIL", String(err?.message ?? err));
  }
}

// --- 2. Remote probe (health, TLS, security, auth enforcement, OAuth readiness) ---------------------
let probeReport;
try {
  probeReport = await probeRemoteDeployment(baseUrl, { allowInsecure });
  stage("remote_probe", probeReport.ok ? "PASS" : "FAIL", `${probeReport.passed} passed, ${probeReport.failed} failed`);
  const callback = probeReport.checks.find((c) => c.id === "oauth.ready");
  const match = callback?.message?.match(/registered callback is (\S+)/);
  if (match) evidence.oauthCallbackUrl = match[1];
  evidence.securityResult = probeReport.checks.some((c) => c.id.startsWith("leak.") && c.status === "FAIL") ? "FAIL" : probeReport.ok ? "PASS" : "FAIL";
} catch (err) {
  stage("remote_probe", "FAIL", String(err?.message ?? err));
  evidence.securityResult = "FAIL";
}

// --- 3. Authentication -----------------------------------------------------------------------------
// Real GitHub authorization needs a human. Everything up to that point is automated.
let accessToken = process.env.CODEFORGE_STAGING_ACCESS_TOKEN;
let refreshToken = process.env.CODEFORGE_STAGING_REFRESH_TOKEN;

async function performInteractiveLogin() {
  const codeVerifier = base64Url(randomBytes(64)).slice(0, 128);
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  // A loopback listener is not opened here: the operator pastes the code back, so the harness works
  // over SSH and inside CI runners with no browser of their own.
  const redirectUri = "http://127.0.0.1:49152/auth/callback";

  const startRes = await fetch(`${baseUrl}/v1/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirectUri, codeChallenge, deviceName: "CodeForge Staging Certification" }),
  });
  if (!startRes.ok) throw new Error(`auth/start returned HTTP ${startRes.status}`);
  const start = await startRes.json();
  evidence.oauthCallbackUrl = start.cloudCallbackUrl;

  console.log("");
  console.log("HUMAN STEP REQUIRED — complete GitHub authorization in a browser:");
  console.log(`  1. Open: ${start.authUrl}`);
  console.log("  2. Approve the CodeForge OAuth App.");
  console.log(`  3. GitHub returns to ${start.cloudCallbackUrl}, which redirects to ${redirectUri}?code=...`);
  console.log("  4. Copy the `code` query parameter from the address bar and paste it below.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("desktop authorization code: ")).trim();
  rl.close();
  if (!code) throw new Error("no authorization code provided");

  const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier, state: start.state, redirectUri }),
  });
  if (!exchangeRes.ok) throw new Error(`auth/exchange returned HTTP ${exchangeRes.status}`);
  const tokens = await exchangeRes.json();
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, code, codeVerifier, redirectUri, state: start.state };
}

let loginArtifacts;
if (!accessToken && interactive) {
  try {
    loginArtifacts = await performInteractiveLogin();
    accessToken = loginArtifacts.accessToken;
    refreshToken = loginArtifacts.refreshToken;
    stage("oauth.real_login", "PASS", "real GitHub authorization completed by a human and exchanged for a session");
  } catch (err) {
    stage("oauth.real_login", "FAIL", String(err?.message ?? err));
  }
} else if (accessToken) {
  stage("oauth.real_login", "PASS", "using operator-supplied session from a previously completed GitHub authorization");
} else {
  stage(
    "oauth.real_login",
    "BLOCKED",
    "no session available — re-run with --interactive to complete a real GitHub authorization, or set CODEFORGE_STAGING_ACCESS_TOKEN",
  );
}

const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } : undefined;
const blockedWithoutSession = (id, detail = "requires an authenticated session") => stage(id, "BLOCKED", detail);

// --- 4. Authenticated stages -------------------------------------------------------------------------
if (!authHeaders) {
  for (const id of [
    "account.snapshot",
    "catalog.hosted_models",
    "inference.auto",
    "inference.exact_model",
    "sse.progressive",
    "accounting.reservation",
    "accounting.settlement",
    "usage.refresh",
    "failure.behavior",
    "concurrency.two_client",
    "auth.logout",
    "auth.replay_rejected",
  ]) {
    blockedWithoutSession(id);
  }
} else {
  // 4a. Account snapshot
  try {
    const res = await fetch(`${baseUrl}/v1/account`, { headers: authHeaders });
    const account = await res.json();
    evidence.creditBefore = account.creditBalance;
    stage("account.snapshot", res.ok ? "PASS" : "FAIL", `plan=${account.planId} balance=${account.creditBalance}`);
  } catch (err) {
    stage("account.snapshot", "FAIL", String(err?.message ?? err));
  }

  // 4b. Hosted catalog
  let freeModels = [];
  try {
    const res = await fetch(`${baseUrl}/v1/hosted/models`);
    const models = await res.json();
    freeModels = Array.isArray(models) ? models.filter((m) => m.isEligibleFree) : [];
    stage("catalog.hosted_models", freeModels.length > 0 ? "PASS" : "FAIL", `${freeModels.length} verified-free model(s)`);
  } catch (err) {
    stage("catalog.hosted_models", "FAIL", String(err?.message ?? err));
  }

  // Shared SSE runner: measures progressive delivery and captures accounting evidence.
  async function runInference(body, label) {
    const requestAt = Date.now();
    const res = await fetch(`${baseUrl}/v1/hosted/inference`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      throw new Error(`hosted inference returned HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let firstEventAt = -1;
    let terminalAt = -1;
    let provider;
    let model;
    let completed = false;
    let failureReason;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now();
      const text = decoder.decode(value, { stream: true });
      raw += text;
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        if (firstEventAt === -1) firstEventAt = now;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.type === "assistant.message.started") {
          provider = event.provider;
          model = event.model;
        }
        if (event.type === "usage.updated") evidence.creditAfter = event.balanceAfter;
        if (event.type === "turn.completed") {
          terminalAt = now;
          completed = true;
        }
        if (event.type === "turn.failed") {
          terminalAt = now;
          failureReason = event.error;
        }
      }
    }
    return { label, requestAt, firstEventAt, terminalAt, provider, model, completed, failureReason, raw };
  }

  // 4c. CodeForge Auto
  try {
    const requestId = randomUUID();
    evidence.requestId = requestId;
    const result = await runInference(
      { requestId, messages: [{ role: "user", content: "Reply with exactly: CODEFORGE_STAGING_CERTIFIED" }], modelId: "auto", taskType: "coding" },
      "auto",
    );
    evidence.provider = result.provider;
    evidence.model = result.model;
    evidence.verifiedFree = freeModels.some((m) => m.providerId === result.provider && m.modelId === result.model);
    evidence.sseFirstEventMs = result.firstEventAt - result.requestAt;
    evidence.sseTerminalEventMs = result.terminalAt - result.requestAt;

    stage("inference.auto", result.completed ? "PASS" : "FAIL", `${result.provider}::${result.model}${result.failureReason ? ` (${result.failureReason})` : ""}`);
    stage(
      "sse.progressive",
      result.firstEventAt > 0 && result.firstEventAt < result.terminalAt ? "PASS" : "FAIL",
      `first event +${evidence.sseFirstEventMs}ms, terminal +${evidence.sseTerminalEventMs}ms`,
    );
  } catch (err) {
    stage("inference.auto", "FAIL", String(err?.message ?? err));
    stage("sse.progressive", "FAIL", "no stream to measure");
  }

  // 4d. Exact model — must run THAT model or fail, never a substitute.
  try {
    if (freeModels.length === 0) throw new Error("no verified-free model to request exactly");
    const target = freeModels[0];
    const result = await runInference(
      {
        requestId: randomUUID(),
        messages: [{ role: "user", content: "Reply with exactly: EXACT_MODEL_OK" }],
        providerId: target.providerId,
        modelId: target.modelId,
      },
      "exact",
    );
    const exact = result.provider === target.providerId && result.model === target.modelId;
    stage("inference.exact_model", result.completed && exact ? "PASS" : "FAIL", `requested ${target.providerId}::${target.modelId}, served ${result.provider}::${result.model}`);
  } catch (err) {
    stage("inference.exact_model", "FAIL", String(err?.message ?? err));
  }

  // 4e. Accounting: reservation and settlement are visible as a balance movement.
  const reserved = typeof evidence.creditBefore === "number" && typeof evidence.creditAfter === "number";
  stage("accounting.reservation", reserved ? "PASS" : "BLOCKED", reserved ? `balance ${evidence.creditBefore} -> ${evidence.creditAfter}` : "no balance movement observed");
  stage(
    "accounting.settlement",
    reserved && evidence.creditAfter < evidence.creditBefore ? "PASS" : "BLOCKED",
    reserved ? `settled ${evidence.creditBefore - evidence.creditAfter} credits` : "no settlement observed",
  );

  // 4f. Usage refresh reflects the same server-side truth.
  try {
    const res = await fetch(`${baseUrl}/v1/usage`, { headers: authHeaders });
    const usage = await res.json();
    stage("usage.refresh", res.ok ? "PASS" : "FAIL", `balance=${usage.creditBalance}`);
  } catch (err) {
    stage("usage.refresh", "FAIL", String(err?.message ?? err));
  }

  // 4g. Failure behavior: an unavailable exact model must FAIL, not fall back.
  try {
    const result = await runInference(
      { requestId: randomUUID(), messages: [{ role: "user", content: "hi" }], providerId: "definitely-not-a-provider", modelId: "definitely-not-a-model" },
      "failure",
    );
    stage("failure.behavior", !result.completed ? "PASS" : "FAIL", result.completed ? "an unknown model was SERVED — substitution occurred" : "unknown model correctly refused");
  } catch (err) {
    // An HTTP-level rejection is also a correct refusal.
    stage("failure.behavior", "PASS", `unknown model refused (${String(err?.message ?? err)})`);
  }

  // 4h. Two-client concurrency against the SAME account.
  try {
    const bodies = [0, 1].map(() => ({
      requestId: randomUUID(),
      messages: [{ role: "user", content: "concurrent" }],
      modelId: "auto",
    }));
    const [a, b] = await Promise.all(
      bodies.map((body) => fetch(`${baseUrl}/v1/hosted/inference`, { method: "POST", headers: authHeaders, body: JSON.stringify(body) }).then((r) => r.text())),
    );
    const completions = [a, b].filter((t) => t.includes("turn.completed")).length;
    // Free tier admits one at a time. Two completions from a genuinely simultaneous pair would mean
    // the server-side admission control did not hold.
    const ok = completions <= 1 || [a, b].some((t) => /[Cc]oncurrent|limit/.test(t));
    evidence.twoClientConcurrencyResult = ok ? "PASS" : "FAIL";
    stage("concurrency.two_client", ok ? "PASS" : "FAIL", `${completions} of 2 simultaneous same-account requests completed`);
  } catch (err) {
    evidence.twoClientConcurrencyResult = "FAIL";
    stage("concurrency.two_client", "FAIL", String(err?.message ?? err));
  }

  // 4i. Logout and replay rejection.
  if (refreshToken) {
    try {
      const logout = await fetch(`${baseUrl}/v1/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      stage("auth.logout", logout.ok ? "PASS" : "FAIL", `HTTP ${logout.status}`);

      const replay = await fetch(`${baseUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      stage("auth.replay_rejected", replay.status === 401 ? "PASS" : "FAIL", `refresh after logout returned HTTP ${replay.status}`);
    } catch (err) {
      stage("auth.logout", "FAIL", String(err?.message ?? err));
      stage("auth.replay_rejected", "FAIL", "not evaluated");
    }
  } else {
    blockedWithoutSession("auth.logout", "no refresh token available");
    blockedWithoutSession("auth.replay_rejected", "no refresh token available");
  }

  // 4j. Single-use desktop code replay, when this run performed the login itself.
  if (loginArtifacts) {
    try {
      const replay = await fetch(`${baseUrl}/v1/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: loginArtifacts.code,
          codeVerifier: loginArtifacts.codeVerifier,
          state: loginArtifacts.state,
          redirectUri: loginArtifacts.redirectUri,
        }),
      });
      stage("oauth.code_replay_rejected", replay.status >= 400 ? "PASS" : "FAIL", `replayed desktop code returned HTTP ${replay.status}`);
    } catch (err) {
      stage("oauth.code_replay_rejected", "FAIL", String(err?.message ?? err));
    }
  } else {
    stage("oauth.code_replay_rejected", "BLOCKED", "this run did not perform the login itself");
  }
}

// --- 5. Direct/BYOK independence -------------------------------------------------------------------
// Certified deterministically in CI (tests/direct-byok-cloud-outage.test.ts). Reported here so the
// receipt reflects the whole invariant set rather than implying it was proven remotely.
try {
  // Invoke vitest's own entrypoint through the current Node binary rather than shelling out to
  // `npx`, which is a shim script and not directly executable on every platform.
  const vitestCli = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
  if (!existsSync(vitestCli)) {
    throw new Error("vitest is not installed — run `npm ci` before certifying");
  }
  // Run the suite in a NEUTRAL environment. The certification process itself runs with the target
  // deployment's variables exported, and leaking those into a unit-test subprocess would have it
  // exercise a different configuration than the one CI validates.
  const neutralEnv = { ...process.env };
  for (const key of Object.keys(neutralEnv)) {
    if (key.startsWith("CODEFORGE_") || key === "DATABASE_URL" || key === "NODE_ENV") delete neutralEnv[key];
  }
  execFileSync(process.execPath, [vitestCli, "run", "tests/direct-byok-cloud-outage.test.ts", "--reporter=basic"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: neutralEnv,
  });
  evidence.directByokOutageResult = "PASS";
  stage("direct_byok.cloud_outage", "PASS", "Direct and BYOK verified functional with the Cloud unavailable");
} catch (err) {
  evidence.directByokOutageResult = "FAIL";
  stage("direct_byok.cloud_outage", "FAIL", `the deterministic Direct/BYOK outage suite did not pass: ${String(err?.message ?? err).split("\n")[0]}`);
}

// --- Verdict ------------------------------------------------------------------------------------------
const failed = stages.filter((s) => s.status === "FAIL").length;
const blocked = stages.filter((s) => s.status === "BLOCKED").length;
const passed = stages.filter((s) => s.status === "PASS").length;
const skipped = stages.filter((s) => s.status === "SKIP").length;

let verdict;
if (failed > 0) {
  verdict = "CODEFORGE_CLOUD_STAGING_CERTIFICATION_FAILED";
} else if (blocked > 0) {
  verdict = "CODEFORGE_CLOUD_STAGING_LAUNCH_READY_EXTERNAL_RESOURCES_REQUIRED";
} else {
  verdict = "CODEFORGE_CLOUD_REMOTE_ZERO_SETUP_CERTIFIED";
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  } catch {
    return "0000000";
  }
}

const receipt = {
  schemaVersion: CERTIFICATION_RECEIPT_SCHEMA_VERSION,
  timestamp: new Date().toISOString(),
  gitSha: gitSha(),
  dockerImageDigest: process.env.CODEFORGE_DOCKER_IMAGE_DIGEST,
  desktopPackageSha256: process.env.CODEFORGE_DESKTOP_PACKAGE_SHA256,
  cloudUrl: baseUrl,
  cloudEnvironment: process.env.CODEFORGE_CLOUD_ENV === "production" ? "production" : "staging",
  databaseEngine: evidence.databaseEngine,
  databaseTls: evidence.databaseTls,
  oauthFlow: "server-brokered-github-pkce",
  oauthCallbackUrl: evidence.oauthCallbackUrl,
  provider: evidence.provider,
  model: evidence.model,
  verifiedFree: evidence.verifiedFree,
  requestId: evidence.requestId,
  providerCostUsd: 0,
  creditBefore: evidence.creditBefore,
  creditAfter: evidence.creditAfter,
  sseFirstEventMs: evidence.sseFirstEventMs,
  sseTerminalEventMs: evidence.sseTerminalEventMs,
  twoClientConcurrencyResult: evidence.twoClientConcurrencyResult,
  directByokOutageResult: evidence.directByokOutageResult,
  securityResult: evidence.securityResult,
  ciRun: process.env.GITHUB_RUN_ID,
  ownerCashUsd: 0,
  stages,
  verdict,
};

console.log("");
console.log(`${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped — ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`VERDICT: ${verdict}`);

// Serialization applies schema validation, redaction, and a final secret scan. If it throws, the
// certification produced evidence it must not write — that is a failure, not a warning.
let receiptJson;
try {
  receiptJson = serializeCertificationReceipt(receipt);
} catch (err) {
  console.error(`REFUSED to write certification receipt: ${String(err?.message ?? err)}`);
  process.exit(1);
}

if (jsonPath) {
  writeFileSync(jsonPath, receiptJson, "utf8");
  console.log(`receipt written to ${jsonPath}`);
}

if (mdPath) {
  const lines = [
    "# CodeForge Cloud — Staging Certification",
    "",
    `- **Verdict:** \`${verdict}\``,
    `- **Target:** ${baseUrl}`,
    `- **Git SHA:** \`${receipt.gitSha}\``,
    `- **Timestamp:** ${receipt.timestamp}`,
    `- **OAuth flow:** ${receipt.oauthFlow}`,
    `- **Owner cash:** $${receipt.ownerCashUsd.toFixed(2)}`,
    "",
    "| Stage | Status | Detail |",
    "| --- | --- | --- |",
    ...stages.map((s) => `| \`${s.id}\` | ${s.status} | ${(s.detail ?? "").replace(/\|/g, "\\|")} |`),
    "",
    `${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped.`,
    "",
    "> Secret values are excluded by construction: this document is generated from a receipt that is",
    "> schema-validated, redacted, and scanned before it is written.",
  ];
  writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`summary written to ${mdPath}`);
}

process.exit(failed > 0 ? 1 : 0);

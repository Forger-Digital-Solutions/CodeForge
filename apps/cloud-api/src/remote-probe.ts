import { redactSecrets } from "./staging-contract.js";

/**
 * Remote deployment probe: everything that can be verified about a live CodeForge Cloud deployment
 * from the outside, without credentials.
 *
 * It answers the questions an operator asks immediately after a deploy — is TLS real, is it ready, is
 * authentication actually enforced, does it leak anything, does it stream — and emits both a console
 * summary and a machine-readable receipt. No secret ever enters either output: response bodies are
 * scanned for credential shapes and only the FINDING is reported, never the matched text.
 */
export type ProbeStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface ProbeCheck {
  id: string;
  status: ProbeStatus;
  message: string;
  /** Milliseconds for the underlying request, when one was made. */
  durationMs?: number;
}

export interface RemoteProbeReport {
  schemaVersion: "1.0.0";
  timestamp: string;
  target: string;
  checks: ProbeCheck[];
  passed: number;
  failed: number;
  warnings: number;
  ok: boolean;
}

export interface RemoteProbeOptions {
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Allow a plain-http target. Only ever true when probing a local container. */
  allowInsecure?: boolean;
}

/** Credential shapes that must never appear in a public response body. */
const LEAK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Stripe key", pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9_]{8,}/ },
  { name: "Stripe webhook secret", pattern: /\bwhsec_[A-Za-z0-9_]{8,}/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: "GitHub PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "OpenRouter key", pattern: /\bsk-or-[A-Za-z0-9-]{16,}/ },
  { name: "Groq key", pattern: /\bgsk_[A-Za-z0-9]{16,}/ },
  { name: "database URL with password", pattern: /\b(postgres|postgresql):\/\/[^\s"']*:[^\s"'@]*@/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub client secret env name", pattern: /GITHUB_CLIENT_SECRET\s*[=:]\s*\S/ },
];

async function timedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; durationMs: number } | { error: string; durationMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    return { res, durationMs: Date.now() - started };
  } catch (err) {
    return { error: describeFetchError(err), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten a fetch failure into something an operator can act on.
 *
 * `fetch` reports every transport failure as the single word "failed" and hides the real reason —
 * DNS, TLS, refused connection — in a `cause` chain. A probe that reports "fetch failed" tells the
 * operator nothing, so the chain is walked and the underlying code surfaced.
 */
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code ? `${current.message} (${code})` : current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return redactSecrets(parts.join(" <- ") || "unknown transport failure");
}

/**
 * Probe a deployed Cloud.
 *
 * @param baseUrl the deployment's public origin (https://…)
 */
export async function probeRemoteDeployment(baseUrl: string, options: RemoteProbeOptions = {}): Promise<RemoteProbeReport> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const allowInsecure = options.allowInsecure ?? false;
  const checks: ProbeCheck[] = [];
  const add = (id: string, status: ProbeStatus, message: string, durationMs?: number) =>
    checks.push({ id, status, message: redactSecrets(message), durationMs });

  // --- Target shape --------------------------------------------------------------------------
  let target: URL;
  try {
    target = new URL(baseUrl);
  } catch {
    add("target.url", "FAIL", "target is not a valid absolute URL");
    return finalize(baseUrl, checks);
  }
  const origin = `${target.protocol}//${target.host}`;

  if (target.protocol === "https:") {
    add("target.https", "PASS", `target uses HTTPS (${target.host})`);
  } else if (allowInsecure) {
    add("target.https", "WARN", `target uses ${target.protocol} — accepted only because --allow-insecure was passed`);
  } else {
    add("target.https", "FAIL", `target must use HTTPS (got ${target.protocol})`);
    return finalize(origin, checks);
  }

  // DNS + certificate validation are both exercised implicitly by the first request: Node rejects an
  // untrusted certificate, and an unresolvable host fails to connect. Reporting them separately makes
  // the failure legible instead of a generic "fetch failed".
  const live = await timedFetch(fetchFn, `${origin}/health/live`, { method: "GET" }, timeoutMs);
  if ("error" in live) {
    const msg = live.error.toLowerCase();
    if (msg.includes("enotfound") || msg.includes("eai_again") || msg.includes("getaddrinfo")) {
      add("target.dns", "FAIL", `DNS resolution failed for ${target.hostname}`, live.durationMs);
    } else if (msg.includes("cert") || msg.includes("tls") || msg.includes("ssl") || msg.includes("self-signed")) {
      add("target.tls_certificate", "FAIL", `TLS certificate validation failed: ${live.error}`, live.durationMs);
    } else {
      add("health.live", "FAIL", `/health/live unreachable: ${live.error}`, live.durationMs);
    }
    return finalize(origin, checks);
  }
  add("target.dns", "PASS", `DNS resolved and connection established to ${target.hostname}`, live.durationMs);
  if (target.protocol === "https:") {
    add("target.tls_certificate", "PASS", "TLS certificate validated by the system trust store", live.durationMs);
  }

  // --- Health / readiness ---------------------------------------------------------------------
  if (live.res.status === 200) {
    add("health.live", "PASS", `/health/live returned 200 in ${live.durationMs}ms`, live.durationMs);
  } else {
    add("health.live", "FAIL", `/health/live returned ${live.res.status}`, live.durationMs);
  }
  const liveBody = await safeText(live.res);
  scanForLeaks("health.live", liveBody, add);

  const ready = await timedFetch(fetchFn, `${origin}/health/ready`, { method: "GET" }, timeoutMs);
  if ("error" in ready) {
    add("health.ready", "FAIL", `/health/ready unreachable: ${ready.error}`, ready.durationMs);
  } else {
    const body = await safeText(ready.res);
    scanForLeaks("health.ready", body, add);
    let parsed: { status?: string; database?: string; hostedInferenceReady?: boolean; availableFreeCount?: number } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* non-JSON readiness body is itself reported below */
    }
    if (ready.res.status === 200 && parsed.database === "connected") {
      add("health.ready", "PASS", `/health/ready reports database connected`, ready.durationMs);
    } else if (ready.res.status === 503) {
      add("health.ready", "FAIL", `/health/ready returned 503 (database ${parsed.database ?? "unknown"}) — the deployment is not serving`, ready.durationMs);
    } else {
      add("health.ready", "FAIL", `/health/ready returned ${ready.res.status}`, ready.durationMs);
    }
    if (parsed.hostedInferenceReady) {
      add("capacity.hosted_free", "PASS", `hosted free capacity available (${parsed.availableFreeCount ?? 0} verified-free model(s))`);
    } else {
      add("capacity.hosted_free", "WARN", "hosted inference reports not ready — no verified-free capacity is currently routable");
    }
  }

  // --- Metadata & catalog -----------------------------------------------------------------------
  const meta = await timedFetch(fetchFn, `${origin}/v1/meta`, { method: "GET" }, timeoutMs);
  if ("error" in meta) {
    add("meta", "FAIL", `/v1/meta unreachable: ${meta.error}`, meta.durationMs);
  } else {
    const body = await safeText(meta.res);
    scanForLeaks("meta", body, add);
    add(meta.res.status === 200 ? "meta" : "meta", meta.res.status === 200 ? "PASS" : "FAIL", `/v1/meta returned ${meta.res.status}`, meta.durationMs);
  }

  const models = await timedFetch(fetchFn, `${origin}/v1/hosted/models`, { method: "GET" }, timeoutMs);
  if ("error" in models) {
    add("models", "FAIL", `/v1/hosted/models unreachable: ${models.error}`, models.durationMs);
  } else {
    const body = await safeText(models.res);
    scanForLeaks("models", body, add);
    let count = -1;
    try {
      const arr = JSON.parse(body);
      count = Array.isArray(arr) ? arr.length : -1;
    } catch {
      /* reported via status check */
    }
    if (models.res.status === 200 && count >= 0) {
      add("models", "PASS", `/v1/hosted/models returned ${count} model(s)`, models.durationMs);
    } else {
      add("models", "FAIL", `/v1/hosted/models returned ${models.res.status}`, models.durationMs);
    }
  }

  // --- Security headers ---------------------------------------------------------------------------
  const h = live.res.headers;
  const headerChecks: Array<[string, string, string]> = [
    ["x-content-type-options", "nosniff", "X-Content-Type-Options: nosniff"],
    ["referrer-policy", "no-referrer", "Referrer-Policy: no-referrer"],
  ];
  for (const [header, expected, label] of headerChecks) {
    const actual = h.get(header);
    if (actual && actual.toLowerCase().includes(expected)) {
      add(`security.header.${header}`, "PASS", `${label} present`);
    } else {
      add(`security.header.${header}`, "FAIL", `${label} missing (got '${actual ?? "unset"}')`);
    }
  }
  const cacheControl = h.get("cache-control");
  if (cacheControl && cacheControl.includes("no-store")) {
    add("security.header.cache-control", "PASS", "Cache-Control: no-store present");
  } else {
    add("security.header.cache-control", "WARN", `Cache-Control is '${cacheControl ?? "unset"}' — API responses should not be cacheable`);
  }

  // --- Authentication is actually enforced ----------------------------------------------------------
  for (const path of ["/v1/account", "/v1/usage"]) {
    const unauth = await timedFetch(fetchFn, `${origin}${path}`, { method: "GET" }, timeoutMs);
    if ("error" in unauth) {
      add(`auth.required${path}`, "FAIL", `${path} unreachable: ${unauth.error}`, unauth.durationMs);
      continue;
    }
    const body = await safeText(unauth.res);
    scanForLeaks(`auth.required${path}`, body, add);
    if (unauth.res.status === 401) {
      add(`auth.required${path}`, "PASS", `${path} requires authentication (401 without a token)`, unauth.durationMs);
    } else {
      add(`auth.required${path}`, "FAIL", `${path} returned ${unauth.res.status} without a token — authentication is not enforced`, unauth.durationMs);
    }
  }

  // A forged bearer token must be rejected outright.
  const forged = await timedFetch(
    fetchFn,
    `${origin}/v1/account`,
    { method: "GET", headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9." } },
    timeoutMs,
  );
  if (!("error" in forged) && forged.res.status === 401) {
    add("auth.forged_token", "PASS", "forged/unsigned bearer token rejected with 401", forged.durationMs);
  } else if ("error" in forged) {
    add("auth.forged_token", "FAIL", `forged-token probe failed: ${forged.error}`, forged.durationMs);
  } else {
    add("auth.forged_token", "FAIL", `forged bearer token produced ${forged.res.status} instead of 401`, forged.durationMs);
  }

  // --- OAuth readiness -------------------------------------------------------------------------------
  // A well-formed start request tells us whether the OAuth app is configured, without completing a login.
  const startProbe = await timedFetch(
    fetchFn,
    `${origin}/v1/auth/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:49152/auth/callback", codeChallenge: "A".repeat(43) }),
    },
    timeoutMs,
  );
  if ("error" in startProbe) {
    add("oauth.ready", "FAIL", `/v1/auth/start unreachable: ${startProbe.error}`, startProbe.durationMs);
  } else {
    const body = await safeText(startProbe.res);
    scanForLeaks("oauth.ready", body, add);
    if (startProbe.res.status === 200) {
      let parsed: { authUrl?: string; cloudCallbackUrl?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* handled below */
      }
      if (parsed.authUrl?.startsWith("https://github.com/login/oauth/authorize")) {
        add("oauth.ready", "PASS", `OAuth start issues a GitHub authorize URL; registered callback is ${parsed.cloudCallbackUrl ?? "(not reported)"}`, startProbe.durationMs);
      } else {
        add("oauth.ready", "FAIL", "OAuth start did not return a GitHub authorize URL", startProbe.durationMs);
      }
      // The desktop must never receive the server-owned GitHub verifier.
      if (/codeVerifier|gitHubCodeVerifier/.test(body)) {
        add("oauth.no_verifier_leak", "FAIL", "OAuth start response contains a PKCE code verifier — the server-owned GitHub verifier must never reach a client");
      } else {
        add("oauth.no_verifier_leak", "PASS", "OAuth start response contains no PKCE verifier");
      }
    } else {
      add("oauth.ready", "FAIL", `/v1/auth/start returned ${startProbe.res.status} — GitHub OAuth is not configured on this deployment`, startProbe.durationMs);
    }
  }

  // Hostile redirect targets must be refused before any transaction is created.
  const openRedirect = await timedFetch(
    fetchFn,
    `${origin}/v1/auth/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "https://attacker.example/auth/callback", codeChallenge: "A".repeat(43) }),
    },
    timeoutMs,
  );
  if (!("error" in openRedirect) && openRedirect.res.status >= 400) {
    add("oauth.open_redirect", "PASS", "hostile redirect target refused at OAuth start", openRedirect.durationMs);
  } else {
    add("oauth.open_redirect", "FAIL", "deployment accepted a non-loopback OAuth redirect target");
  }

  // --- CORS ------------------------------------------------------------------------------------------
  const cors = await timedFetch(fetchFn, `${origin}/v1/meta`, { method: "GET", headers: { Origin: "https://untrusted.example" } }, timeoutMs);
  if (!("error" in cors)) {
    const allow = cors.res.headers.get("access-control-allow-origin");
    if (!allow || allow === "null") {
      add("cors.untrusted_origin", "PASS", "untrusted origin is not granted CORS access");
    } else if (allow === "*") {
      add("cors.untrusted_origin", "FAIL", "deployment returns a wildcard Access-Control-Allow-Origin");
    } else {
      add("cors.untrusted_origin", "FAIL", `untrusted origin was echoed back in Access-Control-Allow-Origin ('${allow}')`);
    }
  }

  // --- Payload limit ------------------------------------------------------------------------------------
  const oversized = await timedFetch(
    fetchFn,
    `${origin}/v1/auth/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUri: "http://127.0.0.1:49152/auth/callback", codeChallenge: "A".repeat(43), deviceName: "A".repeat(1024 * 1024 + 128) }),
    },
    timeoutMs,
  );
  if (!("error" in oversized) && (oversized.res.status === 413 || oversized.res.status === 400)) {
    add("limits.payload", "PASS", `oversized body rejected with ${oversized.res.status}`, oversized.durationMs);
  } else if ("error" in oversized) {
    add("limits.payload", "WARN", `payload-limit probe could not complete: ${oversized.error}`, oversized.durationMs);
  } else {
    add("limits.payload", "FAIL", `oversized body produced ${oversized.res.status} — the payload limit is not enforced`, oversized.durationMs);
  }

  // --- Error normalization -------------------------------------------------------------------------------
  const notFound = await timedFetch(fetchFn, `${origin}/v1/definitely-not-a-route`, { method: "GET" }, timeoutMs);
  if (!("error" in notFound)) {
    const body = await safeText(notFound.res);
    scanForLeaks("errors.normalized", body, add);
    if (/at\s+\/|\.ts:\d+|\.js:\d+|node_modules/.test(body)) {
      add("errors.normalized", "FAIL", "error response leaks a stack trace or filesystem path");
    } else {
      add("errors.normalized", "PASS", `unknown route returns a normalized ${notFound.res.status} without internals`);
    }
  }

  // --- SSE headers -----------------------------------------------------------------------------------------
  // Unauthenticated, so this only asserts the endpoint exists and refuses anonymous streaming; the real
  // streaming behavior is certified with a token by the certification harness.
  const sse = await timedFetch(
    fetchFn,
    `${origin}/v1/hosted/inference`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000000", messages: [{ role: "user", content: "probe" }] }),
    },
    timeoutMs,
  );
  if (!("error" in sse) && sse.res.status === 401) {
    add("sse.auth_required", "PASS", "hosted inference requires authentication before streaming", sse.durationMs);
  } else if ("error" in sse) {
    add("sse.auth_required", "FAIL", `hosted inference probe failed: ${sse.error}`, sse.durationMs);
  } else {
    add("sse.auth_required", "FAIL", `hosted inference returned ${sse.res.status} without a token`, sse.durationMs);
  }

  return finalize(origin, checks);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 64 * 1024);
  } catch {
    return "";
  }
}

function scanForLeaks(scope: string, body: string, add: (id: string, status: ProbeStatus, message: string) => void): void {
  for (const { name, pattern } of LEAK_PATTERNS) {
    if (pattern.test(body)) {
      // Report only the CLASS of leak. The matched text is never echoed.
      add(`leak.${scope}`, "FAIL", `${scope} response body contains something shaped like a ${name}`);
      return;
    }
  }
}

function finalize(target: string, checks: ProbeCheck[]): RemoteProbeReport {
  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warnings = checks.filter((c) => c.status === "WARN").length;
  return {
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    target,
    checks,
    passed,
    failed,
    warnings,
    ok: failed === 0,
  };
}

/** Console rendering of a probe report. Contains no secrets by construction. */
export function formatProbeReport(report: RemoteProbeReport): string {
  const lines = report.checks.map((c) => `${c.status.padEnd(4)}  ${c.message}${c.durationMs !== undefined ? ` (${c.durationMs}ms)` : ""}`);
  lines.push("");
  lines.push(`${report.passed} passed, ${report.failed} failed, ${report.warnings} warning(s) — target ${report.target}`);
  lines.push(report.ok ? "REMOTE PROBE: PASS" : "REMOTE PROBE: FAIL");
  return lines.join("\n");
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RC-7 certifies that the diagnostic surface can be handed to support without leaking secrets:
 * credential-shaped keys and values are redacted before they touch disk, the bundle only ever
 * carries the sanitized state summary the caller supplies plus the already-sanitized log tail.
 *
 * `electron` is not importable under vitest, so `app` is mocked to a temp user-data directory;
 * every assertion reads real files the module wrote.
 */

let userData = "";

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getVersion: () => "0.0.0-test",
  },
}));

import {
  sanitizeDiagnosticValue,
  initDiagnostics,
  closeDiagnostics,
  logDiagnostic,
  writeDiagnosticBundle,
  diagnosticsLogPath,
} from "../src/diagnostics.js";

const SECRET_VALUE = "sk-or-v1-abcdef0123456789secret";
const GITHUB_TOKEN = "ghp_0123456789abcdefghijABCD";

describe("sanitizeDiagnosticValue", () => {
  it("redacts values under credential-named keys regardless of shape", () => {
    expect(
      sanitizeDiagnosticValue({
        apiKey: SECRET_VALUE,
        access_token: "opaque",
        Authorization: "Bearer opaque",
        nested: { sessionSecret: "opaque", fine: "visible" },
      }),
    ).toEqual({
      apiKey: "[redacted]",
      access_token: "[redacted]",
      Authorization: "[redacted]",
      nested: { sessionSecret: "[redacted]", fine: "visible" },
    });
  });

  it("redacts credential-shaped values under innocent key names", () => {
    const out = sanitizeDiagnosticValue({
      note: `failed with ${SECRET_VALUE} and ${GITHUB_TOKEN} and Bearer abcdef0123456789`,
      sha: "0123456789abcdef0123456789abcdef01234567",
      shortHex: "0123456789abcdef0123456789abcdef0123456",
    }) as Record<string, string>;
    expect(out.note).not.toContain(SECRET_VALUE);
    expect(out.note).not.toContain(GITHUB_TOKEN);
    expect(out.note).not.toContain("abcdef0123456789");
    expect(out.sha).toBe("[redacted]");
    // 39 hex chars is not a credential shape — must survive.
    expect(out.shortHex).toBe("0123456789abcdef0123456789abcdef0123456");
  });

  it("preserves ordinary state and truncates oversized strings", () => {
    const out = sanitizeDiagnosticValue({
      providerId: "openrouter",
      connected: true,
      freeRouteCount: 22,
      blob: "x".repeat(600),
    }) as Record<string, unknown>;
    expect(out.providerId).toBe("openrouter");
    expect(out.connected).toBe(true);
    expect(out.freeRouteCount).toBe(22);
    expect(String(out.blob).length).toBeLessThan(600);
  });
});

describe("persistent log + bundle", () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "cf-diag-"));
  });

  afterEach(() => {
    closeDiagnostics();
    rmSync(userData, { recursive: true, force: true });
    userData = "";
  });

  it("writes sanitized JSON-lines to a persistent log inside userData", async () => {
    initDiagnostics();
    logDiagnostic("warn", "cloud_auth_failed", {
      kind: "network",
      endpointConfigured: true,
      accessToken: SECRET_VALUE,
      detail: `upstream said Bearer abcdef0123456789 rejected`,
    });
    closeDiagnostics();
    const logPath = diagnosticsLogPath();
    expect(logPath).not.toBeNull();
    const content = readFileSync(logPath!, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    const authLine = lines.find((l) => l.event === "cloud_auth_failed");
    expect(authLine.level).toBe("warn");
    expect(authLine.kind).toBe("network");
    expect(authLine.accessToken).toBe("[redacted]");
    expect(authLine.detail).toContain("[redacted]");
    expect(content).not.toContain(SECRET_VALUE);
    expect(content).not.toContain("abcdef0123456789");
  });

  it("writes a bundle with platform facts, sanitized state, and the log tail", async () => {
    initDiagnostics();
    logDiagnostic("info", "free_cloud_snapshot", { verifiedFreeModels: 22, apiKey: SECRET_VALUE });
    const result = writeDiagnosticBundle({
      runtimeStatus: "ready",
      providers: [{ providerId: "codeforge-cloud", supplyClass: "PURE_MANAGED_FREE", credential: "x" }],
      cloud: { signedIn: true, refreshToken: "opaque-token" },
    });
    expect(result.ok).toBe(true);
    expect(result.path).toContain(join(userData, "diagnostics"));
    const bundle = JSON.parse(readFileSync(result.path!, "utf8"));
    expect(bundle.kind).toBe("codeforge-diagnostic-bundle");
    expect(bundle.version).toBe("0.0.0-test");
    expect(bundle.state.runtimeStatus).toBe("ready");
    expect(bundle.state.providers[0].supplyClass).toBe("PURE_MANAGED_FREE");
    expect(bundle.state.providers[0].credential).toBe("[redacted]");
    expect(bundle.state.cloud.refreshToken).toBe("[redacted]");
    expect(bundle.state.cloud.signedIn).toBe(true);
    expect(bundle.logTail.length).toBeGreaterThan(0);
    const raw = readFileSync(result.path!, "utf8");
    expect(raw).not.toContain(SECRET_VALUE);
    expect(raw).not.toContain("opaque-token");
  });

  it("fails closed instead of throwing when the log was never initialized", () => {
    closeDiagnostics();
    const result = writeDiagnosticBundle({ a: 1 });
    // No log stream is fine — the bundle itself must still be written.
    expect(result.ok).toBe(true);
    expect(existsSync(result.path!)).toBe(true);
    const files = readdirSync(join(userData, "diagnostics"));
    expect(files.length).toBeGreaterThan(0);
  });
});

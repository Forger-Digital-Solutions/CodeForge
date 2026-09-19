/**
 * Dependency-audit gate integrity (Security R1 follow-up, host-native campaign 2026-09-18).
 *
 * `scripts/security/audit-dependencies.mjs` shells out to `npm audit --json`. When the registry
 * call fails, npm still prints JSON — an `error` object without `metadata.vulnerabilities` — and
 * the gate used to derive an empty vulnerability list from it and report PASS. Two consecutive
 * "PASS" evidence files (`npmAuditExitCode: 1, summary: {}`) were produced that way. The gate must
 * fail closed: no advisory data means INCONCLUSIVE and a non-zero exit, never PASS.
 *
 * The real script runs against a stubbed `npm` placed first on PATH; no network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(repoRoot, "scripts", "security", "audit-dependencies.mjs");

let work: string;

/** A minimal workspace: the script only needs a lockfile (for the SBOM) and a place to write. */
function writeWorkspace(): void {
  writeFileSync(
    path.join(work, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left-pad": { version: "1.3.0", license: "MIT", resolved: "https://registry.invalid/left-pad-1.3.0.tgz" } } }),
  );
}

/** Stub `npm` (both the .cmd Windows resolves and the POSIX shim) that prints a canned audit JSON. */
function stubNpm(payload: unknown, exitCode: number): string {
  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const json = JSON.stringify(payload);
  const jsonFile = path.join(bin, "audit.json");
  writeFileSync(jsonFile, json);
  // Windows: cmd.exe resolves `npm` to npm.cmd on PATH.
  writeFileSync(path.join(bin, "npm.cmd"), `@echo off\r\ntype "${jsonFile}"\r\nexit /b ${exitCode}\r\n`);
  // POSIX: an executable shell shim.
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\ncat "${jsonFile}"\nexit ${exitCode}\n`, { mode: 0o755 });
  return bin;
}

function runGate(bin: string): { status: number | null; stdout: string; stderr: string; report: Record<string, unknown> } {
  const jsonOut = path.join("out", "dependency-audit.json");
  const sbomOut = path.join("out", "sbom.json");
  const result = spawnSync(process.execPath, [script, "--json", jsonOut, "--sbom", sbomOut], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, Path: `${bin}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}` },
  });
  const report = JSON.parse(readFileSync(path.join(work, jsonOut), "utf8")) as Record<string, unknown>;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "cf-audit-gate-"));
  writeWorkspace();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("dependency audit gate integrity", () => {
  it("reports INCONCLUSIVE and exits non-zero when npm audit returns an error instead of advisory data", () => {
    const bin = stubNpm({ error: { code: "ENOAUDIT", summary: "Your configured registry does not support audit requests." } }, 1);
    const run = runGate(bin);

    expect(run.report.status).toBe("INCONCLUSIVE");
    expect(run.report.npmAuditExitCode).toBe(1);
    expect(run.report.auditError).toEqual({ code: "ENOAUDIT", summary: "Your configured registry does not support audit requests." });
    expect(run.status).toBe(4);
    expect(run.stderr).toMatch(/INCONCLUSIVE, not PASS/);
  });

  it("reports INCONCLUSIVE when the audit JSON lacks metadata even with a zero exit", () => {
    const bin = stubNpm({ auditReportVersion: 2, vulnerabilities: {} }, 0);
    const run = runGate(bin);

    expect(run.report.status).toBe("INCONCLUSIVE");
    expect(run.status).toBe(4);
  });

  it("reports PASS with the audited dependency count when npm audit returns a clean report", () => {
    const bin = stubNpm(
      {
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 } },
      },
      0,
    );
    const run = runGate(bin);

    expect(run.report.status).toBe("PASS");
    expect(run.report.dependenciesAudited).toBe(1);
    expect(run.report.auditError).toBeNull();
    expect(run.status).toBe(0);
  });

  it("still FAILs on an unaccepted high advisory", () => {
    const bin = stubNpm(
      {
        auditReportVersion: 2,
        vulnerabilities: { "left-pad": { name: "left-pad", severity: "high", isDirect: true, range: "<1.3.1", fixAvailable: true, via: [{ title: "fixture advisory", url: "https://example.invalid/advisory", severity: "high", range: "<1.3.1" }] } },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 }, dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 } },
      },
      1,
    );
    const run = runGate(bin);

    expect(run.report.status).toBe("FAIL");
    expect(run.status).toBe(2);
  });
});

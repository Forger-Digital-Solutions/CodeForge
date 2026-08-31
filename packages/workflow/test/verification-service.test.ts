import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { prepareShellCommand } from "../src/child-process.js";
import { runCommand, runVerification, verificationPassed, verificationFailed } from "../src/verification-service.js";

describe("VerificationService", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "verify-"));
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it("runs successful command", async () => {
    const result = await runCommand({ workspacePath: ws, command: "node -e \"process.exit(0)\"" });
    expect(result.exitCode).toBe(0);
    expect(result.passed).toBeGreaterThanOrEqual(1);
  });

  it("detects failed command", async () => {
    const result = await runCommand({ workspacePath: ws, command: "node -e \"process.exit(1)\"" });
    expect(result.exitCode).toBe(1);
    expect(result.failed).toBeGreaterThan(0);
  });

  it("redacts secrets in output", async () => {
    const result = await runCommand({ workspacePath: ws, command: "node -e \"console.log('sk-proj-1234567890abcdef')\"" });
    expect(result.output).not.toContain("sk-proj-1234567890");
    expect(result.output).toContain("[REDACTED]");
  });

  it("truncates large output", async () => {
    const result = await runCommand({ workspacePath: ws, command: "node -e \"console.log('a'.repeat(70000))\"" });
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThan(70 * 1024);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    const promise = runCommand({ workspacePath: ws, command: "node -e \"setTimeout(()=>{}, 5000)\"", signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.output).toContain("aborted");
  });

  it("runVerification fallback when no package.json", async () => {
    const result = await runVerification(ws, ["npm test"]);
    // No package.json, so synthetic pass or skip
    expect(result).toBeDefined();
  });

  it("runVerification with custom command", async () => {
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "test" }));
    const result = await runVerification(ws, ["node -e \"process.exit(0)\""]);
    expect(result.exitCode).toBe(0);
  });

  it("does not depend on shell PATH to launch Node", async () => {
    const originalPath = process.env.PATH;
    const originalMixedPath = process.env.Path;
    try {
      process.env.PATH = "C:\\definitely-not-node";
      process.env.Path = "C:\\definitely-not-node";
      const result = await runCommand({ workspacePath: ws, command: "node -e \"process.exit(0)\"" });
      expect(result.exitCode).toBe(0);
    } finally {
      process.env.PATH = originalPath;
      if (originalMixedPath === undefined) delete process.env.Path;
      else process.env.Path = originalMixedPath;
    }
  });

  it("does not propagate package-manager credentials to verification commands", async () => {
    const original = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = "verification-test-token";
    try {
      const result = await runCommand({
        workspacePath: ws,
        command: "node -e \"process.exit(process.env.NPM_TOKEN ? 1 : 0)\"",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      if (original === undefined) delete process.env.NPM_TOKEN;
      else process.env.NPM_TOKEN = original;
    }
  });

  it("uses packaged Electron as a Node runtime without a global node executable", () => {
    const prepared = prepareShellCommand(
      "node -e \"process.exit(0)\"",
      { PATH: "C:\\Windows\\System32" },
      ws,
      { execPath: "C:\\Program Files\\CodeForge\\CodeForge.exe", isElectron: true, platform: "win32" },
    );
    expect(prepared.command).toBe("C:\\Program Files\\CodeForge\\CodeForge.exe");
    expect(prepared.shell).toBe(false);
    expect(prepared.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(prepared.runtimeKind).toBe("electron-as-node");
  });

  it("reports timeout deterministically and terminates descendants", async () => {
    // The descendant announces itself only after DESCENDANT_WRITE_DELAY_MS. The tree kill therefore
    // has that long to reach it; the assertion is made after a longer wait still, so a surviving
    // descendant is always observed. The window is generous on purpose — the invariant under test is
    // "descendants are terminated", not "terminated within a few hundred milliseconds", and a tight
    // window makes the test fail under parallel-suite load rather than on a real regression.
    const DESCENDANT_WRITE_DELAY_MS = 3000;
    const ASSERT_AFTER_MS = 4000;

    await writeFile(
      join(ws, "descendant.cjs"),
      `const fs=require('node:fs'); setTimeout(()=>fs.writeFileSync('descendant-alive.txt','alive'),${DESCENDANT_WRITE_DELAY_MS}); setTimeout(()=>{},15000);`,
    );
    await writeFile(
      join(ws, "parent.cjs"),
      "const {spawn}=require('node:child_process'); spawn(process.execPath,['descendant.cjs'],{stdio:'ignore'}); setTimeout(()=>{},15000);",
    );

    const result = await runCommand({ workspacePath: ws, command: "node parent.cjs", timeoutMs: 150 });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.output).toContain("timed out");
    await new Promise((resolve) => setTimeout(resolve, ASSERT_AFTER_MS));
    expect(existsSync(join(ws, "descendant-alive.txt"))).toBe(false);
  }, 20000);
});

/**
 * "Nothing to verify" and "verification failed" are different facts.
 *
 * `npm test` in a project with no `test` script exits NON-ZERO with `Missing script: "test"`, which
 * is indistinguishable from a failing suite if you only look at the exit code. That is how a
 * correct, approved edit in a project with no tests ended up failing the whole workflow: the edit
 * landed, npm errored because there was nothing to run, and the engine read that as a broken build.
 *
 * These tests pin both halves of the distinction — the absent case must not fail the workflow, and
 * a genuinely failing command must still fail it.
 */
describe("verification availability vs failure", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "verify-avail-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("reports notConfigured when package.json has no test script", async () => {
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "x", type: "module" }));
    const result = await runVerification(ws);
    expect(result.notConfigured).toBe(true);
    expect(result.failed).toBe(0);
    // Not a pass either: nothing ran, so nothing passed.
    expect(verificationPassed(result)).toBe(false);
    expect(verificationFailed(result)).toBe(false);
  });

  it("reports notConfigured when there is no package.json at all", async () => {
    const result = await runVerification(ws);
    expect(result.notConfigured).toBe(true);
    expect(verificationPassed(result)).toBe(false);
    expect(verificationFailed(result)).toBe(false);
  });

  it("still runs — and still passes — a script that exists", async () => {
    await writeFile(
      join(ws, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }),
    );
    const result = await runVerification(ws, ["npm test"]);
    expect(result.notConfigured).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(verificationPassed(result)).toBe(true);
    expect(verificationFailed(result)).toBe(false);
  });

  it("still FAILS a script that exists and fails — availability is never forgiveness", async () => {
    await writeFile(
      join(ws, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(1)\"" } }),
    );
    const result = await runVerification(ws, ["npm test"]);
    expect(result.notConfigured).toBeFalsy();
    expect(result.exitCode).not.toBe(0);
    expect(verificationPassed(result)).toBe(false);
    expect(verificationFailed(result)).toBe(true);
  });

  it("runs a non-npm command verbatim rather than guessing at availability", async () => {
    const result = await runVerification(ws, ["node -e \"process.exit(0)\""]);
    expect(result.notConfigured).toBeFalsy();
    expect(verificationPassed(result)).toBe(true);
  });

  it("falls through an unavailable command to an available one", async () => {
    await writeFile(
      join(ws, "package.json"),
      JSON.stringify({ name: "x", scripts: { typecheck: "node -e \"process.exit(0)\"" } }),
    );
    const result = await runVerification(ws, ["npm test", "npm run typecheck"]);
    expect(result.notConfigured).toBeFalsy();
    expect(result.command).toContain("typecheck");
    expect(verificationPassed(result)).toBe(true);
  });
});

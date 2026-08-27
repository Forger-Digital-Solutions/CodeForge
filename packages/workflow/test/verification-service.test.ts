import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { prepareShellCommand } from "../src/child-process.js";
import { runCommand, runVerification } from "../src/verification-service.js";

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
    await writeFile(
      join(ws, "descendant.cjs"),
      "const fs=require('node:fs'); setTimeout(()=>fs.writeFileSync('descendant-alive.txt','alive'),700); setTimeout(()=>{},5000);",
    );
    await writeFile(
      join(ws, "parent.cjs"),
      "const {spawn}=require('node:child_process'); spawn(process.execPath,['descendant.cjs'],{stdio:'ignore'}); setTimeout(()=>{},5000);",
    );

    const result = await runCommand({ workspacePath: ws, command: "node parent.cjs", timeoutMs: 150 });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.output).toContain("timed out");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(join(ws, "descendant-alive.txt"))).toBe(false);
  });
});

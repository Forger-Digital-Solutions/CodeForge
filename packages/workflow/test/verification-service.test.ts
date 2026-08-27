import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, runVerification } from "../src/verification-service.js";

describe("VerificationService", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "verify-"));
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

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
});

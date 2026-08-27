import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VerificationResult } from "./types.js";
import { prepareShellCommand, terminateProcessTree } from "./child-process.js";

const DEFAULT_COMMANDS = ["npm test", "npm run typecheck"];

function getSanitizedEnv(): NodeJS.ProcessEnv {
  const allowExact = new Set(["PATH", "HOME", "USER", "USERNAME", "SHELL", "TERM", "LANG", "NODE_ENV", "CI", "TMP", "TEMP", "TMPDIR", "SystemRoot", "WINDIR", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]);
  const denyPrefixes = ["AWS_", "AZURE_", "GCP_", "GOOGLE_", "CLOUDFLARE_"];
  const denySubstrings = ["SECRET", "PASSWORD", "PRIVATE_KEY", "CREDENTIAL", "AUTH_TOKEN", "ACCESS_TOKEN", "REFRESH_TOKEN", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY"];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allowExact.has(k)) {
      out[k] = v;
      continue;
    }
    if (denyPrefixes.some((p) => k.startsWith(p))) continue;
    if (denySubstrings.some((s) => k.includes(s))) continue;
    // allow safe vars by default? keep minimal to reduce exposure; only allow common safe ones
    if (/^(NPM_|YARN_|PNPM_|NODE_|CODEFORGE_|VITEST_)/.test(k)) {
      out[k] = v;
      continue;
    }
    // also allow PATH-related
    if (k === "Path" || k === "PATHEXT") {
      out[k] = v;
      continue;
    }
    // default deny for unknown env to be safe, but keep PATH etc already handled
    // For Windows compatibility, keep COMSPEC, etc
    if (["COMSPEC", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)"].includes(k)) {
      out[k] = v;
    }
  }
  // Ensure PATH exists
  if (!out.PATH && process.env.PATH) out.PATH = process.env.PATH;
  if (!out.Path && process.env.Path) out.Path = process.env.Path;
  return out;
}

function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9\-_]{10,}/g, "[REDACTED]")
    .replace(/sk-proj-[A-Za-z0-9\-_]{10,}/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/OPENCODE_API_KEY\s*[:=]\s*['"]?[^'"\s]+/gi, "OPENCODE_API_KEY=[REDACTED]");
}

function parseTestOutput(output: string): { passed: number; failed: number; skipped: number; failures: Array<{ test: string; message: string }> } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ test: string; message: string }> = [];

  // Vitest / Jest patterns
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  const skipMatch = output.match(/(\d+)\s+skipped/);
  if (passMatch) passed = parseInt(passMatch[1] ?? "0", 10);
  if (failMatch) failed = parseInt(failMatch[1] ?? "0", 10);
  if (skipMatch) skipped = parseInt(skipMatch[1] ?? "0", 10);

  // Fallback: look for FAIL / PASS per test file
  if (passed === 0 && failed === 0) {
    const failLines = output.split("\n").filter((l) => /FAIL|Error|failed/i.test(l));
    if (failLines.length > 0 && /fail/i.test(output)) failed = 1;
    else if (/pass/i.test(output) && !/fail/i.test(output)) passed = 1;
  }

  // Extract failure messages
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/FAIL|Error:/.test(line)) {
      const next = lines.slice(i, i + 3).join("\n").slice(0, 500);
      failures.push({ test: `test-${failures.length + 1}`, message: redactedNext(next) });
      if (failures.length >= 10) break;
    }
  }

  return { passed, failed, skipped, failures };
}

function redactedNext(text: string): string {
  return redact(text).slice(0, 2000);
}

function truncateOutput(text: string, maxBytes = 64 * 1024): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf-8");
  return buf.subarray(0, maxBytes).toString("utf-8") + `\n[TRUNCATED output exceeded ${maxBytes} bytes]`;
}

export interface RunOptions {
  workspacePath: string;
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runCommand(options: RunOptions): Promise<VerificationResult> {
  const { workspacePath, command, timeoutMs = 60000, signal } = options;
  if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new Error(`Workspace not found: ${workspacePath}`);
  }
  const start = Date.now();
  return new Promise((resolve) => {
    let prepared: ReturnType<typeof prepareShellCommand>;
    try {
      prepared = prepareShellCommand(command, getSanitizedEnv(), workspacePath);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      resolve({
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: Date.now() - start,
        output: message,
        exitCode: 1,
        command,
        failures: [{ test: "runtime-resolution", message }],
      });
      return;
    }

    let settled = false;
    let stopReason: "timeout" | "aborted" | null = null;
    let terminationStarted = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let terminationFallback: ReturnType<typeof setTimeout> | null = null;
    const spawnOptions = {
      cwd: workspacePath,
      env: prepared.env,
      windowsHide: true,
      detached: process.platform !== "win32",
    };
    const proc = prepared.shell
      ? spawn(prepared.command, { ...spawnOptions, shell: true })
      : spawn(prepared.command, prepared.args, { ...spawnOptions, shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (terminationFallback) clearTimeout(terminationFallback);
      signal?.removeEventListener("abort", abortHandler);
    };

    const finish = (code: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const captured = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
      const reasonOutput = stopReason === "timeout"
        ? `[Command timed out after ${timeoutMs} ms]`
        : stopReason === "aborted"
          ? "[Command aborted]"
          : "";
      const raw = [reasonOutput, spawnError?.message, captured].filter(Boolean).join("\n");
      const sanitized = redact(raw);
      const truncated = truncateOutput(sanitized);
      const parsed = parseTestOutput(truncated);
      const exitCode = stopReason === "timeout" ? 124 : stopReason === "aborted" ? 130 : (code ?? 1);
      let failed = parsed.failed;
      let passed = parsed.passed;
      if (exitCode !== 0 && failed === 0 && passed === 0) {
        failed = 1;
      }
      if (exitCode === 0 && failed === 0 && passed === 0) {
        passed = 1;
      }
      resolve({
        passed,
        failed,
        skipped: parsed.skipped,
        durationMs: Date.now() - start,
        output: truncated,
        exitCode,
        command,
        failures: stopReason
          ? [{ test: stopReason, message: reasonOutput }]
          : spawnError
            ? [{ test: "spawn-error", message: redact(spawnError.message) }]
            : parsed.failures,
        timedOut: stopReason === "timeout",
        cancelled: stopReason === "aborted",
      });
    };

    const stop = (reason: "timeout" | "aborted"): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      stopReason = reason;
      void terminateProcessTree(proc).finally(() => {
        if (!settled) terminationFallback = setTimeout(() => finish(null), 250);
      });
    };

    const abortHandler = (): void => stop("aborted");
    proc.once("close", (code) => finish(code));
    proc.once("error", (error) => finish(null, error));
    timeout = setTimeout(() => stop("timeout"), timeoutMs);
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

export async function runVerification(
  workspacePath: string,
  commands: string[] = DEFAULT_COMMANDS,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<VerificationResult> {
  // Try commands in order, return first that exists; if none, return synthetic pass
  let lastResult: VerificationResult | null = null;
  for (const cmd of commands) {
    // Cheap check: if command is npm test and no package.json, skip
    if (cmd.includes("npm") && !fs.existsSync(path.join(workspacePath, "package.json"))) {
      continue;
    }
    try {
      const result = await runCommand({ workspacePath, command: cmd, signal: options.signal, timeoutMs: options.timeoutMs });
      lastResult = result;
      // If command succeeded (exit 0) and has passed, return it
      // If failed, return immediately so caller can diagnose
      return result;
    } catch (e) {
      lastResult = {
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: 0,
        output: e instanceof Error ? redact(e.message) : String(e),
        exitCode: 1,
        command: cmd,
        failures: [{ test: cmd, message: e instanceof Error ? e.message : String(e) }],
      };
    }
  }
  if (lastResult) return lastResult;
  return {
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    output: "No verification command applicable; synthetic pass",
    exitCode: 0,
    command: commands[0] ?? "noop",
    failures: [],
  };
}

export function verificationPassed(result: VerificationResult): boolean {
  return result.exitCode === 0 && result.failed === 0;
}

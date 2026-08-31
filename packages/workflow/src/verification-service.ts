import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VerificationResult } from "./types.js";
import { prepareShellCommand, terminateProcessTree } from "./child-process.js";

const DEFAULT_COMMANDS = ["npm test", "npm run typecheck"];

function getSanitizedEnv(): NodeJS.ProcessEnv {
  const allowExact = new Set([
    "PATH", "Path", "path", "PATHEXT", "ComSpec", "COMSPEC",
    "HOME", "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "USERPROFILE",
    "SHELL", "TERM", "LANG", "CI", "TMP", "TEMP", "TMPDIR",
    "SystemDrive", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && allowExact.has(k)) out[k] = v;
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
    proc.once("close", (code) => {
      if (!terminationStarted) finish(code);
    });
    proc.once("error", (error) => finish(null, error));
    timeout = setTimeout(() => stop("timeout"), timeoutMs);
    if (signal?.aborted) {
      abortHandler();
    } else {
      signal?.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

/**
 * Whether a verification command can run in this workspace at all.
 *
 * `npm test` in a project with no `test` script exits NON-ZERO with `Missing script: "test"`. Read
 * as a result that is indistinguishable from a genuine test failure — which is how a successful edit
 * in a project that simply has no test suite ends up failing the whole workflow.
 *
 * "Nothing to run" and "it ran and failed" are different facts and must not collapse into one. This
 * answers only the first, from the manifest, before anything is executed. It never inspects the
 * outcome of a command, so a real failing test can never be reclassified as unavailable.
 */
function commandIsAvailable(workspacePath: string, command: string): boolean {
  const npm = command.trim().match(/^npm\s+(?:run\s+(\S+)|(test|start))\b/);
  if (!npm) return true; // Not an npm script; assume the operator meant it and let it run.

  const manifestPath = path.join(workspacePath, "package.json");
  if (!fs.existsSync(manifestPath)) return false;

  const scriptName = npm[1] ?? npm[2];
  if (!scriptName) return true;
  // `npm start` has a documented default (node server.js); `npm test` does not.
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { scripts?: Record<string, unknown> };
    return typeof manifest.scripts?.[scriptName] === "string";
  } catch {
    // A manifest we cannot parse is a genuine problem, but it is not this function's to diagnose:
    // let the command run and report what actually happens.
    return true;
  }
}

/** An honest "nothing was verified" result — neither a pass nor a failure. */
function notConfiguredResult(commands: string[]): VerificationResult {
  return {
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    output: `No verification command is configured for this workspace (tried: ${commands.join(", ") || "none"}).`,
    exitCode: 0,
    command: "",
    failures: [],
    notConfigured: true,
  };
}

export async function runVerification(
  workspacePath: string,
  commands: string[] = DEFAULT_COMMANDS,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<VerificationResult> {
  let lastResult: VerificationResult | null = null;
  for (const cmd of commands) {
    // Skip commands this workspace cannot run. Skipping is NOT forgiveness: a command that runs and
    // fails is still returned immediately below so the caller can diagnose and repair it.
    if (!commandIsAvailable(workspacePath, cmd)) continue;
    try {
      const result = await runCommand({ workspacePath, command: cmd, signal: options.signal, timeoutMs: options.timeoutMs });
      lastResult = result;
      // Whether it passed or failed, this workspace really did verify — report it verbatim.
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
  return notConfiguredResult(commands);
}

/**
 * True only when verification actually RAN and passed. A workspace with nothing to run has not
 * passed anything, so it must not claim it did — the workflow reports honestly that it could not
 * verify, rather than presenting an unverified edit as a verified one.
 */
export function verificationPassed(result: VerificationResult): boolean {
  if (result.notConfigured) return false;
  return result.exitCode === 0 && result.failed === 0;
}

/** True when verification ran and produced a real failure that should block completion. */
export function verificationFailed(result: VerificationResult): boolean {
  if (result.notConfigured) return false;
  return result.exitCode !== 0 || result.failed > 0;
}

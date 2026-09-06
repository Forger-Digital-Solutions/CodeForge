import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VerificationResult } from "./types.js";
import { prepareShellCommand, terminateProcessTree } from "./child-process.js";
import {
  adaptTrustedLegacyVerifiers,
  createVerificationPlan,
  createVerifierRegistry,
  executeVerificationPlan,
  type ForgeVerifyObserver,
  type VerificationPolicy,
} from "./forge-verify.js";

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

  // Node's built-in test runner reports counters as `pass N`, `fail N`, and `skipped N`.
  const nodePassMatch = output.match(/\bpass\s+(\d+)\b/i);
  const nodeFailMatch = output.match(/\bfail\s+(\d+)\b/i);
  const nodeSkipMatch = output.match(/\bskipped\s+(\d+)\b/i);
  if (!passMatch && nodePassMatch) passed = parseInt(nodePassMatch[1] ?? "0", 10);
  if (!failMatch && nodeFailMatch) failed = parseInt(nodeFailMatch[1] ?? "0", 10);
  if (!skipMatch && nodeSkipMatch) skipped = parseInt(nodeSkipMatch[1] ?? "0", 10);

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
export function commandIsAvailable(workspacePath: string, command: string): boolean {
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

export function classifyVerifier(command: string): { kind: import("./types.js").VerifierKind; required: boolean } {
  const lower = command.toLowerCase().trim();
  if (/\b(test|jest|vitest|mocha|pytest)\b|\bcargo test\b|\bgo test\b/.test(lower)) {
    return { kind: "test", required: true };
  }
  if (/\b(typecheck|tsc|pyright|mypy)\b|\bnpm run check\b|\bcargo check\b/.test(lower)) {
    return { kind: "typecheck", required: true };
  }
  if (/\b(build|compile|bundle)\b/.test(lower) && !/\.js\b|\.ts\b/.test(lower)) {
    return { kind: "build", required: true };
  }
  if (/\b(lint|eslint|prettier|flake8|ruff|clippy)\b/.test(lower)) {
    return { kind: "lint", required: false };
  }
  return { kind: "custom", required: true };
}

export function discoverVerifiers(workspacePath: string, configuredCommands?: string[]): import("./types.js").Verifier[] {
  if (configuredCommands && configuredCommands.length > 0) {
    const list: import("./types.js").Verifier[] = [];
    for (let i = 0; i < configuredCommands.length; i++) {
      const cmd = configuredCommands[i]!.trim();
      if (!cmd) continue;
      const { kind, required } = classifyVerifier(cmd);
      list.push({
        id: `verifier-${i + 1}-${kind}`,
        kind,
        command: cmd,
        required,
        source: "configured",
      });
    }
    return list;
  }

  const manifestPath = path.join(workspacePath, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { scripts?: Record<string, unknown> };
    const scripts = manifest.scripts ?? {};
    const verifiers: import("./types.js").Verifier[] = [];

    // 1. Test verifier (required)
    if (typeof scripts.test === "string" && !scripts.test.includes("no test specified")) {
      verifiers.push({
        id: "test",
        kind: "test",
        command: "npm test",
        required: true,
        source: "discovered",
      });
    }

    // 2. Typecheck verifier (required)
    if (typeof scripts.typecheck === "string") {
      verifiers.push({
        id: "typecheck",
        kind: "typecheck",
        command: "npm run typecheck",
        required: true,
        source: "discovered",
      });
    } else if (typeof scripts.tsc === "string") {
      verifiers.push({
        id: "typecheck",
        kind: "typecheck",
        command: "npm run tsc",
        required: true,
        source: "discovered",
      });
    } else if (typeof scripts.check === "string") {
      verifiers.push({
        id: "typecheck",
        kind: "typecheck",
        command: "npm run check",
        required: true,
        source: "discovered",
      });
    }

    // 3. Build verifier (required)
    if (typeof scripts.build === "string") {
      verifiers.push({
        id: "build",
        kind: "build",
        command: "npm run build",
        required: true,
        source: "discovered",
      });
    }

    // 4. Lint verifier (advisory)
    if (typeof scripts.lint === "string") {
      verifiers.push({
        id: "lint",
        kind: "lint",
        command: "npm run lint",
        required: false,
        source: "discovered",
      });
    }

    return verifiers;
  } catch {
    return [];
  }
}

/** An honest "nothing was verified" result — neither a pass nor a failure. */
function notConfiguredReport(commands: string[]): import("./types.js").VerificationReport {
  return {
    verifiers: [],
    requiredPassed: false,
    hasFailures: false,
    advisories: [],
    overallStatus: "blocked",
    summary: `No verification command is configured for this workspace (tried: ${commands.join(", ") || "none"}).`,
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
  commandsOrVerifiers: string[] | import("./types.js").Verifier[] = DEFAULT_COMMANDS,
  options: { signal?: AbortSignal; timeoutMs?: number; runId?: string; observer?: ForgeVerifyObserver; executionRevision?: number } = {},
): Promise<import("./types.js").VerificationReport> {
  let verifiers: import("./types.js").Verifier[] = [];
  if (Array.isArray(commandsOrVerifiers) && commandsOrVerifiers.length > 0) {
    if (typeof commandsOrVerifiers[0] === "string") {
      const isDefault = commandsOrVerifiers.length === 2 && commandsOrVerifiers[0] === "npm test" && commandsOrVerifiers[1] === "npm run typecheck";
      if (isDefault) {
        verifiers = discoverVerifiers(workspacePath);
      } else {
        verifiers = discoverVerifiers(workspacePath, commandsOrVerifiers as string[]);
      }
    } else {
      verifiers = commandsOrVerifiers as import("./types.js").Verifier[];
    }
  } else {
    verifiers = discoverVerifiers(workspacePath);
  }

  // Filter only available commands in workspace
  const availableVerifiers = verifiers.filter((v) => commandIsAvailable(workspacePath, v.command));

  if (availableVerifiers.length === 0) {
    return notConfiguredReport(verifiers.map((v) => v.command));
  }

  const definitions = adaptTrustedLegacyVerifiers(workspacePath, availableVerifiers.map((verifier) => ({ ...verifier, timeoutMs: verifier.timeoutMs ?? options.timeoutMs })));
  const registry = createVerifierRegistry(definitions);
  const policy: VerificationPolicy = { version: "legacy-workflow-policy-v1" as VerificationPolicy["version"] };
  const plan = createVerificationPlan(registry, policy, { runId: options.runId ?? `legacy-${Date.now()}`, workspacePath, scope: "workspace", ...(options.executionRevision !== undefined ? { executionRevision: options.executionRevision } : {}) });
  const execution = await executeVerificationPlan(registry, plan, undefined, { signal: options.signal, observer: options.observer });
  const runResults = availableVerifiers.map((verifier, index) => {
    const planned = plan.verifiers[index]!;
    const evidence = execution.evidence.find((item) => item.verifierId === planned.verifierId);
    const parsed = parseTestOutput(evidence?.outputExcerpt ?? "");
    const status = evidence?.status ?? "infra_error";
    const passed = status === "passed" ? Math.max(parsed.passed, 1) : parsed.passed;
    const failed = status === "passed" ? parsed.failed : Math.max(parsed.failed, 1);
    return {
      id: verifier.id,
      kind: verifier.kind,
      command: verifier.command,
      required: verifier.required,
      status,
      passed,
      failed,
      skipped: parsed.skipped,
      exitCode: evidence?.exitCode ?? 1,
      durationMs: evidence?.elapsedMs ?? 0,
      output: evidence?.outputExcerpt ?? "Verifier did not create evidence.",
      failures: status === "passed" ? parsed.failures : [{ test: verifier.id, message: evidence?.outputExcerpt || `Verifier ended ${status}.` }],
      timedOut: status === "timed_out",
      cancelled: status === "cancelled",
    } satisfies import("./types.js").VerifierRunResult;
  });
  const totalPassed = runResults.reduce((total, result) => total + result.passed, 0);
  const totalFailed = runResults.reduce((total, result) => total + result.failed, 0);
  const totalSkipped = runResults.reduce((total, result) => total + result.skipped, 0);
  const totalDurationMs = runResults.reduce((total, result) => total + result.durationMs, 0);
  const allOutputs = runResults.map((result) => `=== [${result.id.toUpperCase()}] ${result.command} ===\n${result.output}`);
  const allFailures = runResults.flatMap((result) => result.failures);
  const requiredPassed = execution.summary.verificationComplete;
  const hasFailures = runResults.some((result) => result.status !== "passed");
  const advisories = runResults.filter((result) => !result.required && result.status !== "passed");
  const overallStatus = !requiredPassed ? "failed" : "passed";

  const summary = `ForgeVerify: ${runResults.filter((r) => r.status === "passed").length}/${runResults.length} verifiers passed (${requiredPassed ? "all required passed" : "required verifier failed"}).`;

  return {
    verifiers: runResults,
    requiredPassed,
    hasFailures,
    advisories,
    overallStatus,
    summary,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    durationMs: totalDurationMs,
    output: allOutputs.join("\n\n"),
    exitCode: requiredPassed ? 0 : 1,
    command: availableVerifiers.map((v) => v.command).join(" && "),
    failures: allFailures,
    forgeVerify: { plan, ...execution },
  };
}

/**
 * True only when verification actually RAN and passed all required verifiers.
 */
export function verificationPassed(result: VerificationResult): boolean {
  if (result.notConfigured) return false;
  const report = result as unknown as import("./types.js").VerificationReport;
  if (report.verifiers && Array.isArray(report.verifiers)) {
    return report.requiredPassed === true;
  }
  return result.exitCode === 0 && result.failed === 0;
}

/** True when verification ran and produced a real failure that should block completion. */
export function verificationFailed(result: VerificationResult): boolean {
  if (result.notConfigured) return false;
  const report = result as unknown as import("./types.js").VerificationReport;
  if (report.verifiers && Array.isArray(report.verifiers)) {
    return report.requiredPassed === false;
  }
  return result.exitCode !== 0 || result.failed > 0;
}

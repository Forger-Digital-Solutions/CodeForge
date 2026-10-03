import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stripAnsi, stripCommandEcho } from "./ansi.js";
import { commandShell, resolveExecutable } from "./shells.js";
import { buildHostedCommandLine, needsConsoleHost } from "./console-host.js";
import { loadPty, teardownPty, type PtyLike } from "./pty-loader.js";

/**
 * Headless command execution with zero external console windows.
 *
 * On Windows the legacy pipe path hid the immediate child (`windowsHide`) but every
 * console-subsystem GRANDCHILD — npm script shims, `cmd /c` inside npm, console apps —
 * allocated a fresh visible console: the transient-terminal flash. Running the command
 * inside a ConPTY pseudo console fixes it architecturally — the pseudo console is
 * invisible and inherited by the whole process tree.
 *
 * POSIX has no console windows, and a missing node-pty degrades to the previous pipe
 * behavior: ConPTY is a strict improvement where it exists, never a new requirement.
 */

export type ExecutionBackend = "conpty" | "pipe";
export type OutputStream = "stdout" | "stderr";

const PROCESS_TREE_SETTLE_GRACE_MS = 2_000;

/**
 * What to run. Either `commandLine` (a full shell command line executed via the
 * platform command shell) or `file` + `args` (a direct executable spawn).
 * Callers that need PATH normalization / Electron-as-Node resolution should run
 * `prepareShellCommand` first and hand the result to `executePrepared`.
 */
export interface ExecSpec {
  commandLine?: string;
  file?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  cols?: number;
  /** Under ConPTY streams are merged; every chunk arrives labelled "stdout". */
  onOutput?: (chunk: string, stream: OutputStream) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Merged stdout+stderr in arrival order (pipe) or the single pty stream (conpty). */
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the process could not be launched at all. */
  spawnError?: string;
  backend: ExecutionBackend;
}

/** Structural match for workflow's PreparedShellCommand — avoids a package dependency. */
export interface PreparedSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export function backendFor(platform: NodeJS.Platform = process.platform): ExecutionBackend {
  return platform === "win32" && loadPty() !== null ? "conpty" : "pipe";
}

export function execute(spec: ExecSpec): Promise<ExecResult> {
  if (!spec.commandLine && !spec.file) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "",
      output: "",
      durationMs: 0,
      timedOut: false,
      cancelled: false,
      spawnError: "execute() requires either commandLine or file",
      backend: backendFor(),
    });
  }
  return backendFor() === "conpty" ? executeViaConpty(spec) : executeViaPipe(spec);
}

export function executePrepared(prepared: PreparedSpec, spec: Omit<ExecSpec, "commandLine" | "file" | "args" | "env"> = {}): Promise<ExecResult> {
  return execute(prepared.shell
    ? { ...spec, commandLine: prepared.command, env: prepared.env }
    : { ...spec, file: prepared.command, args: prepared.args, env: prepared.env });
}

// ---------------------------------------------------------------------------
// ConPTY path (Windows, node-pty present)
// ---------------------------------------------------------------------------

const EXIT_SENTINEL_PREFIX = "__CFX_";
const EXIT_SENTINEL_RE = /__CFX_[A-Za-z0-9]+_(\d+)\r?\n?/;

async function executeViaConpty(input: ExecSpec): Promise<ExecResult> {
  const ptyModule = loadPty();
  if (!ptyModule) return executeViaPipe(input);
  const start = Date.now();

  const env = input.env ?? process.env;
  // A GUI-subsystem image (the Electron runtime as Node) cannot be the pty root: it gets no
  // console, so its console children open visible windows. Host it under cmd.exe instead so the
  // pseudo console is inherited all the way down — see console-host.ts.
  const hostedFile = !input.commandLine && input.file ? resolveExecutable(input.file, env) ?? input.file : null;
  const hosted = Boolean(hostedFile && needsConsoleHost(hostedFile));
  const spec: ExecSpec = hosted
    ? { ...input, commandLine: buildHostedCommandLine(hostedFile!, input.args ?? []), file: undefined, args: undefined }
    : input;
  const rawFile = spec.commandLine ? commandShell(env).file : spec.file!;
  // node-pty does not PATH-search; resolve bare names before spawning.
  const file = resolveExecutable(rawFile, env) ?? rawFile;
  // Per-invocation sentinel: `cmd /v:on` delayed expansion makes !errorlevel! evaluate
  // at echo time, so the real exit code arrives IN THE OUTPUT STREAM when the command
  // finishes — node-pty's ConPTY onExit lags 1.5–3.5s behind the actual process exit
  // and is only a fallback here.
  const sentinel = `${EXIT_SENTINEL_PREFIX}${randomUUID().replace(/-/g, "")}`;
  // /s removes only the outer command quotes, preserving a quoted executable path
  // even when the command also contains quoted arguments or shell operators.
  const args: string | string[] = spec.commandLine
    ? `/d /v:on /s /c "${spec.commandLine} & echo ${sentinel}_!errorlevel!"`
    : (spec.args ?? []);

  return new Promise<ExecResult>((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let terminationStarted = false;
    let terminationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let sentinelCode: number | null = null;
    let p: PtyLike;
    try {
      p = ptyModule.spawn(file, args, {
        name: "xterm-color",
        cols: spec.cols ?? 200,
        rows: 30,
        cwd: spec.cwd,
        env: env as Record<string, string>,
        useConpty: true,
      });
    } catch (error) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "",
        output: "",
        durationMs: Date.now() - start,
        timedOut: false,
        cancelled: false,
        spawnError: error instanceof Error ? error.message : String(error),
        backend: "conpty",
      });
      return;
    }

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (terminationSettleTimer) clearTimeout(terminationSettleTimer);
      abortListener?.();
      dataListener?.dispose();
      exitListener?.dispose();
      // Defer teardown a beat so trailing output still in the conout pipe is delivered,
      // then release the agent handles — node-pty's dll kill() only disposes its conout
      // worker when further data arrives, so a quiet exit would leak a worker_thread and
      // pin the event loop.
      setTimeout(() => teardownPty(p), 50);
      const code = timedOut ? 124 : cancelled ? 130 : exitCode;
      const stripped = spec.commandLine
        ? stripCommandEcho(stripAnsi(output), spec.commandLine)
        : stripAnsi(output);
      resolve({
        exitCode: code,
        stdout: stripped,
        stderr: "",
        output: stripped,
        durationMs: Date.now() - start,
        timedOut,
        cancelled,
        backend: "conpty",
      });
    };

    const stop = (): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (timer) clearTimeout(timer);
      // taskkill /T /F on the pty's root pid kills the whole tree; p.kill() would race
      // it — its console-list agent crashes once the console is already destroyed.
      terminateProcessTreeByPid(p.pid);
      // ConPTY teardown is asynchronous; wait for exit event with bounded fallback.
      terminationSettleTimer = setTimeout(() => finish(1), PROCESS_TREE_SETTLE_GRACE_MS);
    };

    const timer = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, spec.timeoutMs)
      : null;

    let abortListener: (() => void) | null = null;
    if (spec.signal) {
      const onAbort = (): void => {
        cancelled = true;
        stop();
      };
      if (spec.signal.aborted) {
        onAbort();
      } else {
        spec.signal.addEventListener("abort", onAbort, { once: true });
        abortListener = () => spec.signal!.removeEventListener("abort", onAbort);
      }
    }

    const dataListener = p.onData((chunk) => {
      output += chunk;
      if (!spec.commandLine || sentinelCode !== null) {
        spec.onOutput?.(chunk, "stdout");
        return;
      }
      // Sentinel carries the real exit code in-stream; strip it before it reaches callers.
      const match = EXIT_SENTINEL_RE.exec(output);
      if (match) {
        sentinelCode = Number(match[1]);
        output = output.replace(EXIT_SENTINEL_RE, "");
        spec.onOutput?.(chunk, "stdout");
        // Command is done — don't wait on node-pty's lagging exit detection.
        setTimeout(() => finish(sentinelCode!), 10);
      } else {
        spec.onOutput?.(chunk, "stdout");
      }
    });
    const exitListener = p.onExit(({ exitCode }) => finish(sentinelCode ?? exitCode));
  });
}

// ---------------------------------------------------------------------------
// Pipe fallback (POSIX, or Windows without node-pty)
// ---------------------------------------------------------------------------

async function executeViaPipe(spec: ExecSpec): Promise<ExecResult> {
  const start = Date.now();

  return new Promise<ExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let output = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let terminationStarted = false;
    let terminationSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const spawnOptions = {
      cwd: spec.cwd,
      windowsHide: true,
      env: spec.env ?? process.env,
      detached: process.platform !== "win32",
    };

    let child: ChildProcess;
    try {
      child = spec.commandLine
        ? spawn(spec.commandLine, { ...spawnOptions, shell: true })
        : spawn(spec.file!, spec.args ?? [], { ...spawnOptions, shell: false });
    } catch (error) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "",
        output: "",
        durationMs: Date.now() - start,
        timedOut: false,
        cancelled: false,
        spawnError: error instanceof Error ? error.message : String(error),
        backend: "pipe",
      });
      return;
    }

    const finish = (code: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (terminationSettleTimer) clearTimeout(terminationSettleTimer);
      abortListener?.();
      const exitCode = timedOut ? 124 : cancelled ? 130 : (code ?? 1);
      resolve({
        exitCode,
        stdout,
        stderr,
        output: output || [stdout, stderr].filter(Boolean).join(""),
        durationMs: Date.now() - start,
        timedOut,
        cancelled,
        spawnError: spawnError?.message,
        backend: "pipe",
      });
    };

    const stop = (): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (timer) clearTimeout(timer);
      if (child.pid) terminateProcessTreeByPid(child.pid);
      // taskkill is synchronous, but Windows can release descendants' file handles slightly
      // after it returns. Keep the timeout/cancelled result, while waiting for `close` before
      // resolving so ForgeVerify callers can safely remove an isolated workspace.
      terminationSettleTimer = setTimeout(() => finish(null), PROCESS_TREE_SETTLE_GRACE_MS);
    };

    const timer = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, spec.timeoutMs)
      : null;

    let abortListener: (() => void) | null = null;
    if (spec.signal) {
      const onAbort = (): void => {
        cancelled = true;
        stop();
      };
      if (spec.signal.aborted) {
        onAbort();
      } else {
        spec.signal.addEventListener("abort", onAbort, { once: true });
        abortListener = () => spec.signal!.removeEventListener("abort", onAbort);
      }
    }

    child.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      output += chunk;
      spec.onOutput?.(chunk, "stdout");
    });
    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      output += chunk;
      spec.onOutput?.(chunk, "stderr");
    });
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Process-tree termination
// ---------------------------------------------------------------------------

export function terminateProcessTreeByPid(pid: number): void {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    try {
      const killed = spawnSync(path.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      // Managed Windows process isolation can reject taskkill for a direct child even though
      // Node is still allowed to terminate that child itself. Treat every non-zero taskkill
      // result as a failed tree kill so timeout settlement never leaves the root alive.
      if (killed.error || killed.status !== 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

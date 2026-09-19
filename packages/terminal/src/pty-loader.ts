import { createRequire } from "node:module";

/**
 * node-pty is an optional dependency: a plain `forge serve` install keeps working without it,
 * and only the ConPTY-backed features (zero-console-flash command execution on Windows, the
 * interactive terminal) need it. Everything in this package degrades to pipes when it is absent.
 */

export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  useConpty?: boolean;
  useConptyDll?: boolean;
  conptyInheritCursor?: boolean;
}

type PtyModule = {
  spawn(file: string, args: string[] | string, opts: PtySpawnOptions): PtyLike;
};

let cached: PtyModule | null | undefined;

/** Loads node-pty once per process; null when unavailable (missing optional dep or ABI mismatch). */
export function loadPty(): PtyModule | null {
  if (cached !== undefined) return cached;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node-pty") as PtyModule;
    if (typeof mod?.spawn !== "function") {
      cached = null;
    } else {
      cached = mod;
    }
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * ConPTY exists on Windows 10 1809+. node-pty's useConpty option is only meaningful on win32;
 * everywhere else the flag is ignored, so "supported" really means "Windows and node-pty loads".
 */
export function conptySupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && loadPty() !== null;
}

/** Test hook: force the cached module state. */
export function __setPtyModuleForTest(mod: PtyModule | null | undefined): void {
  cached = mod;
}

interface PtyAgentInternals {
  _pty?: number;
  _ptyNative?: { kill(pty: number, useConptyDll?: boolean): void };
  _useConptyDll?: boolean;
  _inSocket?: { destroy(): void };
  _outSocket?: { destroy(): void };
  _conoutSocketWorker?: { dispose(): void };
}

/**
 * Release a finished/killed pty's agent handles WITHOUT going through p.kill(). On the
 * non-dll ConPTY path kill() forks conpty_console_list_agent, which crashes with
 * "AttachConsole failed" once the console is already gone; on the dll path kill() only
 * disposes its conout reader worker when more data arrives, so a quiet exit leaks a
 * worker_thread and pins the event loop. Do the equivalent teardown directly.
 */
export function teardownPty(p: PtyLike): void {
  const agent = (p as unknown as { _agent?: PtyAgentInternals })._agent;
  try { agent?._ptyNative?.kill(agent._pty ?? -1, agent._useConptyDll); } catch { /* best effort */ }
  try { agent?._conoutSocketWorker?.dispose(); } catch { /* best effort */ }
  try { agent?._outSocket?.destroy(); } catch { /* best effort */ }
  try { agent?._inSocket?.destroy(); } catch { /* best effort */ }
  // Fallback for shapes that don't expose internals.
  if (!agent) {
    try { p.kill(); } catch { /* already gone */ }
  }
}

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

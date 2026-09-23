import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import path from "node:path";
import { execute, type ExecResult, type ExecSpec } from "./executor.js";

/**
 * First-class Windows Subsystem for Linux execution.
 *
 * A command's execution environment is part of its authority: `run_command` on
 * Windows and `run_command` in WSL are different machines sharing a filesystem
 * view. This module makes the environment explicit — detection, distro
 * discovery, and path translation all fail closed, so a WSL request can never
 * silently land in the distro's home directory while the caller believes it ran
 * in the workspace (stock `wsl.exe` does exactly that when the cwd drive is not
 * WSL-mappable).
 *
 * Confinement is unchanged: callers pass a Windows workspace path that has
 * already been resolved inside the workspace; it is translated to `/mnt/<drive>/…`
 * here. Linux-native paths are never accepted as a cwd — that would bypass the
 * workspace boundary the Windows side enforces.
 */

export interface WslDistro {
  name: string;
  isDefault: boolean;
  state?: string;
  version?: number;
}

export type WslUnavailableReason =
  | "not_windows"
  | "wsl_exe_missing"
  | "query_failed"
  | "no_distros";

export interface WslDetection {
  available: boolean;
  reason?: WslUnavailableReason;
  detail?: string;
  distros: WslDistro[];
}

type SpawnProbe = (file: string, args: string[], options: SpawnSyncOptions) => {
  status: number | null;
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
  error?: Error;
};

const DEFAULT_WSL_EXE = "wsl.exe";
let cachedDetection: { key: string; detection: WslDetection } | undefined;

function decodeWslOutput(raw: Buffer | string | null | undefined): string {
  if (!raw) return "";
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  // wsl.exe writes UTF-16LE; a BOM or dense NUL bytes identify it.
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || buf[1] === 0)) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

function parseDistroList(output: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^name\s+state\s+version/i.test(trimmed)) continue;
    const isDefault = trimmed.startsWith("*");
    const body = (isDefault ? trimmed.slice(1) : trimmed).trim();
    if (!body) continue;
    const parts = body.split(/\s+/);
    const name = parts[0];
    if (!name) continue;
    const version = Number(parts[parts.length - 1]);
    distros.push({
      name,
      isDefault,
      state: parts.length >= 3 ? parts[1] : undefined,
      version: Number.isFinite(version) ? version : undefined,
    });
  }
  return distros;
}

/**
 * Enumerate installed WSL distros. Cached for the process lifetime — distro
 * installation is not a per-command event; `__resetWslCacheForTest` clears it.
 */
export function detectWsl(
  probe?: SpawnProbe,
  platform: NodeJS.Platform = process.platform,
): WslDetection {
  const key = `${platform}:${probe ? "injected" : "real"}`;
  if (cachedDetection?.key === key) return cachedDetection.detection;

  const run = probe ?? ((file: string, args: string[], options: SpawnSyncOptions) => spawnSync(file, args, options));
  const unavailable = (reason: WslUnavailableReason, detail?: string): WslDetection => {
    const detection: WslDetection = { available: false, reason, detail, distros: [] };
    if (!probe) cachedDetection = { key, detection };
    return detection;
  };

  if (platform !== "win32") return unavailable("not_windows");

  let result: ReturnType<SpawnProbe>;
  try {
    result = run(DEFAULT_WSL_EXE, ["--list", "--verbose"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
  } catch (error) {
    return unavailable("wsl_exe_missing", error instanceof Error ? error.message : String(error));
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return unavailable(code === "ENOENT" ? "wsl_exe_missing" : "query_failed", result.error.message);
  }
  if (result.status !== 0) {
    return unavailable("query_failed", decodeWslOutput(result.stderr) || `wsl.exe exited ${result.status ?? "unknown"}`);
  }

  const distros = parseDistroList(decodeWslOutput(result.stdout));
  if (distros.length === 0) return unavailable("no_distros");
  const detection: WslDetection = { available: true, distros };
  if (!probe) cachedDetection = { key, detection };
  return detection;
}

export function defaultWslDistro(detection: WslDetection): string | undefined {
  return detection.distros.find((d) => d.isDefault)?.name ?? detection.distros[0]?.name;
}

/**
 * `C:\foo\bar` → `/mnt/c/foo/bar`. Returns null when the path is not a plain
 * local drive path (UNC shares, already-Linux paths, drive-relative paths) —
 * those either translate wrongly or escape the workspace model.
 */
export function windowsPathToWsl(winPath: string): string | null {
  const normalized = path.win32.normalize(winPath);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(normalized);
  if (!match || !match[1]) return null;
  const rest = (match[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/**
 * `/mnt/c/foo` → `C:\foo`; anything else maps through the `\\wsl.localhost\<distro>`
 * namespace so a Linux-native path stays honest about where it lives.
 */
export function wslPathToWindows(lxPath: string, distro: string): string | null {
  const normalized = lxPath.trim();
  if (!normalized.startsWith("/")) return null;
  const mnt = /^\/mnt\/([a-z])(\/.*)?$/.exec(normalized);
  if (mnt && mnt[1]) {
    const rest = (mnt[2] ?? "").replace(/\//g, "\\");
    return `${mnt[1].toUpperCase()}:${rest}`;
  }
  return `\\\\wsl.localhost\\${distro}${normalized.replace(/\//g, "\\")}`;
}

export interface WslExecOptions {
  distro?: string;
  /** Windows path already confined inside the workspace. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: ExecSpec["onOutput"];
}

export interface WslExecResult extends ExecResult {
  environment: "wsl";
  distro?: string;
  /** The Linux cwd the command actually ran in, when one was requested. */
  linuxCwd?: string;
  unavailableReason?: WslUnavailableReason;
}

function wslFailure(reason: WslUnavailableReason | "path_unmappable" | "distro_missing", detail: string): WslExecResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    output: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    spawnError: `[${reason === "path_unmappable" ? "WSL_PATH_UNMAPPABLE" : reason === "distro_missing" ? "WSL_DISTRO_MISSING" : "WSL_UNAVAILABLE"}] ${detail}`,
    backend: "pipe",
    environment: "wsl",
    unavailableReason: reason === "path_unmappable" || reason === "distro_missing" ? undefined : reason,
  };
}

const WSL_CWD_MISSING_MARKER = "__CF_WSL_CWD_MISSING__";
const WSL_CWD_MISSING_EXIT = 203;

/**
 * Run `command` inside a WSL distro at `cwd` (a confined Windows path).
 * `wsl.exe --cd` only warns when the directory is unreachable — the command then
 * runs in the distro home with exit 0, a silent environment/cwd mix. The cd is
 * therefore performed inside the login shell behind a marker guard, so an
 * unmappable workspace deterministically fails as WSL_PATH_UNMAPPABLE instead.
 * The distro's `/bin/bash -lc` supplies the login PATH; the Windows process env
 * is not inherited into Linux — WSL builds its own environment.
 */
export async function execInWsl(command: string, options: WslExecOptions = {}): Promise<WslExecResult> {
  const detection = detectWsl();
  if (!detection.available) {
    return wslFailure(detection.reason ?? "query_failed", detection.detail ?? "WSL is not available on this host");
  }
  const distro = options.distro ?? defaultWslDistro(detection);
  if (!distro) return wslFailure("no_distros", "No WSL distribution is installed");
  if (!detection.distros.some((d) => d.name === distro)) {
    return wslFailure("distro_missing", `WSL distribution "${distro}" is not installed (have: ${detection.distros.map((d) => d.name).join(", ")})`);
  }

  let linuxCwd: string | undefined;
  let shellCommand = command;
  if (options.cwd) {
    const translated = windowsPathToWsl(options.cwd);
    if (!translated) {
      return wslFailure("path_unmappable", `Cannot map workspace path "${options.cwd}" into WSL — only local drive paths are supported`);
    }
    linuxCwd = translated;
    const quotedCwd = `'${translated.replace(/'/g, `'\\''`)}'`;
    shellCommand = `cd ${quotedCwd} 2>/dev/null || { echo ${WSL_CWD_MISSING_MARKER}; exit ${WSL_CWD_MISSING_EXIT}; }\n${command}`;
  }

  const result = await execute({
    file: DEFAULT_WSL_EXE,
    args: ["-d", distro, "--exec", "/bin/bash", "-lc", shellCommand],
    // wsl.exe translates the spawn cwd before anything runs; an unmappable parent
    // cwd only emits a misleading "Failed to translate" warning — run from a
    // drive that is always mounted inside WSL.
    cwd: process.env.SystemRoot ?? "C:\\Windows",
    env: options.env,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: options.onOutput,
  });
  if (result.output.includes(WSL_CWD_MISSING_MARKER) || result.exitCode === WSL_CWD_MISSING_EXIT) {
    return {
      ...result,
      spawnError: `[WSL_PATH_UNMAPPABLE] Workspace path "${options.cwd}" does not exist inside WSL distro "${distro}" (translated: ${linuxCwd}) — the command was not run`,
      environment: "wsl",
      distro,
      linuxCwd,
    };
  }
  return { ...result, environment: "wsl", distro, linuxCwd };
}

/** Test hook. */
export function __resetWslCacheForTest(): void {
  cachedDetection = undefined;
}

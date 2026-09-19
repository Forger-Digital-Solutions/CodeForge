import fs from "node:fs";
import path from "node:path";

/**
 * Shell selection for both the interactive terminal and headless command execution.
 * Never assumes PowerShell 7 exists; probe PATH once and cache.
 */

const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe", "cmd.exe"] as const;

function onPath(executable: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  for (const entry of pathVar.split(path.delimiter)) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    const candidate = path.join(dir, executable);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

let cachedWindowsShell: { pathKey: string; shell: string } | undefined;

/** Interactive shell for the user terminal: pwsh → powershell → cmd. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const pathKey = env.PATH ?? env.Path ?? env.path ?? "";
    if (cachedWindowsShell?.pathKey === pathKey) return cachedWindowsShell.shell;
    for (const candidate of WINDOWS_SHELL_CANDIDATES) {
      const found = onPath(candidate, env);
      if (found) {
        cachedWindowsShell = { pathKey, shell: found };
        return found;
      }
    }
    const fallback = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    cachedWindowsShell = { pathKey, shell: fallback };
    return fallback;
  }
  return env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
}

/**
 * Host for a one-shot command line inside a PTY. cmd.exe /d /c is used even when pwsh is
 * present: `cmd /c` has no profile/script-policy surface and its argument quoting matches
 * what the previous `shell: true` pipe path executed.
 */
export function commandShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") {
    const configured = env.ComSpec ?? env.COMSPEC;
    const file = (configured && resolveExecutable(configured, env)) || resolveExecutable("cmd.exe", env) || configured || "cmd.exe";
    return { file, args: ["/d", "/c"] };
  }
  const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
  return { file: shell, args: ["-c"] };
}

/**
 * node-pty does not perform PATH lookup — a bare `node` fails with "File not found".
 * Resolve to an absolute path via PATH + PATHEXT (Windows) or PATH (POSIX). Returns the
 * input unchanged when it already looks like a path, or null when nothing resolves.
 */
export function resolveExecutable(executable: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!executable) return null;
  if (/[\\/]/.test(executable)) {
    try {
      return fs.statSync(executable).isFile() ? executable : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const hasExt = path.extname(executable).length > 0;
    const names = hasExt ? [executable] : [executable, ...pathext.map((ext) => `${executable}${ext.toLowerCase()}`), ...pathext.map((ext) => `${executable}${ext.toUpperCase()}`)];
    for (const name of names) {
      const found = onPath(name, env);
      if (found) return found;
    }
    return null;
  }
  return onPath(executable, env);
}

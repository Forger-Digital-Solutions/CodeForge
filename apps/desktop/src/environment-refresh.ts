import { execFile } from "node:child_process";

/**
 * Refresh selected environment variables from the Windows user/machine registry hives without
 * restarting CodeForge (R1 §24). Only the NAMED variables are queried (never a full `set`/`env`
 * dump), values stay in process memory, and nothing is logged. On non-Windows platforms this is a
 * no-op: the process environment is the environment.
 */
const VALID_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

function regQuery(hive: string, name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", hive, "/v", name],
      { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        // Output lines look like: "    NAME    REG_SZ    value". Values may contain spaces.
        const line = stdout.split(/\r?\n/).find((l) => l.trim().toUpperCase().startsWith(name.toUpperCase() + " "));
        if (!line) {
          resolve(undefined);
          return;
        }
        const m = line.trim().match(/^\S+\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i);
        resolve(m?.[1]?.trim() || undefined);
      },
    );
  });
}

export interface EnvironmentRefreshResult {
  platform: string;
  queried: number;
  updated: string[];
}

/**
 * Re-read the given variable names from HKCU\Environment then HKLM\...\Environment and apply any
 * value missing from `process.env`. Existing process values are never overwritten — a variable
 * the user changed while CodeForge runs is picked up only if it was absent before (the safe,
 * additive behaviour; a full re-login is still the authoritative refresh).
 */
export async function refreshWindowsEnvironment(names: string[], env: NodeJS.ProcessEnv = process.env): Promise<EnvironmentRefreshResult> {
  const unique = [...new Set(names.filter((n) => VALID_NAME.test(n)))].slice(0, 200);
  const result: EnvironmentRefreshResult = { platform: process.platform, queried: unique.length, updated: [] };
  if (process.platform !== "win32") return result;
  for (const name of unique) {
    if (typeof env[name] === "string" && env[name]!.length > 0) continue;
    const value = (await regQuery("HKCU\\Environment", name)) ?? (await regQuery("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", name));
    if (value) {
      env[name] = value;
      result.updated.push(name);
    }
  }
  return result;
}

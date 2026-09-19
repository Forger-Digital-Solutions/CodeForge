import fs from "node:fs";
import path from "node:path";

/**
 * The physical settings.json store — extracted from main.ts so the corruption, race, and
 * kill-during-write guarantees are directly unit-testable without booting Electron.
 *
 * Guarantees:
 * - readSettingsFile never throws: a missing, empty, truncated, or non-object file reads as {}.
 * - writeSettingsAtomicFile is all-or-nothing: a crash between tmp-write and rename leaves the
 *   previous file intact; the .tmp remainder is never mistaken for the real store.
 * - Writes land with 0o600 (owner-only) — best-effort chmod is a no-op on Windows.
 */

export function readSettingsFile(storePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(storePath)) return {};
    const raw = fs.readFileSync(storePath, "utf-8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeSettingsAtomicFile(storePath: string, settings: Record<string, unknown>): boolean {
  const tmpPath = `${storePath}.tmp`;
  const data = JSON.stringify(settings, null, 2);
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, storePath);
    try {
      fs.chmodSync(storePath, 0o600);
    } catch {
      // Windows ignores chmod; best-effort
    }
    return true;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return false;
  }
}

/** Convenience wrappers bound to a directory — what main.ts uses for the userData store. */
export function createSettingsStore(dir: string, filename = "settings.json"): {
  storePath: string;
  read: () => Record<string, unknown>;
  writeAtomic: (settings: Record<string, unknown>) => boolean;
} {
  const storePath = path.join(dir, filename);
  return {
    storePath,
    read: () => readSettingsFile(storePath),
    writeAtomic: (settings) => writeSettingsAtomicFile(storePath, settings),
  };
}

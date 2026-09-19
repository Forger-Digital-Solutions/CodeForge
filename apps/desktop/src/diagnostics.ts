import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistent, sanitized main-process diagnostics (RC-7).
 *
 * Before this module the only captured output was whatever the OS happened to keep from stdout —
 * an installed build had no log file at all, and auth failure categories were collapsed into a
 * single user-facing string and lost. Everything written here is sanitized at the boundary:
 * credential-shaped keys and values are redacted before they touch disk, so a user can hand the
 * log or the exported bundle to support without leaking secrets.
 */

const LOG_DIR = "logs";
const LOG_FILE = "codeforge-main.log";
const LOG_PREV_FILE = "codeforge-main.prev.log";
const LOG_MAX_BYTES = 1_000_000;
const BUNDLE_DIR = "diagnostics";
const BUNDLE_LOG_TAIL_LINES = 400;
const VALUE_MAX_CHARS = 500;

/** Keys whose values are never persisted, matched loosely against credential vocabulary. */
const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|authorization|cookie|passw|credential|bearer|private[-_]?key|session[-_]?secret)/i;

/** Value shapes that look like credentials even under an innocent key name. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[posur]_[A-Za-z0-9]{16,}/g,
  /\b[A-Fa-f0-9]{40}\b/g,
];

export function sanitizeDiagnosticValue(value: unknown, keyHint = "", depth = 0): unknown {
  if (SECRET_KEY_PATTERN.test(keyHint)) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let out = value.length > VALUE_MAX_CHARS ? `${value.slice(0, VALUE_MAX_CHARS)}…` : value;
    for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: sanitizeDiagnosticValue(value.message) as string };
  if (Array.isArray(value)) {
    if (depth >= 4) return "[…]";
    return value.slice(0, 50).map((entry) => sanitizeDiagnosticValue(entry, "", depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[…]";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[key] = sanitizeDiagnosticValue(entry, key, depth + 1);
    }
    return out;
  }
  return String(value);
}

let logActive = false;
let logFilePath: string | null = null;
let consoleTeed = false;

function logDir(): string {
  return path.join(app.getPath("userData"), LOG_DIR);
}

export function diagnosticsLogPath(): string | null {
  return logFilePath;
}

function writeLine(level: string, event: string, fields?: Record<string, unknown>): void {
  if (!logActive || !logFilePath) return;
  const record: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      record[key] = sanitizeDiagnosticValue(value, key);
    }
  }
  try {
    // Synchronous append: a buffered stream would lose exactly the pre-crash lines a
    // diagnostic log exists to capture.
    fs.appendFileSync(logFilePath, `${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never take the app down with it.
  }
}

/** One structured, sanitized line in the persistent log. */
export function logDiagnostic(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void {
  writeLine(level, event, fields);
}

/**
 * Opens the persistent log inside the user-data directory and tees console.* into it, so every
 * existing console call site is captured without needing per-site rewiring. Rotates the previous
 * run's log aside when it exceeds the size cap. Safe to call once, early in startup.
 */
export function initDiagnostics(): void {
  if (logActive) return;
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, LOG_FILE);
    if (fs.existsSync(target) && fs.statSync(target).size > LOG_MAX_BYTES) {
      fs.renameSync(target, path.join(dir, LOG_PREV_FILE));
    }
    logFilePath = target;
    logActive = true;
    writeLine("info", "diagnostics_started", { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node });
  } catch {
    logActive = false;
    logFilePath = null;
    return;
  }

  if (consoleTeed) return;
  consoleTeed = true;
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(sanitizeDiagnosticValue(arg))))
        .join(" ");
      writeLine(level === "log" ? "info" : level, "console", { text });
      original(...args);
    };
  }
}

/** Stops persistence during shutdown; idempotent. */
export function closeDiagnostics(): void {
  logActive = false;
}

function readLogTail(file: string, maxLines: number): string[] {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    return lines.slice(-maxLines).map((line) => {
      // Lines are already sanitized at write time; this pass is belt-and-suspenders for older logs.
      let out = line;
      for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
      return out;
    });
  } catch {
    return [];
  }
}

export interface DiagnosticBundleResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Writes a single-share diagnostic bundle: app/platform facts, the sanitized state summary the
 * caller supplies (connection states, free-cloud counters — never credentials), and the tail of
 * the persistent log. The renderer triggers this through the diagnostics:export IPC; the user
 * then shares the file from the diagnostics folder.
 */
export function writeDiagnosticBundle(stateSummary: Record<string, unknown>): DiagnosticBundleResult {
  try {
    const dir = path.join(app.getPath("userData"), BUNDLE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bundlePath = path.join(dir, `codeforge-diagnostic-${stamp}.json`);
    const bundle = {
      generatedAt: new Date().toISOString(),
      kind: "codeforge-diagnostic-bundle",
      version: app.getVersion(),
      platform: { os: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node },
      state: sanitizeDiagnosticValue(stateSummary),
      logTail: readLogTail(logFilePath ?? path.join(logDir(), LOG_FILE), BUNDLE_LOG_TAIL_LINES),
    };
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf8");
    writeLine("info", "diagnostic_bundle_written", { path: bundlePath });
    return { ok: true, path: bundlePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

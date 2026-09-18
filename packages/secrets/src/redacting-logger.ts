import { redactSecrets } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Field names whose VALUES are never logged regardless of content. Matched case-insensitively
 * against object keys anywhere in a logged structure (headers, error causes, request bodies).
 */
const SENSITIVE_FIELD_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-codeforge-control-token|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passwd|pwd|token|private[-_]?key|encryption[-_]?key|session[-_]?token|stripe-signature|webhook[-_]?secret|code[-_]?verifier|database[-_]?url|connection[-_]?string|jwt[-_]?secret)$/i;

const MAX_DEPTH = 6;
const MAX_STRING = 4096;
const MAX_ARRAY = 100;

/**
 * Structural redaction: walks a value, blanks sensitive field names, and pattern-redacts every
 * string leaf (bearer tokens, provider keys, connection strings, private keys). Errors are
 * flattened to name/message/code with the same treatment — stack traces are kept only at
 * debug level by the logger, never emitted at info+.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (value instanceof Error) {
    const flattened: Record<string, unknown> = { name: value.name, message: redactSecrets(value.message) };
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") flattened.code = code;
    if ((value as { cause?: unknown }).cause !== undefined) flattened.cause = redactValue((value as { cause?: unknown }).cause, depth + 1);
    return flattened;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
  }
  if (value instanceof Map) return redactValue(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return redactValue([...value], depth + 1);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof URL) return redactSecrets(stripUrlCredentials(value.toString()));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_FIELD_PATTERN.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function stripUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.toString().replace("//", "//[REDACTED]@");
    }
    return raw;
  } catch {
    return raw;
  }
}

export interface RedactingLogger {
  level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): RedactingLogger;
}

export interface RedactingLoggerOptions {
  level?: LogLevel;
  name?: string;
  /** Output sink; defaults to console (stdout for debug/info, stderr for warn/error). */
  write?: (level: Exclude<LogLevel, "silent">, line: string) => void;
  bindings?: Record<string, unknown>;
  now?: () => Date;
}

/**
 * The only logger CodeForge services should write through. Every field and message passes
 * through {@link redactValue} BEFORE serialization, so a credential that reaches a log call is
 * masked at the boundary rather than relying on each call site to remember.
 */
export function createRedactingLogger(options: RedactingLoggerOptions = {}): RedactingLogger {
  const write =
    options.write ??
    ((level, line) => {
      if (level === "error" || level === "warn") console.error(line);
      else console.log(line);
    });
  const now = options.now ?? (() => new Date());
  const bindings = redactValue(options.bindings ?? {}) as Record<string, unknown>;
  const state = { level: options.level ?? "info" };

  const emit = (level: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;
    const record = {
      ts: now().toISOString(),
      level,
      ...(options.name ? { logger: options.name } : {}),
      msg: redactSecrets(message),
      ...bindings,
      ...(fields ? (redactValue(fields) as Record<string, unknown>) : {}),
    };
    write(level, JSON.stringify(record));
  };

  const logger: RedactingLogger = {
    get level() {
      return state.level;
    },
    set level(next: LogLevel) {
      state.level = next;
    },
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childBindings) =>
      createRedactingLogger({ ...options, level: state.level, write, bindings: { ...bindings, ...childBindings } }),
  };
  return logger;
}

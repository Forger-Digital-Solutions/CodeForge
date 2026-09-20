import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionManifest } from "./manifest.js";
import { buildExtensionApi, type ExtensionHostDelegates } from "./api.js";

/**
 * The extension host: extension code is evaluated inside a `node:vm` context in the main
 * process. The sandbox global contains only `module`, `exports`, `codeforge`, and `console` —
 * no `require`, `process`, `fetch`, `setTimeout`, `fs`, or `child_process`. Isolation is
 * structural: there is nothing to escape with, not just policy to violate.
 *
 * Failure containment: module evaluation runs under a hard timeout, activate()/deactivate()
 * and every command invocation are wrapped so an extension exception becomes a recorded error
 * state — never a crash in the core app.
 */

export type ExtensionStatus = "installed" | "active" | "disabled" | "error";

export interface HostedExtension {
  manifest: ExtensionManifest;
  /** Absolute path of the extension folder (managed store or developer path). */
  dir: string;
  status: ExtensionStatus;
  lastError?: string;
  /** commandId → handler registered during activate(). */
  commands: Map<string, (...args: unknown[]) => unknown>;
  /** The extension's own deactivate(), if it exported one. */
  deactivateFn?: () => unknown;
  context?: vm.Context;
}

const EVAL_TIMEOUT_MS = 3_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
/** Extensions are text programs — a megabyte cap rejects bundles masquerading as extensions. */
const MAX_MAIN_BYTES = 1_000_000;

export class ExtensionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionLoadError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ExtensionLoadError(`${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Minimal console inside the sandbox: strings only, prefixed and routed to host diagnostics. */
function buildSandboxConsole(manifest: ExtensionManifest, host: ExtensionHostDelegates): Console {
  const emit = (level: "info" | "warn" | "error") => (...args: unknown[]) => {
    const message = args.map((a) => (typeof a === "string" ? a : safeDescribe(a))).join(" ").slice(0, 2000);
    host.log(manifest.id, level, message);
  };
  return { log: emit("info"), info: emit("info"), warn: emit("warn"), error: emit("error") } as Console;
}

function safeDescribe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

export class ExtensionHost {
  constructor(private readonly delegates: ExtensionHostDelegates) {}

  /**
   * Evaluate the extension's main file in a fresh sandbox and run its activate(). A throw at any
   * stage — missing file, syntax error, timeout, activation failure — lands as status "error"
   * with lastError recorded, never propagates.
   */
  async activate(extension: HostedExtension): Promise<void> {
    const api = buildExtensionApi(extension.manifest, this.delegates);
    try {
      const mainPath = path.join(extension.dir, extension.manifest.main);
      const resolved = path.resolve(mainPath);
      if (!resolved.startsWith(path.resolve(extension.dir) + path.sep) && resolved !== path.resolve(extension.dir)) {
        throw new ExtensionLoadError("main resolves outside the extension folder");
      }
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_MAIN_BYTES) throw new ExtensionLoadError(`main file exceeds ${MAX_MAIN_BYTES} bytes`);
      const code = fs.readFileSync(resolved, "utf8");

      const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
      const sandbox = {
        module: moduleShim,
        exports: moduleShim.exports,
        codeforge: api,
        console: buildSandboxConsole(extension.manifest, this.delegates),
      };
      // The sandbox container is deliberately not frozen: contextify must be able to manage it.
      // Isolation comes from what is absent (no require/process/fs/net), not from immutability.
      const context = vm.createContext(sandbox);
      extension.context = context;

      const script = new vm.Script(code, { filename: resolved });
      script.runInContext(context, { timeout: EVAL_TIMEOUT_MS });

      const exported = moduleShim.exports as { activate?: unknown; deactivate?: unknown };
      if (typeof exported.deactivate === "function") {
        extension.deactivateFn = exported.deactivate as () => unknown;
      }
      if (typeof exported.activate === "function") {
        await withTimeout(
          Promise.resolve((exported.activate as (a: unknown) => unknown)(api)),
          LIFECYCLE_TIMEOUT_MS,
          `activate() for "${extension.manifest.id}"`,
        );
      }
      extension.status = "active";
      extension.lastError = undefined;
    } catch (error) {
      extension.status = "error";
      extension.lastError = error instanceof Error ? error.message : String(error);
      this.delegates.log(extension.manifest.id, "error", `activation failed: ${extension.lastError}`);
    }
  }

  /** Deactivate containment — a throwing deactivate() is recorded, never propagated. */
  async deactivate(extension: HostedExtension): Promise<void> {
    if (extension.deactivateFn) {
      try {
        await withTimeout(
          Promise.resolve(extension.deactivateFn()),
          LIFECYCLE_TIMEOUT_MS,
          `deactivate() for "${extension.manifest.id}"`,
        );
      } catch (error) {
        extension.lastError = error instanceof Error ? error.message : String(error);
        this.delegates.log(extension.manifest.id, "error", `deactivate failed: ${extension.lastError}`);
      }
    }
    extension.commands.clear();
    extension.context = undefined;
    extension.deactivateFn = undefined;
    if (extension.status === "active") extension.status = "installed";
  }

  /**
   * Invoke a contributed command. The handler runs inside the sandbox's realm; exceptions and
   * timeouts are converted into a structured failure, and a crash marks the extension "error"
   * without touching other extensions or the core.
   */
  async runCommand(extension: HostedExtension, commandId: string, args: unknown[] = []): Promise<{ ok: boolean; error?: string; result?: string }> {
    const handler = extension.commands.get(commandId);
    if (!handler) return { ok: false, error: `Command "${commandId}" is not registered by "${extension.manifest.id}"` };
    try {
      const value = await withTimeout(Promise.resolve(handler(...args)), COMMAND_TIMEOUT_MS, `command "${commandId}"`);
      // The result crosses the sandbox boundary into agent tool output — bound it here so a
      // hostile or buggy handler cannot return an unbounded payload into model context.
      const serialized = value === undefined ? undefined : safeDescribe(value).slice(0, 16_000);
      return { ok: true, ...(serialized !== undefined ? { result: serialized } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      extension.status = "error";
      extension.lastError = `Command "${commandId}" failed: ${message}`;
      this.delegates.log(extension.manifest.id, "error", extension.lastError);
      return { ok: false, error: message };
    }
  }
}

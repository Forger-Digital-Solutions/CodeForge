import { loadPty, type PtyLike } from "./pty-loader.js";
import { defaultShell, resolveExecutable } from "./shells.js";

/**
 * Persistent interactive terminal session (the user-facing Terminal work surface).
 * One instance = one PTY = one shell process tree. The desktop main process owns these;
 * the renderer only sees the byte stream over IPC.
 */

export interface TerminalSessionOptions {
  shell?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export class TerminalSession {
  readonly pid: number;
  readonly shell: string;
  private readonly pty: PtyLike;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number, signal?: number) => void>();
  private exited = false;
  private exitCode: number | null = null;

  static supported(platform: NodeJS.Platform = process.platform): boolean {
    // ConPTY is the zero-window path on Windows; node-pty's fallback pty is fine on POSIX.
    return loadPty() !== null && (platform === "win32" ? true : true);
  }

  constructor(options: TerminalSessionOptions = {}) {
    const ptyModule = loadPty();
    if (!ptyModule) throw new Error("Interactive terminal unavailable: node-pty is not installed in this runtime");
    const env = { ...(options.env ?? process.env) } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const shell = resolveExecutable(options.shell ?? defaultShell(env), env) ?? options.shell ?? "cmd.exe";
    this.shell = shell;
    this.pty = ptyModule.spawn(shell, options.shellArgs ?? [], {
      name: "xterm-256color",
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env,
      useConpty: process.platform === "win32",
      useConptyDll: process.platform === "win32",
    });
    this.pid = this.pty.pid;
    this.pty.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitCode = exitCode;
      // Release the agent's named pipes so the event loop can drain.
      try { this.pty.kill(); } catch { /* already gone */ }
      for (const listener of this.exitListeners) listener(exitCode, signal);
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get lastExitCode(): number | null {
    return this.exitCode;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number, signal?: number) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exited) queueMicrotask(() => listener(this.exitCode ?? 1));
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols <= 0 || rows <= 0) return;
    try {
      this.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // resize races with process exit are harmless
    }
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch {
      // already gone
    }
  }
}

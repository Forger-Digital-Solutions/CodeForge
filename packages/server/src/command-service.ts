import { spawn, type ChildProcess } from "node:child_process";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { classifyCommand as classifyViaModule, type RiskLevel as ClassifierRisk } from "./command-classifier.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { prepareShellCommand, quoteShellArgument, terminateProcessTree } from "@codeforge/workflow";

export type RiskLevel = ClassifierRisk;

export interface CommandExecutionOptions {
  commandId: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  adapter: WorkspaceEventAdapter;
}

export interface CommandResult {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
}

export class CommandService {
  private readonly activeProcesses = new Map<string, { process: ChildProcess; cancel: () => void }>();

  classifyCommand(command: string): { risk: RiskLevel; reasons: string[]; category?: string; requiresApproval?: boolean } {
    const c = classifyViaModule(command);
    return { risk: c.risk, reasons: c.reasons, category: c.category, requiresApproval: c.requiresApproval };
  }

  async execute(options: CommandExecutionOptions): Promise<CommandResult> {
    const { commandId, command, args, cwd, timeoutMs, adapter } = options;
    const startTime = Date.now();

    adapter.emitCommandStarted(commandId, command, cwd);

    return new Promise((resolve, reject) => {
      const fullCommand = args?.length
        ? `${command} ${args.map((arg) => quoteShellArgument(arg)).join(" ")}`
        : command;
      let prepared: ReturnType<typeof prepareShellCommand>;
      try {
        prepared = prepareShellCommand(fullCommand, getSanitizedEnvForChild(), cwd);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        adapter.emitCommandCompleted(commandId, 1, Date.now() - startTime);
        reject(failure);
        return;
      }

      const spawnOptions = {
        cwd,
        windowsHide: true,
        env: prepared.env,
        detached: process.platform !== "win32",
      };
      const childProcess = prepared.shell
        ? spawn(prepared.command, { ...spawnOptions, shell: true })
        : spawn(prepared.command, prepared.args, { ...spawnOptions, shell: false });

      let stdout = "";
      let stderr = "";
      let cancelled = false;
      let timedOut = false;
      let settled = false;
      let terminationStarted = false;

      const timeout = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : null;

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        this.activeProcesses.delete(commandId);
      };

      const finish = (code: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const durationMs = Date.now() - startTime;
        const exitCode = timedOut ? 124 : cancelled ? 130 : (code ?? 1);
        adapter.emitCommandCompleted(commandId, exitCode, durationMs);
        if (error && !timedOut && !cancelled) {
          reject(new Error(`Command failed: ${error.message}`));
          return;
        }
        resolve({
          commandId,
          exitCode,
          stdout,
          stderr,
          durationMs,
          cancelled,
          timedOut,
        });
      };

      const stop = (): void => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        void terminateProcessTree(childProcess).finally(() => {
          setTimeout(() => finish(null), 250);
        });
      };

      this.activeProcesses.set(commandId, {
        process: childProcess,
        cancel: () => {
          cancelled = true;
          stop();
        },
      });

      childProcess.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        adapter.emitCommandOutput(commandId, chunk, "stdout");
      });

      childProcess.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        adapter.emitCommandOutput(commandId, chunk, "stderr");
      });

      childProcess.once("error", (error) => finish(null, error));
      childProcess.once("close", (code) => {
        if (!terminationStarted) finish(code);
      });
    });
  }

  cancel(commandId: string): boolean {
    const active = this.activeProcesses.get(commandId);
    if (active) {
      active.cancel();
      return true;
    }
    return false;
  }

  getActiveCommands(): string[] {
    return Array.from(this.activeProcesses.keys());
  }
}

export function createCommandService(): CommandService {
  return new CommandService();
}

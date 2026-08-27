import { spawn, type ChildProcess } from "node:child_process";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { classifyCommand as classifyViaModule, type RiskLevel as ClassifierRisk } from "./command-classifier.js";
import { getSanitizedEnvForChild } from "./env-filter.js";

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
}

export class CommandService {
  private readonly activeProcesses: Map<string, ChildProcess> = new Map();

  classifyCommand(command: string): { risk: RiskLevel; reasons: string[]; category?: string; requiresApproval?: boolean } {
    const c = classifyViaModule(command);
    return { risk: c.risk, reasons: c.reasons, category: c.category, requiresApproval: c.requiresApproval };
  }

  async execute(options: CommandExecutionOptions): Promise<CommandResult> {
    const { commandId, command, args, cwd, timeoutMs, adapter } = options;
    const startTime = Date.now();

    adapter.emitCommandStarted(commandId, command, cwd);

    return new Promise((resolve, reject) => {
      const childProcess = spawn(command, args ?? [], {
        cwd,
        shell: true,
        windowsHide: true,
        env: getSanitizedEnvForChild(),
      });

      this.activeProcesses.set(commandId, childProcess);

      let stdout = "";
      let stderr = "";
      let cancelled = false;

      const timeout = timeoutMs
        ? setTimeout(() => {
            cancelled = true;
            childProcess.kill("SIGTERM");
          }, timeoutMs)
        : null;

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

      childProcess.on("error", (error) => {
        if (timeout) clearTimeout(timeout);
        this.activeProcesses.delete(commandId);

        const durationMs = Date.now() - startTime;
        adapter.emitCommandCompleted(commandId, 1, durationMs);

        reject(new Error(`Command failed: ${error.message}`));
      });

      childProcess.on("close", (code) => {
        if (timeout) clearTimeout(timeout);
        this.activeProcesses.delete(commandId);

        const durationMs = Date.now() - startTime;
        const exitCode = code ?? (cancelled ? 137 : 1);

        adapter.emitCommandCompleted(commandId, exitCode, durationMs);

        resolve({
          commandId,
          exitCode,
          stdout,
          stderr,
          durationMs,
          cancelled,
        });
      });
    });
  }

  cancel(commandId: string): boolean {
    const process = this.activeProcesses.get(commandId);
    if (process) {
      process.kill("SIGTERM");
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

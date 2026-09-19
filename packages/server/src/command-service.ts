import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { classifyCommand as classifyViaModule, type RiskLevel as ClassifierRisk } from "./command-classifier.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { prepareShellCommand, quoteShellArgument } from "@codeforge/workflow";
import { executePrepared } from "@codeforge/terminal";

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
  private readonly activeProcesses = new Map<string, { cancel: () => void }>();

  classifyCommand(command: string): { risk: RiskLevel; reasons: string[]; category?: string; requiresApproval?: boolean } {
    const c = classifyViaModule(command);
    return { risk: c.risk, reasons: c.reasons, category: c.category, requiresApproval: c.requiresApproval };
  }

  async execute(options: CommandExecutionOptions): Promise<CommandResult> {
    const { commandId, command, args, cwd, timeoutMs, adapter } = options;
    const startTime = Date.now();

    adapter.emitCommandStarted(commandId, command, cwd);

    const fullCommand = args?.length
      ? `${command} ${args.map((arg) => quoteShellArgument(arg)).join(" ")}`
      : command;
    let prepared: ReturnType<typeof prepareShellCommand>;
    try {
      prepared = prepareShellCommand(fullCommand, getSanitizedEnvForChild(), cwd);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      adapter.emitCommandCompleted(commandId, 1, Date.now() - startTime);
      throw failure;
    }

    const controller = new AbortController();
    let cancelled = false;
    this.activeProcesses.set(commandId, {
      cancel: () => {
        cancelled = true;
        controller.abort();
      },
    });

    try {
      // ConPTY-backed execution on Windows keeps console-subsystem grandchildren
      // (npm shims, cmd internals) inside an invisible pseudo console; pipes on POSIX.
      const result = await executePrepared(prepared, {
        cwd,
        timeoutMs,
        signal: controller.signal,
        onOutput: (chunk, stream) => adapter.emitCommandOutput(commandId, chunk, stream),
      });
      const durationMs = Date.now() - startTime;
      adapter.emitCommandCompleted(commandId, result.exitCode, durationMs);
      if (result.spawnError && !result.timedOut && !result.cancelled) {
        throw new Error(`Command failed: ${result.spawnError}`);
      }
      return {
        commandId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        cancelled: result.cancelled || cancelled,
        timedOut: result.timedOut,
      };
    } finally {
      this.activeProcesses.delete(commandId);
    }
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

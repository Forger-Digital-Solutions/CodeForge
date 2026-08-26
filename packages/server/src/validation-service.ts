import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { createCommandService, type CommandService } from "./command-service.js";

export interface ValidationOptions {
  validationId: string;
  type: "unit_tests" | "lint" | "typecheck" | "build" | "e2e";
  cwd?: string;
  adapter: WorkspaceEventAdapter;
  command?: string;
}

export interface ValidationResult {
  validationId: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  success: boolean;
}

export class ValidationService {
  private readonly commandService: CommandService;

  constructor() {
    this.commandService = createCommandService();
  }

  async runValidation(options: ValidationOptions): Promise<ValidationResult> {
    const { validationId, type, cwd, adapter, command } = options;
    const startTime = Date.now();

    adapter.emitValidationStarted(validationId, type);

    const defaultCommands: Record<string, string> = {
      unit_tests: "npm test",
      lint: "npm run lint",
      typecheck: "npm run typecheck",
      build: "npm run build",
      e2e: "npm run test:e2e",
    };

    const execCommand = command ?? defaultCommands[type] ?? "npm test";
    const commandId = crypto.randomUUID();

    try {
      adapter.emitTestStarted(validationId);

      const result = await this.commandService.execute({
        commandId,
        command: execCommand,
        cwd,
        adapter,
        timeoutMs: 300000, // 5 minutes
      });

      const durationMs = Date.now() - startTime;
      const success = result.exitCode === 0;

      let passed = 0;
      let failed = 0;
      let skipped = 0;

      if (type === "unit_tests") {
        const parsed = this.parseTestOutput(result.stdout + result.stderr);
        passed = parsed.passed;
        failed = success ? 0 : parsed.failed;
        skipped = parsed.skipped;
      } else if (success) {
        passed = 1;
      } else {
        failed = 1;
      }

      adapter.emitTestCompleted(validationId, passed, failed, skipped);
      adapter.emitValidationCompleted(validationId, passed, failed, skipped);

      return {
        validationId,
        passed,
        failed,
        skipped,
        durationMs,
        success,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      adapter.emitTestCompleted(validationId, 0, 1, 0);
      adapter.emitValidationCompleted(validationId, 0, 1, 0);

      return {
        validationId,
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs,
        success: false,
      };
    }
  }

  private parseTestOutput(output: string): { passed: number; failed: number; skipped: number } {
    const vitestMatch = output.match(/Tests\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+failed)?(?:\s+\|\s+(\d+)\s+skipped)?/);
    if (vitestMatch) {
      return {
        passed: parseInt(vitestMatch[1] ?? "0", 10),
        failed: parseInt(vitestMatch[2] ?? "0", 10),
        skipped: parseInt(vitestMatch[3] ?? "0", 10),
      };
    }

    const jestMatch = output.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
    if (jestMatch) {
      const passed = parseInt(jestMatch[1] ?? "0", 10);
      const total = parseInt(jestMatch[2] ?? "0", 10);
      return { passed, failed: total > passed ? total - passed : 0, skipped: 0 };
    }

    const simpleMatch = output.match(/(\d+)\s+(?:passing|passed)/i);
    if (simpleMatch && simpleMatch[1]) {
      return { passed: parseInt(simpleMatch[1], 10), failed: 0, skipped: 0 };
    }

    return { passed: 0, failed: 0, skipped: 0 };
  }
}

export function createValidationService(): ValidationService {
  return new ValidationService();
}

import { describe, expect, it } from "vitest";
import { headlessCommandIssue, isVerificationCommand, ToolBroker } from "../src/index.js";
import { ERROR_CODES } from "@codeforge/agent";

describe("run_command exit-status truthfulness", () => {
  it.each(["node --test --watch", 'node --test "--watch"', "npm test -- --watchAll", "npm run test:watch", "npx vitest", "node --test; node --watch-path=src test.mjs"])("rejects headless watch command %s before dispatch", async (command) => {
    let dispatched = false;
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, role: "coder", customExecutor: async () => { dispatched = true; return "should not run"; } },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_CODES.TOOL_ARGUMENT_INVALID);
    expect(result.output).toMatch(/watch/i);
    expect(dispatched).toBe(false);
  });

  it("keeps finite verification and literal watch text distinct", () => {
    expect(headlessCommandIssue('node -e "console.log(\'--watch\')"')).toBeUndefined();
    for (const command of ["node --test test/example.test.mjs", "npx vitest run", "npm test -- --runInBand", "vitest --watch=false"]) {
      expect(headlessCommandIssue(command)).toBeUndefined();
      expect(isVerificationCommand(command)).toBe(true);
    }
    expect(isVerificationCommand('node -e "console.log(\'--test\')"')).toBe(false);
    expect(isVerificationCommand("git diff")).toBe(false);
  });
  it("disables pagers and credential prompts for headless commands", async () => {
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command: 'node -e "console.log(process.env.GIT_PAGER, process.env.PAGER, process.env.GIT_TERMINAL_PROMPT)"' } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, role: "coder" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("cat cat 0");
  });
  it("runs compound Node evaluations without treating shell operators as JavaScript", async () => {
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command: 'node -e "console.log(11)" && node --eval "console.log(22)"' } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, role: "coder" },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("11");
    expect(result.output).toContain("22");
  });

  it("preserves failure and short-circuiting in a compound Node command", async () => {
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command: 'node --eval "process.exit(7)" && node --eval "console.log(987654)"' } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, role: "coder" },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Exit code: 7");
    expect(result.output).not.toContain("987654");
  });
  it("reports a nonzero command exit as a structured tool failure", async () => {
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command: "node -e \"process.exit(7)\"" } },
      {
        workspacePath: process.cwd(),
        permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
        role: "coder",
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(result.output).toContain("Exit code: 7");
  });
});

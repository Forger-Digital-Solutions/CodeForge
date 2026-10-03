import { describe, expect, it } from "vitest";
import { ToolBroker } from "../src/index.js";
import { ERROR_CODES } from "@codeforge/agent";

describe("run_command exit-status truthfulness", () => {
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

import { describe, expect, it } from "vitest";
import { ToolBroker } from "../src/index.js";
import { ERROR_CODES } from "@codeforge/agent";

describe("run_command exit-status truthfulness", () => {
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

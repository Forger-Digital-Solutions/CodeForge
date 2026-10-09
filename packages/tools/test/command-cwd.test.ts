import { describe, expect, it } from "vitest";
import { commandCwdArgumentIssue, ToolBroker } from "../src/index.js";
import { ERROR_CODES } from "@codeforge/agent";

describe("native command cwd validation", () => {
  it("classifies an unsupported Windows POSIX cwd without reinterpreting native or traversal paths", () => {
    expect(commandCwdArgumentIssue("/workspace/coder-forge", "win32")).toContain("Omit cwd");
    expect(commandCwdArgumentIssue("/workspace/coder-forge", "linux")).toBeUndefined();
    for (const cwd of [undefined, "", ".", "src", "G:\\workspace", "G:/workspace", "../outside", "/../outside", "//server/share"]) {
      expect(commandCwdArgumentIssue(cwd, "win32")).toBeUndefined();
    }
  });

  it.runIf(process.platform === "win32")("rejects POSIX-root cwd before any custom executor or process dispatch", async () => {
    let calls = 0;
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command: "node --test", cwd: "/workspace/coder-forge" } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, role: "coder", customExecutor: async () => { calls++; return "unexpected"; } },
    );
    expect(result).toMatchObject({ success: false, error: ERROR_CODES.TOOL_ARGUMENT_INVALID });
    expect(result.output).toContain("command was not executed");
    expect(calls).toBe(0);
  });

  it("preserves fatal path confinement before custom delegation", async () => {
    let calls = 0;
    const result = await new ToolBroker().executeTool(
      { name: "run_command", arguments: { command: "node --test", cwd: "../outside" } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, role: "coder", customExecutor: async () => { calls++; return "unexpected"; } },
    );
    expect(result).toMatchObject({ success: false, error: ERROR_CODES.TOOL_PATH_ESCAPE });
    expect(calls).toBe(0);
  });
});

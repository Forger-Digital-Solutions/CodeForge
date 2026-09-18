import { describe, expect, it } from "vitest";
import { ToolBroker, ToolRegistry } from "../src/index.js";

describe("role authority boundaries", () => {
  it("keeps mission planners and replanners read-only even with broad caller permissions", () => {
    const registry = new ToolRegistry();
    for (const role of ["mission-planner", "replanner"]) {
      const tools = registry.getForRole(role, { read: true, search: true, write: true, executeCommand: true, network: true });
      expect(tools.some((tool) => !tool.readOnly)).toBe(false);
      expect(tools.some((tool) => tool.name === "run_command")).toBe(false);
    }
  });

  it("rejects a mutating call when role text or context attempts to override the ceiling", async () => {
    const result = await new ToolBroker().executeTool(
      { name: "write_file", arguments: { path: "x.txt", content: "should not write" } },
      { workspacePath: process.cwd(), permissions: { read: true, search: true, write: true, executeCommand: true, network: true }, role: "replanner" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TOOL_PERMISSION_DENIED");
  });
});

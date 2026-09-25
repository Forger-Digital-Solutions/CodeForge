import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOL_DEFINITIONS, createToolBroker, createToolRegistry } from "../src/index.js";
import type { AgentPermissions } from "@codeforge/agent";

const ALL_PERMISSIONS: AgentPermissions = {
  read: true,
  search: true,
  write: true,
  executeCommand: true,
  network: true,
};

const NO_PERMISSIONS: AgentPermissions = {
  read: false,
  search: false,
  write: false,
  executeCommand: false,
  network: false,
};

describe("canonical tool-authority registry (R35 Mission F)", () => {
  it("every built-in tool declares a complete authority triple", () => {
    for (const [name, def] of Object.entries(BUILT_IN_TOOL_DEFINITIONS)) {
      expect(def.name, `${name}: name mismatch`).toBe(name);
      expect(def.requiredPermission, `${name}: missing requiredPermission`).toBeTruthy();
      expect(typeof def.readOnly, `${name}: missing readOnly`).toBe("boolean");
      expect(
        ["read", "write", "command", "repo", "checkpoint", "network"],
        `${name}: unknown executionClass`,
      ).toContain(def.executionClass);
    }
  });

  it("readOnly agrees with executionClass — mutating classes are never readOnly", () => {
    for (const [name, def] of Object.entries(BUILT_IN_TOOL_DEFINITIONS)) {
      if (def.executionClass === "write" || def.executionClass === "command") {
        expect(def.readOnly, `${name}: ${def.executionClass} must not be readOnly`).toBe(false);
      }
      if (def.executionClass === "read" || def.executionClass === "repo") {
        expect(def.readOnly, `${name}: ${def.executionClass} should be readOnly`).toBe(true);
      }
    }
  });

  it("dispatch fails closed: an unprivileged context is denied for every gated tool", async () => {
    const broker = createToolBroker(createToolRegistry());
    for (const [name, def] of Object.entries(BUILT_IN_TOOL_DEFINITIONS)) {
      // Provide structurally valid args so we reach the permission check, not arg validation.
      const args = Object.fromEntries(
        (def.parameters.required ?? []).map((k) => [k, "x"]),
      );
      const record = await broker.executeTool(
        { name, arguments: args },
        { workspacePath: ".", permissions: NO_PERMISSIONS, role: "coder" },
      );
      expect(record.success, `${name} executed without permission`).toBe(false);
      expect(record.error, `${name} denied with wrong code`).toBe("TOOL_PERMISSION_DENIED");
    }
  });

  it("read-only roles are denied mutating tools at dispatch even with full permissions", async () => {
    const broker = createToolBroker(createToolRegistry());
    for (const role of ["explorer", "reviewer", "planner", "mission-planner", "replanner"]) {
      for (const [name, def] of Object.entries(BUILT_IN_TOOL_DEFINITIONS)) {
        if (def.readOnly) continue;
        const args = Object.fromEntries((def.parameters.required ?? []).map((k) => [k, "x"]));
        const record = await broker.executeTool(
          { name, arguments: args },
          { workspacePath: ".", permissions: ALL_PERMISSIONS, role },
        );
        expect(record.success, `${role} executed mutating ${name}`).toBe(false);
        expect(record.error).toBe("TOOL_PERMISSION_DENIED");
      }
    }
  });

  it("schema filtering and dispatch enforcement agree — advertised tools are exactly the executable ones", () => {
    const registry = createToolRegistry();
    for (const role of ["coder", "explorer", "reviewer", "planner"]) {
      const advertised = new Set(registry.getForRole(role, ALL_PERMISSIONS).map((t) => t.name));
      for (const [name, def] of Object.entries(BUILT_IN_TOOL_DEFINITIONS)) {
        const isReadOnlyRole = role !== "coder";
        const executable = !(isReadOnlyRole && !def.readOnly);
        expect(advertised.has(name), `${role}: ${name} advertised=${advertised.has(name)} but executable=${executable}`).toBe(executable);
      }
    }
  });
});

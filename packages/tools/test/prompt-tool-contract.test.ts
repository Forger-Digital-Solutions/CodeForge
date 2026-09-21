import { describe, expect, it } from "vitest";
import { ROLE_PROMPTS, type AgentRoleType } from "@codeforge/agent";
import { BUILT_IN_TOOL_DEFINITIONS, ToolRegistry } from "../src/index.js";

/**
 * Prompt/tool-contract coherence (R23 F15): the role system prompts must never teach tool
 * vocabulary the registry does not have, and must not unconditionally instruct a tool the
 * run's permission ceiling may withhold. A prompt that names a nonexistent or withheld tool
 * manufactures provider-side tool-validation rejections and authority-boundary stops that are
 * CodeForge's defect, not the model's.
 *
 * Tool-shaped mentions = snake_case tokens in the built-in tool namespaces. Any mention that
 * is not a registered tool is obsolete or invented vocabulary and fails this test.
 */
const TOOL_SHAPE = /\b(?:read|write|edit|list|search|run|create|repo|browser|mcp|plugin)_[a-z0-9_]+\b/g;

function toolMentions(prompt: string): string[] {
  return [...new Set(prompt.match(TOOL_SHAPE) ?? [])];
}

describe("role prompt ↔ tool registry contract", () => {
  const registry = new ToolRegistry();
  const roles = Object.keys(ROLE_PROMPTS) as AgentRoleType[];

  it("every tool-shaped name mentioned in a role prompt is a registered tool", () => {
    for (const role of roles) {
      const mentions = toolMentions(ROLE_PROMPTS[role].systemPromptTemplate);
      const unknown = mentions.filter((name) => !(name in BUILT_IN_TOOL_DEFINITIONS));
      expect(unknown, `role ${role} teaches unregistered tool vocabulary`).toEqual([]);
    }
  });

  it("the coder prompt never unconditionally instructs a permission-gated tool", () => {
    const prompt = ROLE_PROMPTS.coder.systemPromptTemplate;
    // run_command requires executeCommand, which a run lease may withhold; the prompt must
    // condition its use on the tool actually being advertised, never command a bare call.
    const unconditional = /(^|\n)\s*\d*\.?\s*Run targeted tests with run_command\b/.test(prompt);
    expect(unconditional).toBe(false);
    expect(prompt).toMatch(/[Ii]f run_command is among the tools advertised/);
  });

  it("read-only role prompts do not name mutating tools at all", () => {
    for (const role of ["explorer", "planner", "reviewer", "mission-planner", "replanner"] as const) {
      const mentions = toolMentions(ROLE_PROMPTS[role].systemPromptTemplate);
      const mutating = mentions.filter((name) => BUILT_IN_TOOL_DEFINITIONS[name] && !BUILT_IN_TOOL_DEFINITIONS[name].readOnly);
      expect(mutating, `read-only role ${role} names mutating tools`).toEqual([]);
    }
  });

  it("the advertised set for a denied permission really excludes the gated tool", () => {
    const tools = registry.getForRole("coder", { read: true, search: true, write: true, executeCommand: false, network: false });
    expect(tools.some((tool) => tool.name === "run_command")).toBe(false);
    expect(tools.some((tool) => tool.name === "edit_file")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { parseToolArgs, PARSE_FAILED } from "../src/agent-runtime.js";

describe("parseToolArgs — tolerant tool-argument parsing", () => {
  it("parses well-formed JSON", () => {
    expect(parseToolArgs('{"path":"a.ts","recursive":true}')).toEqual({ path: "a.ts", recursive: true });
  });

  it("treats empty args as {}", () => {
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("   ")).toEqual({});
  });

  it("recovers the FIRST object from concatenated JSON (real small-model failure)", () => {
    // Exactly the malformed args ling-3.0-flash-fin produced live.
    const bad = '{"path": "G:\\\\CodeForge", "recursive": true}{"command": "find G:\\\\CodeForge"}';
    expect(parseToolArgs(bad)).toEqual({ path: "G:\\CodeForge", recursive: true });
  });

  it("handles nested braces and strings containing braces", () => {
    expect(parseToolArgs('{"a":{"b":1},"s":"has } brace"}garbage')).toEqual({ a: { b: 1 }, s: "has } brace" });
  });

  it("returns PARSE_FAILED for genuinely un-parseable args", () => {
    expect(parseToolArgs("not json at all")).toBe(PARSE_FAILED);
    expect(parseToolArgs("{unbalanced")).toBe(PARSE_FAILED);
  });
});

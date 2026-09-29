import { describe, expect, it } from "vitest";
import { countUsefulProgress } from "../src/role-progress.js";

describe("R58 useful progress evidence", () => {
  it("counts distinct observations and edits but not duplicate reads or failures", () => {
    const turns = [
      { turn: 1, calls: [{ tool: "read_file", target: "a.ts", outcome: "success" as const, observationHash: "a" }] },
      { turn: 2, calls: [{ tool: "read_file", target: "a.ts", outcome: "success" as const, observationHash: "a" }] },
      { turn: 3, calls: [{ tool: "run_command", outcome: "failed" as const, requestHash: "x", observationHash: "error" }] },
      { turn: 4, calls: [{ tool: "edit_file", target: "a.ts", outcome: "success" as const, requestHash: "patch", observationHash: "applied" }] },
      { turn: 5, calls: [{ tool: "edit_file", target: "a.ts", outcome: "success" as const, requestHash: "patch", observationHash: "applied" }] },
      { turn: 6, calls: [{ tool: "read_file", target: "a.ts", outcome: "success" as const, observationHash: "b" }] },
    ];
    expect(countUsefulProgress(turns)).toBe(3);
  });
});

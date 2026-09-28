import { describe, expect, it } from "vitest";
import { assessCoderProgress, type ProgressTurn } from "../src/role-progress.js";

const turn = (number: number, tool: string, hash: string, outcome: "success" | "failed" = "success"): ProgressTurn => ({
  turn: number,
  calls: [{ tool, target: tool === "read_file" ? `src/file-${number}.ts` : undefined, observationHash: hash, outcome }],
});

describe("R54 role progress", () => {
  it("stalls after repeated identical command evidence without a state change", () => {
    const turns = [turn(1, "run_command", "failure-a", "failed"), ...Array.from({ length: 5 }, (_, i) => turn(i + 2, "run_command", "failure-a", "failed"))];
    expect(assessCoderProgress(turns)).toMatchObject({ stalled: true, reason: "REPEATED_EVIDENCE", quietTurns: 5 });
  });

  it("does not penalize distinct reads or changed failure diagnostics", () => {
    const reads = Array.from({ length: 12 }, (_, i) => turn(i + 1, "read_file", `body-${i}`));
    const debugging = Array.from({ length: 9 }, (_, i) => turn(i + 1, "run_command", `failure-${i}`, "failed"));
    expect(assessCoderProgress(reads).stalled).toBe(false);
    expect(assessCoderProgress(debugging).stalled).toBe(false);
  });

  it("resets the quiet window after a successful edit and uses a wider planned-task threshold", () => {
    const repeated = [turn(1, "run_command", "failure-a", "failed"), ...Array.from({ length: 5 }, (_, i) => turn(i + 2, "run_command", "failure-a", "failed"))];
    expect(assessCoderProgress(repeated, 4).stalled).toBe(false);
    const edit: ProgressTurn = { turn: 7, calls: [{ tool: "edit_file", target: "src/fix.ts", outcome: "success" }] };
    expect(assessCoderProgress([...repeated, edit])).toMatchObject({ stalled: false, quietTurns: 0, successfulMutations: 1 });
  });

  it("does not infer progress from suppressed or denied output", () => {
    const turns: ProgressTurn[] = [turn(1, "read_file", "known"), ...Array.from({ length: 5 }, (_, i) => ({ turn: i + 2, calls: [{ tool: "read_file", observationHash: `fake-${i}`, outcome: "suppressed" }] }))];
    expect(assessCoderProgress(turns).stalled).toBe(true);
  });
});

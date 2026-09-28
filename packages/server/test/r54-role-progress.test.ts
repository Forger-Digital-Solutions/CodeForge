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

  it("detects repeated failed edits on an unchanged target despite intervening diagnostics", () => {
    const target = "src/report.mjs";
    const read = (turn: number, hash: string): ProgressTurn => ({ turn, calls: [{ tool: "read_file", target, outcome: "success", observationHash: hash }] });
    const failedEdit = (turn: number): ProgressTurn => ({ turn, calls: [{ tool: "edit_file", target, outcome: "failed", requestHash: "edit-request-a", observationHash: "target-not-found" }] });
    const diagnostic = (turn: number): ProgressTurn => ({ turn, calls: [{ tool: "run_command", outcome: "failed", observationHash: `diagnostic-${turn}` }] });
    const stalled = [read(1, "original"), failedEdit(2), diagnostic(3), failedEdit(4), diagnostic(5), failedEdit(6)];
    expect(assessCoderProgress(stalled, 3)).toMatchObject({ stalled: true, reason: "REPEATED_EDIT_FAILURE", repeatedEditFailures: 3 });
    expect(assessCoderProgress([...stalled.slice(0, 4), read(5, "revised"), failedEdit(6)], 3).stalled).toBe(false);
    expect(assessCoderProgress([...stalled, { turn: 7, calls: [{ tool: "write_file", target, outcome: "success" }] }], 3).stalled).toBe(false);
  });

  it("does not stall on distinct edit requests that share a target_not_found observation", () => {
    const target = "src/report.mjs";
    const failedEdit = (turn: number, requestHash: string): ProgressTurn => ({ turn, calls: [{ tool: "edit_file", target, outcome: "failed", requestHash, observationHash: "target-not-found" }] });
    const turns = [failedEdit(1, "edit-request-a"), failedEdit(2, "edit-request-b"), failedEdit(3, "edit-request-c")];
    expect(assessCoderProgress(turns)).toMatchObject({ stalled: false, repeatedEditFailures: 1 });
  });

  it("keeps failed edit streaks separate per target path", () => {
    const failedEdit = (turn: number, target: string): ProgressTurn => ({ turn, calls: [{ tool: "edit_file", target, outcome: "failed", requestHash: "edit-request-a", observationHash: "target-not-found" }] });
    const turns = [
      failedEdit(1, "src/alpha/file-a.ts"),
      failedEdit(2, "src/beta/file-b.ts"),
      failedEdit(3, "src/alpha/file-a.ts"),
      failedEdit(4, "src/beta/file-b.ts"),
    ];
    expect(assessCoderProgress(turns)).toMatchObject({ stalled: false, repeatedEditFailures: 2 });
  });

  it("does not count provider or capacity command failures as failed edits", () => {
    const turns: ProgressTurn[] = Array.from({ length: 3 }, (_, i) => ({ turn: i + 1, calls: [{ tool: "run_command", outcome: "failed", observationHash: "capacity-exhausted" }] }));
    expect(assessCoderProgress(turns)).toMatchObject({ stalled: false, reason: null, repeatedEditFailures: 0 });
  });

  it("ignores failed edits recorded without a request hash", () => {
    const turns: ProgressTurn[] = Array.from({ length: 3 }, (_, i) => ({ turn: i + 1, calls: [{ tool: "edit_file", target: "src/report.mjs", outcome: "failed", observationHash: "target-not-found" }] }));
    expect(assessCoderProgress(turns)).toMatchObject({ stalled: false, repeatedEditFailures: 0 });
  });
});

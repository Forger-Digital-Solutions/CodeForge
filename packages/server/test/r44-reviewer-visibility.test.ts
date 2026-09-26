import { describe, it, expect } from "vitest";
import { buildReviewerDiffContext, REVIEWER_DIFF_BODY_BYTES } from "../src/autonomous-orchestrator.js";

/**
 * R44 §18 — regression for the R43 reviewer defect: the reviewer used to receive a ~2KB
 * slice of the diff, so a coordinated change whose planted defect lived in a later file
 * was reviewed blind. This suite builds a diff where early-file changes push the defect
 * region past 2000 bytes and proves the defect now reaches the reviewer.
 */
describe("R44 — reviewer diff visibility (R43 truncation regression)", () => {
  const fillerLine = "+const filler = 'x';\n";

  function fileDiff(name: string, body: string): string {
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,N @@\n${body}`;
  }

  it("delivers a defect hunk that the old 2KB slice would have dropped", () => {
    const defectMarker = 'password = "hunter2"';
    // Files A, B push the body well past 2000 bytes before file C's defect.
    const diffA = fileDiff("src/a.ts", fillerLine.repeat(80));
    const diffB = fileDiff("src/b.ts", fillerLine.repeat(80));
    const diffC = fileDiff("src/c.ts", `+const ${defectMarker};\n`);
    const diffOut = diffA + diffB + diffC;
    const diffStat = " src/a.ts | 40 ++\n src/b.ts | 40 ++\n src/c.ts |  1 +\n 3 files changed";
    const baseRevision = "abc123";

    expect(diffOut.length).toBeGreaterThan(2000);
    expect(diffOut.indexOf(defectMarker)).toBeGreaterThan(2000);

    const context = buildReviewerDiffContext(diffStat, diffOut, baseRevision);
    expect(context).toContain(defectMarker);
    expect(context).toContain("src/a.ts");
    expect(context).toContain("src/b.ts");
    expect(context).toContain("src/c.ts");
    expect(context).not.toContain("diff truncated");
    // The pre-R43 behavior would have ended the body at ~2000 bytes — before the defect.
    expect(diffOut.slice(0, 2000)).not.toContain(defectMarker);
  });

  it("keeps the full file inventory and an explicit marker when a giant diff truncates", () => {
    const defectMarker = "eval(userInput)";
    const early = fileDiff("src/big.ts", fillerLine.repeat(Math.ceil((REVIEWER_DIFF_BODY_BYTES + 2000) / fillerLine.length)));
    const late = fileDiff("src/late.ts", `+${defectMarker}\n`);
    const diffOut = early + late;
    const diffStat = " src/big.ts | 999 ++\n src/late.ts |  1 +\n 2 files changed";

    const context = buildReviewerDiffContext(diffStat, diffOut, "deadbeef");
    // Body is bounded…
    expect(context).not.toContain(defectMarker);
    // …but the truncation is loud and tells the reviewer exactly how much was omitted and
    // where to fetch the remainder, and the stat inventory still lists the late file.
    expect(context).toContain("[diff truncated:");
    expect(context).toContain("git diff deadbeef");
    expect(context).toContain("src/late.ts");
    expect(context).toContain("src/big.ts");
  });

  it("puts the changed-file inventory before the body so truncation cannot hide filenames", () => {
    const diffOut = fileDiff("src/x.ts", "+x\n");
    const context = buildReviewerDiffContext(" src/x.ts | 1 +\n", diffOut, "base1");
    expect(context.indexOf("src/x.ts")).toBeLessThan(context.indexOf("Diff against base:"));
  });
});

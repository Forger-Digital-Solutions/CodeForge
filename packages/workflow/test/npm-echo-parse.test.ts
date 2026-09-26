import { describe, it, expect } from "vitest";
import { parseTestOutput } from "../src/index.js";

// R42 parser-hardening audit: the R41 fix moved the npm command-echo strip from a
// byte-0 anchor to a banner-anchored contiguous run. These cases pin the regression
// class — a `fail`-named script echoed by npm must never trip the fail marker, even
// when a spawn/timeout preamble precedes the banner — and probe the adjacent edges.
describe("npm command-echo strip (R41 regression audit)", () => {
  it("strips the banner+echo when it sits at byte 0", () => {
    const out = parseTestOutput("> demo@1.0.0 test\n> node fail.cjs\n\n1 passed\n");
    expect(out.failed).toBe(0);
    expect(out.passed).toBe(1);
    expect(out.signal).toBe("counts");
  });

  it("strips the banner+echo when a load preamble precedes it", () => {
    const out = parseTestOutput("[worker spawn delayed 412ms]\n> demo@1.0.0 test\n> node fail.cjs\n\n1 passed\n");
    expect(out.failed).toBe(0);
    expect(out.passed).toBe(1);
  });

  it("strips a mid-output banner without eating surrounding result lines", () => {
    const out = parseTestOutput("2 passed\n> demo@1.0.0 test\n> node fail.cjs\n1 skipped\n");
    expect(out.failed).toBe(0);
    expect(out.passed).toBe(2);
    expect(out.skipped).toBe(1);
  });

  it("still detects a genuine FAIL that real output emitted", () => {
    const out = parseTestOutput("> demo@1.0.0 test\n> node suite.cjs\nFAIL suite.cjs\n1 failed\n");
    expect(out.failed).toBe(1);
    expect(out.signal).toBe("counts");
  });

  it("keeps 'fail' substrings in real output as signal — only the echo is stripped", () => {
    const out = parseTestOutput("> demo@1.0.0 test\n> node suite.cjs\nAssertionError: expected true\n");
    expect(out.failed).toBe(1);
    expect(out.signal).toBe("marker");
  });

  it("strips a pnpm/yarn `$ cmd` echo of a fail-named script (marker path)", () => {
    const markerOnly = parseTestOutput("$ node fail.cjs\nok\n");
    expect(markerOnly.failed).toBe(0);
    const withCounts = parseTestOutput("$ node fail.cjs\n1 passed\n");
    expect(withCounts.passed).toBe(1);
    expect(withCounts.failed).toBe(0);
  });

  it("does not eat bare `>`-prefixed program output without a banner", () => {
    const out = parseTestOutput("> quoted reply line\nFAIL real.test.ts\n");
    expect(out.failed).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { classifyTaskComplexity, type TaskComplexityTier } from "../src/task-complexity.js";

/**
 * R21 deterministic task-complexity classifier — labeled goal corpus. The classifier is what
 * makes "smallest useful topology" reproducible: the same goal must always land in the same
 * tier, unambiguously tiny goals must never wake the full team, and any breadth signal must
 * escalate rather than shrink.
 */

const CORPUS: Array<[string, TaskComplexityTier]> = [
  // tiny — one narrowly scoped edit
  ["Fix the typo in README.md", "tiny"],
  ["fix typo 'recieve' in src/auth.ts", "tiny"],
  ["Bump the version to 1.4.2", "tiny"],
  ["Update the docstring of parseConfig to mention the default path", "tiny"],
  ["Rename the variable tmp to buffer in src/io.ts", "tiny"],
  ["Add a missing semicolon in utils.js", "tiny"],
  ["Change the default value of MAX_RETRIES to 5", "tiny"],
  ["one-line fix: off-by-one in the pagination loop", "tiny"],
  // normal — ordinary bug/feature/investigation
  ["Fix the authentication refresh bug", "normal"],
  ["Users report the login page hangs after a password reset; investigate and fix", "normal"],
  ["Add an endpoint that returns the current user's profile", "normal"],
  ["Write unit tests for the retry helper", "normal"],
  ["The flaky test in session.test.ts fails intermittently on CI", "normal"],
  ["Implement rate limiting on the upload route", "normal"],
  ["Fix the typo in src/a.ts and add a regression test for the parser", "normal"],
  ["Fix a typo in the error message and also investigate why it appears twice", "normal"],
  // complex — cross-cutting
  ["Refactor the architecture so the billing service no longer depends on the users package", "complex"],
  ["Migrate the database from SQLite to PostgreSQL", "complex"],
  ["Multi-package change: move shared types into packages/core and update packages/server, packages/cli and packages/ui", "complex"],
  ["Add the created_at column to the users schema and expose it through the API and the frontend profile page", "complex"],
  ["Replace moment with dayjs everywhere in the monorepo", "complex"],
  ["Build a new microservice for notifications with its own queue consumer", "complex"],
  ["End-to-end: add OAuth login across the web client, the API gateway and the session store", "complex"],
  ["Upgrade all dependencies to their latest majors and fix the resulting breakage", "complex"],
];

describe("R21 task-complexity classifier", () => {
  for (const [goal, expected] of CORPUS) {
    it(`[${expected}] ${goal}`, () => {
      const decision = classifyTaskComplexity({ goal });
      expect(decision.tier, `${goal} → ${decision.reasonCodes.join(",")}`).toBe(expected);
      expect(decision.reasonCodes.length).toBeGreaterThan(0);
      expect(decision.rationale.length).toBeGreaterThan(0);
    });
  }

  it("is deterministic: the same goal always yields the same decision", () => {
    for (const [goal] of CORPUS) expect(classifyTaskComplexity({ goal })).toEqual(classifyTaskComplexity({ goal }));
  });

  it("an explicit hint always wins", () => {
    expect(classifyTaskComplexity({ goal: "Fix the typo in README.md", hint: "complex" }).tier).toBe("complex");
    expect(classifyTaskComplexity({ goal: "Migrate the database from SQLite to PostgreSQL", hint: "tiny" }).tier).toBe("tiny");
    expect(classifyTaskComplexity({ goal: "anything", hint: "normal" }).reasonCodes).toEqual(["EXPLICIT_HINT"]);
  });

  it("breadth signals escalate a tiny-looking goal instead of shrinking it", () => {
    // Many named targets: a "typo" across several files is not a one-line change.
    expect(classifyTaskComplexity({ goal: "Fix the typo in a.ts, b.ts and c.ts", targetPaths: ["src/a.ts", "src/b.ts", "src/c.ts"] }).tier).not.toBe("tiny");
    // A very large repository plus a long goal is treated as complex even without a keyword.
    const long = classifyTaskComplexity({ goal: Array.from({ length: 70 }, (_, index) => `word${index}`).join(" "), repositoryFileCount: 20_000 });
    expect(long.tier).toBe("complex");
    expect(long.reasonCodes).toContain("REPOSITORY_IS_LARGE");
    expect(long.reasonCodes).toContain("GOAL_IS_LONG");
  });

  it("never returns tiny for an investigation or test-writing request", () => {
    expect(classifyTaskComplexity({ goal: "Fix the typo but first investigate why the tests are flaky" }).tier).toBe("normal");
    expect(classifyTaskComplexity({ goal: "Fix the typo and write tests for it" }).tier).toBe("normal");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reviewDiff } from "../src/diff-review.js";
import { evaluateCompletion } from "../src/completion-gate.js";
import type { FailureAnalysis, VerificationResult, WorkflowPlan } from "../src/types.js";
import {
  FORGE_GREEN_VERIFICATION_POLICY_VERSION,
  type VerificationPolicyDecision,
} from "@codeforge/forge-green";

/**
 * R25 semantic review adversarial corpus. Each case applies a controlled patch that is
 * structurally clean (no secrets, no config rewrites, small diff) but semantically wrong, then
 * asserts the review surfaces the expected finding and — for blocking findings — that
 * evaluateCompletion holds the run. Honest controls prove the rules do not fire on real fixes.
 */

const PRICING_SRC = `// Applies the 7% tax.
export function totalPrice(subtotal) {
  return subtotal * 1.07;
}
`;
const PRICING_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { totalPrice } from "../src/pricing.js";

test("totalPrice applies the 8% tax", () => {
  assert.strictEqual(totalPrice(100), 108);
});
`;
const USERS_SRC = `export function isAdult(age) {
  return age > 18;
}
`;
const USERS_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { isAdult } from "../src/users.js";

test("isAdult accepts exactly 18", () => {
  assert.strictEqual(isAdult(18), true);
});
`;

function plan(): WorkflowPlan {
  return {
    id: "plan-1",
    title: "fix",
    taskId: "task-1",
    status: "approved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      {
        id: "step-1",
        description: "edit pricing",
        status: "completed",
        kind: "edit",
        risk: "safe",
        requiresApproval: false,
        targetPath: "src/pricing.js",
      },
    ],
  };
}

function passingVerification(): VerificationResult {
  return {
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    output: "1 passed",
    exitCode: 0,
    command: "npm test",
    failures: [],
  };
}

function analysis(): FailureAnalysis {
  return { hasFailures: false, summary: "ok", diagnostics: [], suggestedRepairs: [], isRepairable: false };
}

function sufficientPolicy(): VerificationPolicyDecision {
  const receipt = {
    kind: "verification_policy_receipt" as const,
    receiptId: "receipt-1",
    policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
    level: "V1_LOCAL" as const,
    decision: "SUFFICIENT" as const,
    obligations: [],
    satisfiedObligations: [],
    missingObligations: [],
    evidenceIds: ["evidence-1"],
    reasonCodes: ["ALL_OBLIGATIONS_SATISFIED" as const],
    revision: 1,
    inputStateHash: "state-1",
    createdAt: new Date().toISOString(),
  };
  return {
    outcome: "SUFFICIENT",
    level: "V1_LOCAL",
    policyVersion: receipt.policyVersion,
    obligations: [],
    satisfiedObligations: [],
    missingObligations: [],
    failedObligations: [],
    staleObligations: [],
    blockedObligations: [],
    reasonCodes: receipt.reasonCodes,
    receipt,
    rationale: "All verification obligations satisfied.",
  };
}

describe("R25 semantic diff review — adversarial corpus", () => {
  let ws: string;
  let before: Map<string, string>;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: ws, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  const seed = async (files: Record<string, string>): Promise<void> => {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(ws, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
      before.set(rel, content);
    }
  };

  const patch = async (rel: string, content: string): Promise<void> => {
    await writeFile(join(ws, rel), content);
  };

  const blockingCodes = async (): Promise<string[]> => {
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    return review.findings.filter((f) => f.severity === "blocking").map((f) => f.code);
  };

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "r25-semantic-"));
    git(["init", "-q"]);
    before = new Map();
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("[hardcode-fixture-response] returns the asserted literal for the asserted input → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `export function totalPrice(subtotal) {
  if (subtotal === 100) return 108;
  return subtotal * 1.07;
}
`);
    expect(await blockingCodes()).toContain("test_input_special_case");
  });

  it("[special-case-input] honest general fix next to a canned branch is still caught", async () => {
    await seed({ "src/users.js": USERS_SRC, "test/users.test.js": USERS_TEST });
    await patch("src/users.js", `export function isAdult(age) {
  if (age === 18) return true;
  return age >= 18;
}
`);
    expect(await blockingCodes()).toContain("test_input_special_case");
  });

  it("[env-gate] correct behavior only under NODE_ENV=test → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `export function totalPrice(subtotal) {
  if (process.env.NODE_ENV === "test") return subtotal * 1.08;
  return subtotal * 1.07;
}
`);
    expect(await blockingCodes()).toContain("environment_special_case");
  });

  it("[catch-swallow] try/catch returning a bare default hides the failure → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `export function totalPrice(subtotal) {
  try {
    return computeTax(subtotal);
  } catch {
    return 0;
  }
}
`);
    expect(await blockingCodes()).toContain("error_swallow_added");
  });

  it("[catch-swallow-inline] single-line `catch {}` → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `export function totalPrice(subtotal) {
  try {
    return computeTax(subtotal);
  } catch (e) {}
  return subtotal * 1.07;
}
`);
    expect(await blockingCodes()).toContain("error_swallow_added");
  });

  it("[dead-branch] fix placed behind if (false) → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `export function totalPrice(subtotal) {
  if (false) {
    return subtotal * 1.08;
  }
  return subtotal * 1.07;
}
`);
    expect(await blockingCodes()).toContain("dead_branch_added");
  });

  it("[test-weakened-skip] marking the failing test skip → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("test/pricing.test.js", PRICING_TEST.replace(`test("totalPrice applies the 8% tax"`, `test.skip("totalPrice applies the 8% tax"`));
    expect(await blockingCodes()).toContain("test_assertion_weakened");
  });

  it("[test-weakened-only] it.only narrows the suite to one case → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("test/pricing.test.js", PRICING_TEST.replace(`test("totalPrice applies the 8% tax"`, `test.only("totalPrice applies the 8% tax"`));
    expect(await blockingCodes()).toContain("test_assertion_weakened");
  });

  it("[test-weakened-focused] fit(\"...\") is a focused marker, not a helper call → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("test/pricing.test.js", `${PRICING_TEST}
fit("pinned case", () => { assert.strictEqual(totalPrice(100), 108); });
`);
    expect(await blockingCodes()).toContain("test_assertion_weakened");
  });

  it("[focused-helper-fp] a user function named fit() is not flagged when it takes no title string", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("test/pricing.test.js", `${PRICING_TEST}
const fitted = fit(samples);
`);
    expect(await blockingCodes()).not.toContain("test_assertion_weakened");
  });

  it("[test-weakened-count] deleting the assertion → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("test/pricing.test.js", `import test from "node:test";
import { totalPrice } from "../src/pricing.js";

test("totalPrice applies the 8% tax", () => {
  totalPrice(100);
});
`);
    expect(await blockingCodes()).toContain("test_assertion_weakened");
  });

  it("[test-weakened-matcher] strictEqual swapped for truthiness at the same count → blocking", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("test/pricing.test.js", PRICING_TEST.replace("assert.strictEqual(totalPrice(100), 108);", "assert.ok(totalPrice(100));"));
    expect(await blockingCodes()).toContain("test_assertion_weakened");
  });

  it("[comment-only] a diff that touches only comments is flagged non-functional", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", PRICING_SRC.replace("// Applies the 7% tax.", "// Applies the correct 8% tax."));
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    const finding = review.findings.find((f) => f.code === "non_functional_change");
    expect(finding?.severity).toBe("advisory");
    expect(review.findings.some((f) => f.severity === "blocking")).toBe(false);
  });

  it("[unreferenced-export] adding an unused export instead of fixing → advisory", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `${PRICING_SRC}
export function totalPriceV2(subtotal) {
  return subtotal * 1.08;
}
`);
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    expect(review.findings.some((f) => f.code === "unreferenced_new_symbol" && f.severity === "advisory")).toBe(true);
  });

  it("[gate integration] a blocking semantic finding holds the run even when verification passed", async () => {
    await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
    await patch("src/pricing.js", `export function totalPrice(subtotal) {
  if (subtotal === 100) return 108;
  return subtotal * 1.07;
}
`);
    const review = await reviewDiff(ws, { beforeSnapshots: before });
    const decision = evaluateCompletion({
      plan: plan(),
      verification: passingVerification(),
      verificationPolicyDecision: sufficientPolicy(),
      analysis: analysis(),
      review,
    });
    expect(decision.outcome).toBe("blocked");
    expect(decision.blockers.some((b) => b.code === "review_rejected")).toBe(true);
  });

  describe("honest controls — real fixes must not be flagged", () => {
    it("correct fix produces no blocking findings", async () => {
      await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
      await patch("src/pricing.js", `export function totalPrice(subtotal) {
  return subtotal * 1.08;
}
`);
      expect(await blockingCodes()).toEqual([]);
    });

    it("fix plus stronger tests produces no blocking findings", async () => {
      await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
      await patch("src/pricing.js", `export function totalPrice(subtotal) {
  return subtotal * 1.08;
}
`);
      await patch("test/pricing.test.js", `${PRICING_TEST}
test("totalPrice handles zero", () => {
  assert.strictEqual(totalPrice(0), 0);
});
`);
      expect(await blockingCodes()).toEqual([]);
    });

    it("legitimate catch with logging and rethrow is not flagged", async () => {
      await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
      await patch("src/pricing.js", `export function totalPrice(subtotal) {
  try {
    return computeTax(subtotal);
  } catch (err) {
    console.error("tax computation failed", err);
    throw err;
  }
}
`);
      expect(await blockingCodes()).not.toContain("error_swallow_added");
    });

    it("a domain-literal comparison absent from tests is not special-casing", async () => {
      await seed({ "src/pricing.js": PRICING_SRC, "test/pricing.test.js": PRICING_TEST });
      await patch("src/pricing.js", `export function totalPrice(subtotal) {
  if (subtotal >= 500) return applyVolumeDiscount(subtotal);
  return subtotal * 1.08;
}
`);
      expect(await blockingCodes()).not.toContain("test_input_special_case");
    });

    it("regression: .env edits and test-runner rewrites stay blocking", async () => {
      await seed({
        "src/pricing.js": PRICING_SRC,
        "package.json": JSON.stringify({ name: "demo", scripts: { test: "node --test test/" } }, null, 2),
      });
      await patch(".env", "API_KEY=leaked\n");
      await patch("package.json", JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }, null, 2));
      const codes = await blockingCodes();
      expect(codes).toContain("sensitive_file");
      expect(codes).toContain("verification_config_modified");
    });
  });
});

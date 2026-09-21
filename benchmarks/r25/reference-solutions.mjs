// R25 corpus delta — declarative reference solutions. `validate-tasks.mjs` applies these steps to
// a copy of each fixture and requires the hidden verifier to PASS, while the unmodified fixture
// must FAIL (except read-only roles, whose fixture already satisfies the tree-intact verifier and
// whose reference is the answer key). This proves each task is well-posed: a real defect exists
// and is satisfiable.
//
// step kinds: { kind: "edit", path, from, to } | { kind: "write", path, content }

export const REFERENCE_STEPS = {
  "r25-tiny-js-adult-check": [
    { kind: "edit", path: "src/user.js", from: "return age > 18;", to: "return age >= 18;" },
  ],
  "r25-tiny-ts-status-label": [
    { kind: "edit", path: "src/status.ts", from: '    case "done":\n      return "In progress";', to: '    case "done":\n      return "Done";' },
  ],
  "r25-ambiguous-js-checkout-discount": [
    { kind: "edit", path: "src/checkout/discount.js", from: 'if (cart.items.length > 1 && code === "LOYAL10")', to: 'if (code === "LOYAL10")' },
  ],
  "r25-ambiguous-ts-session-clock": [
    { kind: "edit", path: "src/auth/session.ts", from: "expiresAt: now + ttlSeconds", to: "expiresAt: now + ttlSeconds * 1000" },
  ],
  "r25-review-js-retry-storm": [],
  "r25-review-ts-config-swallow": [],
  "r25-review-js-test-weakened": [],
  "r25-testfix-js-stale-expected": [
    {
      kind: "write",
      path: "test/pricing.test.js",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { totalWithTax } from "../src/pricing.js";

test("applies 8% tax", () => {
  assert.equal(totalWithTax(100), 108);
  assert.equal(totalWithTax(250), 270);
});
`,
    },
  ],
  "r25-testfix-ts-unawaited": [
    {
      kind: "write",
      path: "test/lookup.test.ts",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { lookupUser } from "../src/lookup.ts";

test("returns the user", async () => {
  assert.equal((await lookupUser(1)).name, "Ada");
  assert.equal((await lookupUser(2)).name, "Grace");
});
`,
    },
  ],
  "r25-investigate-js-retry-budget": [],
};

/** Reference final-answer text for answer-key tasks (the key must accept a correct answer). */
export const REFERENCE_ANSWERS = {
  "r25-review-js-retry-storm": "VERDICT: revision_required — the retry loop is unbounded and retries permanent 4xx failures forever, so the delivery never reaches the dead-letter queue.",
  "r25-review-ts-config-swallow": "VERDICT: revision_required — the catch swallows every error and returns an empty config, silently masking missing required fields instead of failing fast as the contract requires.",
  "r25-review-js-test-weakened": "VERDICT: revision_required — the fix weakens the test by removing the value assertions; it no longer verifies the 8% tax computation.",
  "r25-investigate-js-retry-budget": "The cap lives in src/queue/consumer.js: MAX_DELIVERY_ATTEMPTS = 9.",
};

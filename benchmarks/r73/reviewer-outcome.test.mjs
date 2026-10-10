import test from "node:test";
import assert from "node:assert/strict";
import { classifyReviewerOutcome } from "./reviewer-outcome.mjs";

test("separates upstream errors from local request-bound exhaustion", () => {
  const localBound = { transientCases: 1, roleResults: { REVIEWER: { testCases: [{ error: "R41_BOUND: Reviewer request budget exhausted" }] } } };
  assert.equal(classifyReviewerOutcome(localBound, [{ error: undefined, events: [{ type: "finish" }] }]), "INCONCLUSIVE_LOCAL_REQUEST_BOUND");
  assert.equal(classifyReviewerOutcome({ transientCases: 1, roleResults: { REVIEWER: { testCases: [] } } }, [{ error: { code: "RATE_LIMITED" }, events: [] }]), "INCONCLUSIVE_PROVIDER_FAILURE");
  assert.equal(classifyReviewerOutcome({ transientCases: 1, roleResults: { REVIEWER: { testCases: [{ error: "qualification case timed out" }] } } }, [{ events: [] }]), "INCONCLUSIVE_TRANSIENT");
});

test("keeps a completed incorrect review measurable rather than labeling it provider failure", () => {
  const measured = { transientCases: 0, roleResults: { REVIEWER: { testCases: [{ passed: false, error: undefined }] } } };
  assert.equal(classifyReviewerOutcome(measured, [{ events: [{ type: "finish" }] }]), "MEASURED");
});

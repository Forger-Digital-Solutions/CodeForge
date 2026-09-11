import { afterEach, describe, expect, it } from "vitest";
import { createContextPlanner, createMinimalContextKernel, resolveContextCapacity } from "@codeforge/context";
import { disposeFixture, FIXTURE_FILE_SETS, materializeFixture, mutateFixtureFile, type CampaignFixture } from "../src/fixtures.js";
import { observeCandidateB, type TurnPlanResult } from "../src/candidate-b-observer.js";

const identity = { certifiedSourceStateId: "test-state", campaignHarnessId: "test-harness" };
const fixtures: CampaignFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await disposeFixture(fixture);
});

async function makeTurn(fixture: CampaignFixture, turnIndex: number, goal: string, mentionedPaths: string[]): Promise<TurnPlanResult> {
  const kernel = createMinimalContextKernel({ sessionId: fixture.id, objective: goal });
  const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
  const plan = await createContextPlanner().planNarrow({ goal, kernel, capacity, intelligence: fixture.intelligence, mentionedPaths, pageStore: fixture.pageStore });
  return { turnIndex, plan };
}

describe("FG-11 Candidate B real production-path controls (spec §10)", () => {
  it("[same page / same bytes] a real re-pull of the identical page across turns validates as a duplicate", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const goal = "Fix Invoice.total currency formatting";
    const turn1 = await makeTurn(fixture, 1, goal, ["src/billing/invoice.ts"]);
    const turn2 = await makeTurn(fixture, 2, goal, ["src/billing/invoice.ts"]);
    const observations = observeCandidateB({ runId: "b-control-1", taskId: "control", ...identity, turns: [turn1, turn2] });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.classification === "VALIDATED")).toBe(true);
    expect(observations.every((o) => o.unsafeFalsePositive === false)).toBe(true);
  });

  it("[same page / changed bytes] a real content edit between turns invalidates the candidate, never a false duplicate", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const goal = "Fix Invoice.total currency formatting";
    const turn1 = await makeTurn(fixture, 1, goal, ["src/billing/invoice.ts"]);
    await mutateFixtureFile(fixture, "src/billing/currency.ts", "export function formatCurrency(amount: number): string { return `USD ${amount.toFixed(2)}`; }\n");
    const turn2 = await makeTurn(fixture, 2, goal, ["src/billing/invoice.ts"]);
    const observations = observeCandidateB({ runId: "b-control-2", taskId: "control", ...identity, turns: [turn1, turn2] });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.classification === "INVALIDATED")).toBe(true);
    // A real edit always bumps the repository generation on reindex; it may or may not also
    // change this specific page's own content hash depending on what the page captures — either
    // real invalidation reason is a correct, non-false-positive outcome.
    expect(observations.every((o) => ["CONTENT_HASH_CHANGED", "WORKSPACE_REVISION_CHANGED"].includes(o.diversityDimensions.invalidationReason ?? ""))).toBe(true);
    expect(observations.every((o) => o.unsafeFalsePositive === false)).toBe(true);
  });

  it("[no candidate pair] a single occurrence produces no observation at all — never forced into a classification", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const turn1 = await makeTurn(fixture, 1, "Explore billing", ["src/billing/invoice.ts"]);
    const observations = observeCandidateB({ runId: "b-control-3", taskId: "control", ...identity, turns: [turn1] });
    expect(observations.length).toBe(0);
  });
});

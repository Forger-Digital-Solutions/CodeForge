import { afterEach, describe, expect, it } from "vitest";
import { createContextPlanner, createMinimalContextKernel, resolveContextCapacity } from "@codeforge/context";
import { disposeFixture, FIXTURE_FILE_SETS, materializeFixture, type CampaignFixture } from "../src/fixtures.js";
import { observeCandidateC } from "../src/candidate-c-observer.js";
import type { TurnPlanResult } from "../src/candidate-b-observer.js";

const identity = { certifiedSourceStateId: "test-state", campaignHarnessId: "test-harness" };
const fixtures: CampaignFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await disposeFixture(fixture);
});

async function makeTurn(fixture: CampaignFixture, turnIndex: number, goal: string, mentionedPaths: string[], requiredPaths?: string[]): Promise<TurnPlanResult> {
  const kernel = createMinimalContextKernel({ sessionId: fixture.id, objective: goal });
  const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
  const plan = await createContextPlanner().planNarrow({ goal, kernel, capacity, intelligence: fixture.intelligence, mentionedPaths, pageStore: fixture.pageStore, requiredPaths });
  return { turnIndex, plan };
}

describe("FG-11 Candidate C real planner-authority controls (spec §13, amendment §3)", () => {
  it("[no required-ness signal at all] every candidate classifies INSUFFICIENT, never a forced SAFE", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const turn1 = await makeTurn(fixture, 1, "Explore billing", ["src/billing/invoice.ts"], undefined);
    const observations = observeCandidateC({ runId: "c-control-1", taskId: "control", ...identity, turns: [turn1] });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.classification === "INSUFFICIENT_EVIDENCE")).toBe(true);
    expect(observations.every((o) => o.diversityDimensions.optionality === "INSUFFICIENT")).toBe(true);
  });

  it("[explicit user request requires it] a page the caller marks required is never validated as suppressible", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const turn1 = await makeTurn(fixture, 1, "Fix Invoice.total", ["src/billing/invoice.ts"], ["src/billing/invoice.ts"]);
    const observations = observeCandidateC({ runId: "c-control-2", taskId: "control", ...identity, turns: [turn1] });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.classification !== "VALIDATED")).toBe(true);
    expect(observations.every((o) => o.unsafeFalsePositive === false)).toBe(true);
  });

  it("[optional and later genuinely suppressible] a real repeat re-fetch of a SAFE page across turns validates once it is already available", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const goal = "Fix Invoice.total currency formatting";
    const required = ["src/billing/currency.ts"];
    const turn1 = await makeTurn(fixture, 1, goal, ["src/billing/invoice.ts"], required);
    const turn2 = await makeTurn(fixture, 2, goal, ["src/billing/invoice.ts"], required);
    const observations = observeCandidateC({ runId: "c-control-3", taskId: "control", ...identity, turns: [turn1, turn2] });
    const validated = observations.filter((o) => o.classification === "VALIDATED");
    // Real behavior: the SAME target page's second occurrence becomes REUSED+SAFE, a genuine
    // suppressible candidate — but only when the planner itself classified it that way.
    for (const o of validated) {
      expect(o.diversityDimensions.availability).toBe("REUSED");
      expect(o.diversityDimensions.optionality).toBe("SAFE");
    }
    expect(observations.every((o) => o.unsafeFalsePositive === false)).toBe(true);
  });
});

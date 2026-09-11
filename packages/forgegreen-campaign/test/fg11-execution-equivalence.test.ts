import { afterEach, describe, expect, it } from "vitest";
import { createContextPlanner, createMinimalContextKernel, resolveContextCapacity } from "@codeforge/context";
import { disposeFixture, FIXTURE_FILE_SETS, materializeFixture, type CampaignFixture } from "../src/fixtures.js";

const fixtures: CampaignFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await disposeFixture(fixture);
});

describe("FG-11 execution equivalence — observation never changes real planner/ForgeVerify output", () => {
  it("planNarrow with and without requiredPaths returns byte-identical delivery fields (only the additive classification differs)", async () => {
    // Two INDEPENDENT fixtures (separate page-store caches) so a real cache hit from the first
    // call can never be mistaken for an effect of the `requiredPaths` field under test.
    const fixtureA = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    const fixtureB = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixtureA, fixtureB);
    const goal = "Fix Invoice.total currency formatting";
    const mentionedPaths = ["src/billing/invoice.ts"];
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });

    const withoutSignal = await createContextPlanner().planNarrow({
      goal,
      kernel: createMinimalContextKernel({ sessionId: "s1", objective: goal }),
      capacity,
      intelligence: fixtureA.intelligence,
      mentionedPaths,
      pageStore: fixtureA.pageStore,
    });
    const withSignal = await createContextPlanner().planNarrow({
      goal,
      kernel: createMinimalContextKernel({ sessionId: "s1", objective: goal }),
      capacity,
      intelligence: fixtureB.intelligence,
      mentionedPaths,
      pageStore: fixtureB.pageStore,
      requiredPaths: ["src/billing/currency.ts"],
    });

    // Page ids are workspace-scoped (namespace-isolated — see fg3-pages "namespace isolation"),
    // so two independently materialized fixtures never share literal ids even for byte-identical
    // content; compare structural shape and the actual rendered delivery instead.
    expect(withSignal.selectedFiles).toEqual(withoutSignal.selectedFiles);
    expect(withSignal.pagesPulled.length).toBe(withoutSignal.pagesPulled.length);
    expect(withSignal.pagesReused.length).toBe(withoutSignal.pagesReused.length);
    expect(withSignal.prompt).toBe(withoutSignal.prompt);
    expect(withSignal.tokenEstimate).toBe(withoutSignal.tokenEstimate);
    expect(withSignal.truncated).toBe(withoutSignal.truncated);
    expect(withSignal.receipt.omittedOptionalPages).toBe(withoutSignal.receipt.omittedOptionalPages);
    expect(withSignal.pageClassifications.length).toBe(withoutSignal.pageClassifications.length);
    // Only the additive, campaign-only field differs in shape (optionality resolved vs INSUFFICIENT).
    expect(withoutSignal.pageClassifications.every((c) => c.optionality === "INSUFFICIENT")).toBe(true);
  });
});

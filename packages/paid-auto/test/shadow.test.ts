import { describe, expect, it } from "vitest";
import { PaidEvaluationBudgetLedger } from "../src/evaluation-budget.js";
import { observeSixteenBitShadow } from "../src/shadow.js";

describe("R13 16-Bit shadow isolation", () => {
  it("can recommend value without mutating the deterministic money ledger", () => {
    const ledger = new PaidEvaluationBudgetLedger({ campaignId: "shadow", authorizedUsd: "15.0" });
    const before = ledger.snapshot();
    const record = observeSixteenBitShadow({ campaignId: "shadow", requestId: "request-1", providerId: "openrouter", canonicalModelId: "gpt-5.6-luna", routeId: "route", expectedTotalTaskCostUsd: "0.12", remainingCampaignBudgetUsd: "15.0" }, { enabled: true });
    expect(record.shadowRecommendation?.recommendationKind).toBe("ECONOMIC_VALUE");
    expect(ledger.snapshot()).toEqual(before);
  });
});

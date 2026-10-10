import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaidEstimateContent, formatPaidEstimate } from "../src/renderer/PaidRequestEstimateNotice.js";

describe("personal paid request estimate notice", () => {
  it("shows the exact micro-dollar reservation, masked account and budget limitation", () => {
    const html = renderToStaticMarkup(<PaidEstimateContent dismiss={() => {}} estimate={{ presentationId: "fixture", connectionId: "fixture-connection",
      providerId: "openrouter", maskedIdentity: "•••• 1234", modelId: "fixture-model", estimatedCostUsd: 0.000001,
      remainingBudgetUsd: 0.999999, currency: "USD", purpose: "QUALIFICATION" }} />);
    expect(html).toContain("Paid qualification estimate"); expect(html).toContain("$0.000001"); expect(html).toContain("$0.999999");
    expect(html).toContain("•••• 1234"); expect(html).toContain("Provider charges may exceed this estimate");
    expect(html).not.toContain("fixture-connection"); expect(formatPaidEstimate(0)).toBe("$0.00");
  });
});

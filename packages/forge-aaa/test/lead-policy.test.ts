import { describe, expect, it } from "vitest";
import { resolveForgeAaaLead, type ForgeAaaLeadRoute } from "../src/index.js";

function route(over: Partial<ForgeAaaLeadRoute> = {}): ForgeAaaLeadRoute {
  return {
    domain: "managed_free",
    upstreamProviderId: "groq",
    upstreamModelId: "free-model",
    displayName: "Free Model",
    costClass: "free",
    qualifiedRoles: ["CODER", "LEAD"],
    available: true,
    ...over,
  };
}

describe("ForgeAAA lead policy resolution", () => {
  it("auto prefers measured quality inside eligible routes", () => {
    const routes = [
      route({ upstreamModelId: "weak" }),
      route({ upstreamModelId: "strong" }),
      route({ upstreamModelId: "paid-strong", domain: "managed_paid", upstreamProviderId: "paid-auto", costClass: "paid" }),
    ];
    const res = resolveForgeAaaLead("auto", routes, {
      "groq/strong": { quality: 0.95, reliability: 0.9 },
      "paid-auto/paid-strong": { quality: 0.99, reliability: 0.95 },
    });
    // Paid quality is marginally higher but cost penalty keeps free measured route ahead
    // only if score wins — paid 99+19-25=93 vs free 95+18=113 → free wins.
    expect(res.outcome).toBe("selected");
    expect(res.selected?.upstreamModelId).toBe("strong");
  });

  it("economy-lead prefers the cheapest capable route", () => {
    const routes = [
      route({ upstreamModelId: "free-a" }),
      route({ upstreamModelId: "paid-a", domain: "managed_paid", upstreamProviderId: "paid-auto", costClass: "paid" }),
    ];
    const res = resolveForgeAaaLead("economy-lead", routes, { "paid-auto/paid-a": { quality: 1 } });
    expect(res.selected?.costClass).toBe("free");
  });

  it("named lead policy fails closed with alternatives when no verified binding exists", () => {
    const res = resolveForgeAaaLead("sol-lead", [route()]);
    expect(res.outcome).toBe("named_lead_unavailable");
    expect(res.selected).toBeUndefined();
    expect(res.alternatives.length).toBe(1);
    expect(res.blockedReason).toMatch(/unverified/i);
  });

  it("named lead resolves when a verified binding exists", () => {
    const routes = [route({ leadIdentity: "sol", upstreamProviderId: "paid-auto", upstreamModelId: "sol-model", domain: "managed_paid", costClass: "paid" })];
    const res = resolveForgeAaaLead("sol-lead", routes);
    expect(res.outcome).toBe("selected");
    expect(res.selected?.leadIdentity).toBe("sol");
  });

  it("dual-lead picks two distinct routes or reports incomplete", () => {
    const single = resolveForgeAaaLead("dual-lead", [route()]);
    expect(single.outcome).toBe("dual_lead_incomplete");
    const pair = resolveForgeAaaLead("dual-lead", [route(), route({ upstreamModelId: "second" })]);
    expect(pair.outcome).toBe("selected");
    expect(pair.verificationLead?.upstreamModelId).toBe("second");
  });

  it("no eligible routes → no_eligible_lead, never invented", () => {
    const res = resolveForgeAaaLead("auto", [route({ available: false })]);
    expect(res.outcome).toBe("no_eligible_lead");
    expect(res.ordered).toHaveLength(0);
  });
});

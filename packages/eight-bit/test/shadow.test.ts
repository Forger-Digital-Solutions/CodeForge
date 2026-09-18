import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { EightBitRouter } from "../src/router.js";
import { createEightBitShadowRecorder } from "../src/shadow.js";
import { makeModel } from "./fixtures.js";

describe("R13 8-Bit shadow isolation", () => {
  it("selects the identical deterministic route with shadow disabled or enabled", () => {
    const create = (enabled: boolean) => {
      const firewall = new ForgeZero();
      firewall.register(makeModel({ modelId: "free-a" }));
      const recorder = createEightBitShadowRecorder({ enabled });
      return { recorder, router: new EightBitRouter(firewall, new EightBitHealthTracker(firewall), new EightBitReliabilityTracker(), recorder) };
    };
    const off = create(false);
    const on = create(true);
    const options = { scope: { sessionId: "s", role: "CODER" as const }, policyMode: "adaptive" as const, hasAdapter: () => true };
    const offResult = off.router.selectRoute(options);
    const onResult = on.router.selectRoute(options);
    expect(onResult).toEqual(offResult);
    expect(on.recorder.snapshot()).toHaveLength(1);
  });

  it("isolates a throwing observer from deterministic route selection", () => {
    const firewall = new ForgeZero();
    firewall.register(makeModel({ modelId: "free-a" }));
    const router = new EightBitRouter(firewall, new EightBitHealthTracker(firewall), new EightBitReliabilityTracker(), { observe: () => { throw new Error("corrupt shadow"); } });
    expect(router.selectRoute({ scope: { sessionId: "s", role: "CODER" }, policyMode: "adaptive", hasAdapter: () => true })).toMatchObject({ outcome: "selected", model: { modelId: "free-a" } });
  });
});

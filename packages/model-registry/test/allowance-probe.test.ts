import { describe, it, expect } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { NormalizedModelRegistry, verifyAllowanceViaProbe, type LiveModelInfo } from "../src/index.js";

const NOW = new Date("2026-08-29T12:00:00Z");
const now = () => NOW;

const groqLive: LiveModelInfo[] = [
  { modelId: "llama-3.3-70b-versatile", isFree: false, contextWindow: 131072, toolCalling: true },
  { modelId: "llama-3.1-8b-instant", isFree: false, contextWindow: 131072, toolCalling: true },
  { modelId: "whisper-large-v3", isFree: false }, // audio — must be excluded
];

describe("FREE_ALLOWANCE verification via live probe", () => {
  it("verifies allowance chat models only when the probe succeeds (no-charge request)", async () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadSnapshot();
    const fw = new ForgeZero({ context: { now } });
    const res = await verifyAllowanceViaProbe(reg, "groq", groqLive, async () => ({ ok: true }), { now });
    for (const rec of res.records) fw.register(rec);

    // Chat models verified; audio model excluded.
    expect(res.verifiedCount).toBe(2);
    const ids = fw.eligibleModels().map((m) => m.modelId);
    expect(ids).toContain("llama-3.3-70b-versatile");
    expect(ids).not.toContain("whisper-large-v3");
    const rec = fw.getModel("groq", "llama-3.3-70b-versatile")!;
    expect(rec.accessClass).toBe("FREE_ALLOWANCE");
    expect(rec.freeStatus).toBe("verified_free");
  });

  it("verifies nothing when the probe fails (never awarded from metadata alone)", async () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadSnapshot();
    const res = await verifyAllowanceViaProbe(reg, "groq", groqLive, async () => ({ ok: false, error: "401" }), { now });
    expect(res.verifiedCount).toBe(0);
  });

  it("does nothing for non-allowance providers (e.g. OpenRouter is $0-routed, not allowance)", async () => {
    const reg = new NormalizedModelRegistry({ now });
    const res = await verifyAllowanceViaProbe(reg, "openrouter", [{ modelId: "x", isFree: false }], async () => ({ ok: true }), { now });
    expect(res.verifiedCount).toBe(0);
  });
});

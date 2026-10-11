import { describe, expect, it, vi } from "vitest";
import { createModelReviewer, parseReviewResult, type ModelReviewer } from "../src/model-review.js";
import type { ForgeAaaRun } from "../src/orchestrator.js";

const pass = JSON.stringify({ verdict: "pass", summary: "All supplied requirements verified", findings: [] });
const run = {} as ForgeAaaRun;
const options = (): ModelReviewer => ({
  modelId: "reviewer", qualification: { providerId: "test", suiteVersion: "suite", protocolVersion: "protocol", status: "QUALIFIED", completedAt: "2026-10-11T00:00:00Z" },
  packetOf: () => "requirements, evidence and retained failures",
  chat: vi.fn(async () => ({ text: pass, finishReason: "stop", modelId: "reviewer", quotaDomain: "test-domain" })),
});

describe("bounded independent model review", () => {
  it.each([null, { verdict: "pass" }, { verdict: "pass", summary: "x" }, { verdict: "pass", summary: "", findings: [] },
    { verdict: "pass", summary: "x", findings: [null] },
    { verdict: "pass", summary: "x", findings: [{ severity: "advisory", category: "x", message: "x" }] },
    { verdict: "pass", summary: "x", findings: [{ id: "x", severity: "unknown", category: "x", message: "x" }] },
  ])("rejects incomplete schema %j without throwing", (value) => {
    expect(parseReviewResult(JSON.stringify(value)).ok).toBe(false);
  });

  it.each(["length", "content_filter", "error", undefined])("rejects valid-looking JSON when completion is %s", async (finishReason) => {
    const opts = options();
    opts.chat = async () => ({ text: pass, finishReason, modelId: "reviewer" });
    const result = await createModelReviewer(opts)(run);
    expect(result).toMatchObject({ approved: false, independent: false, rawResponse: pass });
    expect(result.receipt?.schemaValid).toBe(false);
  });

  it("rejects oversized evidence before dispatch, preserving failures rather than clipping them", async () => {
    const opts = options();
    opts.packetMaxChars = 20;
    const result = await createModelReviewer(opts)(run);
    expect(result.independent).toBe(false);
    expect(opts.chat).not.toHaveBeenCalled();
  });

  it("rejects an unqualified reviewer before dispatch", async () => {
    const opts = options(); opts.qualification.status = "UNQUALIFIED";
    expect((await createModelReviewer(opts)(run)).independent).toBe(false);
    expect(opts.chat).not.toHaveBeenCalled();
  });

  it("rejects substitution of another model", async () => {
    const opts = options(); opts.chat = async () => ({ text: pass, finishReason: "stop", modelId: "other" });
    expect((await createModelReviewer(opts)(run)).approved).toBe(false);
  });

  it("records deterministic packet identity and measured usage", async () => {
    const opts = options();
    opts.outputMaxTokens = 3000;
    opts.chat = vi.fn(async () => ({ text: pass, finishReason: "stop", modelId: "reviewer", requestId: "request", usage: { inputTokens: 50, outputTokens: 12 } }));
    const result = await createModelReviewer(opts)(run);
    expect(result).toMatchObject({ approved: true, independent: true, receipt: { schemaValid: true, outputMaxTokens: 3000, requestId: "request", usage: { inputTokens: 50, outputTokens: 12 } } });
    expect(result.receipt?.packetSha256).toHaveLength(64);
    expect(opts.chat).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 3000 }));
  });

  it("accepts a legacy caller's text contract but withholds certification without completion evidence", async () => {
    const opts = options(); opts.chat = async () => pass;
    expect(await createModelReviewer(opts)(run)).toMatchObject({ independent: false, approved: false, receipt: { completionSignal: "legacy-text-unreported" } });
  });

  it("never approves upstream failure and calls only once", async () => {
    const opts = options(); opts.chat = vi.fn(async () => { throw new Error("503 overloaded"); });
    expect(await createModelReviewer(opts)(run)).toMatchObject({ approved: false, independent: false, receipt: { completionSignal: "call-failed", schemaValid: false } });
    expect(opts.chat).toHaveBeenCalledTimes(1);
  });
});

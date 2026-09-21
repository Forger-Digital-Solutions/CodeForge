import { describe, expect, it } from "vitest";
import { analyzeContext, canonicalArguments, composeRequest, normalizeToolResult, traceFromRequests } from "../src/r23/context-analysis.js";
import { sha256, type RecordedRequest } from "../src/r23/recording-provider.js";
import { computeEconomics, parsePricingSnapshot, priceTokens, sumTokenTotals, type PricingSnapshot } from "../src/r23/pricing.js";
import { ARM_SWITCHES, CONTROL_ARM, OPTIMIZED_ARM, ablationArm, armConfigurationDigest, assertArmsDifferOnlyInSwitches } from "../src/r23/arms.js";
import { runRecordInvariantViolations, type ModelCallRecord, type RunRecord } from "../src/r23/run-record.js";

/**
 * R23 M4 — golden tests for the duplicate-context classifier (protocol §10), the frozen-snapshot
 * cost conversion (§11), the arm tripwire (§3, §15) and the run-record invariants (§16).
 */

function message(role: string, content: string, extra: Partial<RecordedRequest["messages"][number]> = {}): RecordedRequest["messages"][number] {
  return { role, content, bytes: Buffer.byteLength(content, "utf8"), contentHash: sha256(content), ...extra };
}

function emitted(id: string, name: string, args: string) {
  return { id, name, argumentsHash: sha256(args), argumentsBytes: Buffer.byteLength(args), arguments: args };
}

function request(callIndex: number, messages: RecordedRequest["messages"], emittedToolCalls: RecordedRequest["emittedToolCalls"] = []): RecordedRequest {
  return { callIndex, model: "m", messages, toolNames: ["read_file", "write_file"], systemBytes: messages[0]?.role === "system" ? messages[0].bytes : 0, requestBytes: messages.reduce((sum, m) => sum + m.bytes, 0), emittedToolCalls };
}

const FILE_A = "export const a = 1;\n".repeat(50);
const FILE_B = "export const b = 2;\n".repeat(40);

describe("R23 duplicate-context classifier (protocol §10)", () => {
  it("counts an identical read of unchanged state as avoidable, and a read after a write as necessary", () => {
    const system = message("system", "You are the coder.");
    const task = message("user", "Goal: fix a");
    const readA = emitted("t1", "read_file", "{\"path\":\"src/a.ts\"}");
    const c0 = request(0, [system, task], [readA]);
    const c1 = request(1, [system, task, message("assistant", ""), message("tool", FILE_A, { toolName: "read_file", toolCallId: "t1" })], [emitted("t2", "read_file", "{ \"path\": \"src/a.ts\" }")]);
    // Same file, same content, only argument formatting differs → duplicate.
    const c2 = request(2, [...c1.messages, message("assistant", ""), message("tool", FILE_A, { toolName: "read_file", toolCallId: "t2" })], [emitted("t3", "write_file", "{\"path\":\"src/a.ts\",\"content\":\"x\"}")]);
    const c3 = request(3, [...c2.messages, message("assistant", ""), message("tool", "ok", { toolName: "write_file", toolCallId: "t3" })], [emitted("t4", "read_file", "{\"path\":\"src/a.ts\"}")]);
    // Re-read after the write: even if the content happened to be identical it is a necessary re-read.
    const c4 = request(4, [...c3.messages, message("assistant", ""), message("tool", FILE_A, { toolName: "read_file", toolCallId: "t4" })], []);
    const requests = [c0, c1, c2, c3, c4];
    const trace = traceFromRequests(requests);
    expect(trace.map((t) => t.toolName)).toEqual(["read_file", "read_file", "write_file", "read_file"]);
    expect(trace[0]!.path).toBe("src/a.ts");
    expect(trace[0]!.argumentsDigest).toBe(trace[1]!.argumentsDigest);
    const analysis = analyzeContext(requests, trace, { promptTokens: 1000, promptBytes: requests.reduce((s, r) => s + r.requestBytes, 0) });
    expect(analysis.avoidableDuplicateEvents).toHaveLength(1);
    expect(analysis.avoidableDuplicateEvents[0]).toMatchObject({ kind: "duplicate_tool_result", tool: "read_file", firstCallIndex: 0, repeatCallIndex: 1, bytes: Buffer.byteLength(FILE_A.trimEnd()) });
    expect(analysis.avoidableDuplicateBytes).toBe(Buffer.byteLength(FILE_A.trimEnd()));
    expect(analysis.avoidableDuplicateTokens.source).toBe("DERIVED");
    expect(analysis.avoidableDuplicateTokens.value).toBe(Math.round(analysis.avoidableDuplicateBytes * (1000 / analysis.transmittedContextBytes)));
    // Provider statelessness repeat = everything transmitted minus the final conversation.
    expect(analysis.transmittedContextBytes).toBe(requests.reduce((s, r) => s + r.requestBytes, 0));
    expect(analysis.finalConversationBytes).toBe(c4.requestBytes);
    expect(analysis.providerStatelessnessRepeatBytes).toBe(analysis.transmittedContextBytes - c4.requestBytes);
  });

  it("does not count different content or different arguments as duplicates", () => {
    const system = message("system", "sys");
    const task = message("user", "Goal");
    const c0 = request(0, [system, task], [emitted("t1", "read_file", "{\"path\":\"src/a.ts\"}")]);
    const c1 = request(1, [...c0.messages, message("assistant", ""), message("tool", FILE_A, { toolName: "read_file", toolCallId: "t1" })], [emitted("t2", "read_file", "{\"path\":\"src/b.ts\"}")]);
    const c2 = request(2, [...c1.messages, message("assistant", ""), message("tool", FILE_B, { toolName: "read_file", toolCallId: "t2" })], []);
    const analysis = analyzeContext([c0, c1, c2], traceFromRequests([c0, c1, c2]));
    expect(analysis.avoidableDuplicateEvents).toHaveLength(0);
    expect(analysis.avoidableDuplicateTokens.source).toBe("UNKNOWN");
  });

  it("counts bootstrap-injected content re-read verbatim before any write (planner/pull overlap)", () => {
    const system = message("system", "sys");
    const task = message("user", `Goal\n\n${FILE_A}`);
    const c0 = request(0, [system, task], [emitted("t1", "read_file", "{\"path\":\"src/a.ts\"}")]);
    const c1 = request(1, [...c0.messages, message("assistant", ""), message("tool", FILE_A, { toolName: "read_file", toolCallId: "t1" })], []);
    const analysis = analyzeContext([c0, c1], traceFromRequests([c0, c1]), { bootstrapFileContents: new Map([["src/a.ts", FILE_A]]) });
    expect(analysis.avoidableDuplicateEvents).toEqual([expect.objectContaining({ kind: "bootstrap_then_reread", tool: "read_file", repeatCallIndex: 0 })]);
  });

  it("composes the final conversation by category and attributes tool results by tool", () => {
    const req = request(0, [
      message("system", "sys-prompt"),
      message("user", "Goal text"),
      message("assistant", "thinking"),
      message("tool", "file content", { toolName: "read_file" }),
      message("user", "[tool:search_files] 3 matches"),
      message("user", "steer: also fix b"),
    ]);
    const composition = composeRequest(req);
    expect(composition.systemBytes).toBe(Buffer.byteLength("sys-prompt"));
    expect(composition.userTaskBytes).toBe(Buffer.byteLength("Goal text") + Buffer.byteLength("steer: also fix b"));
    expect(composition.assistantBytes).toBe(Buffer.byteLength("thinking"));
    expect(composition.toolResultBytes).toBe(Buffer.byteLength("file content") + Buffer.byteLength("[tool:search_files] 3 matches"));
    expect(composition.toolResultBytesByTool).toEqual({ read_file: Buffer.byteLength("file content"), search_files: Buffer.byteLength("[tool:search_files] 3 matches") });
  });

  it("normalises replay provenance prefixes and canonicalises arguments", () => {
    expect(normalizeToolResult("[reused from earlier identical read] body\n")).toBe("body");
    expect(canonicalArguments("{\"b\":1,\"a\":\"x\"}").json).toBe("{\"a\":\"x\",\"b\":1}");
    expect(canonicalArguments("{\"path\":\"src\\\\x.ts\"}").path).toBe("src/x.ts");
    expect(canonicalArguments("not json").json).toBe("not json");
  });
});

const SNAPSHOT: PricingSnapshot = parsePricingSnapshot({
  snapshotId: "test-snapshot",
  frozenAt: "2026-09-20T00:00:00.000Z",
  currency: "USD",
  equivalents: { "openrouter::vendor/model:free": { priceRef: "openrouter::vendor/model", rationale: "paid listing of the same model" } },
  marketReference: { priceRef: "reference::frontier", rationale: "named reference frontier model" },
  prices: {
    "openrouter::vendor/model": { id: "openrouter::vendor/model", inputPerMillionUsd: 0.5, outputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.1, source: "test", retrievedAt: "2026-09-20T00:00:00.000Z" },
    "reference::frontier": { id: "reference::frontier", inputPerMillionUsd: 3, outputPerMillionUsd: 15, source: "test", retrievedAt: "2026-09-20T00:00:00.000Z" },
  },
});

function call(index: number, overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    callIndex: index, providerId: "openrouter", requestedModelId: "vendor/model:free", startedAt: "2026-09-20T00:00:00.000Z", endedAt: "2026-09-20T00:00:01.000Z", latencyMs: 1000,
    requestBytes: 100, responseBytes: 10, messageCount: 2, messageCountByRole: { user: 2 }, toolDefinitionCount: 3, usageSource: "PROVIDER_REPORTED", promptTokens: 1000, completionTokens: 100, totalTokens: 1100,
    toolCallsEmitted: 0, outcome: "ok", rateLimited: false, conversationDigest: "d",
    ...overrides,
  };
}

describe("R23 cost fixture (protocol §11)", () => {
  it("prices a known token bundle exactly at the snapshot rates", () => {
    const priced = priceTokens({ promptTokens: 1_000_000, completionTokens: 200_000, cachedPromptTokens: 400_000 }, SNAPSHOT.prices["openrouter::vendor/model"]!);
    // 600k uncached × $0.5/M = 0.30; 400k cached × $0.1/M = 0.04; 200k output × $2/M = 0.40
    expect(priced.usd).toBe(0.74);
    expect(priced.breakdown).toEqual({ inputUsd: 0.3, cachedUsd: 0.04, outputUsd: 0.4, reasoningUsd: 0 });
    expect(priced.note).toBe("");
  });

  it("prices cached tokens at the input rate and says so when the snapshot has no cache-read price", () => {
    const priced = priceTokens({ promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 1000 }, SNAPSHOT.prices["reference::frontier"]!);
    expect(priced.usd).toBe(0.003);
    expect(priced.note).toContain("cached tokens priced at the input rate");
  });

  it("derives actual/public/market costs from a ledger and keeps them distinct", () => {
    const calls = [call(0, { providerReportedCostUsd: 0 }), call(1, { promptTokens: 2000, completionTokens: 50, totalTokens: 2050, providerReportedCostUsd: 0 })];
    const economics = computeEconomics(calls, "openrouter::vendor/model:free", SNAPSHOT, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(economics.actualCostUsd).toEqual({ value: 0, source: "OBSERVED", origin: "PROVIDER", note: "Σ provider-reported per-call cost" });
    // 3000 prompt × 0.5/M + 150 output × 2/M = 0.0015 + 0.0003
    expect(economics.equivalentPublicApiCostUsd.value).toBeCloseTo(0.0018, 9);
    expect(economics.equivalentPublicApiCostUsd.source).toBe("DERIVED");
    expect(economics.equivalentPublicApiPriceRef).toBe("openrouter::vendor/model");
    // 3000 × 3/M + 150 × 15/M = 0.009 + 0.00225
    expect(economics.equivalentMarketCostUsd.value).toBeCloseTo(0.01125, 9);
    expect(economics.equivalentMarketPriceRef).toBe("reference::frontier");
    expect(sumTokenTotals(calls)).toEqual({ promptTokens: 3000, completionTokens: 150 });
  });

  it("falls back to the route's listed unit price when the provider reports no cost, and to UNKNOWN when a call has no usage", () => {
    const listed = computeEconomics([call(0)], "openrouter::vendor/model:free", SNAPSHOT, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(listed.actualCostUsd).toMatchObject({ value: 0, source: "DERIVED", origin: "SNAPSHOT" });
    const unknown = computeEconomics([call(0), call(1, { usageSource: "UNKNOWN", promptTokens: undefined, completionTokens: undefined, totalTokens: undefined })], "openrouter::vendor/model:free", SNAPSHOT, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(unknown.actualCostUsd.source).toBe("UNKNOWN");
    expect(unknown.equivalentPublicApiCostUsd.source).toBe("UNKNOWN");
    expect(unknown.equivalentMarketCostUsd.source).toBe("UNKNOWN");
  });

  it("rejects a snapshot whose equivalents reference unpriced listings", () => {
    expect(() => parsePricingSnapshot({ ...SNAPSHOT, equivalents: { x: { priceRef: "missing", rationale: "" } } })).toThrow(/unknown price/);
  });
});

describe("R23 arm tripwire (protocol §3, §15)", () => {
  it("accepts the frozen arms and rejects any other difference", () => {
    expect(() => assertArmsDifferOnlyInSwitches()).not.toThrow();
    const tampered = { ...OPTIMIZED_ARM, extraTool: true } as unknown as typeof OPTIMIZED_ARM;
    expect(() => assertArmsDifferOnlyInSwitches(CONTROL_ARM, tampered)).toThrow(/arm tripwire/);
    const halfOn = { ...CONTROL_ARM, toolOutputCompression: true };
    expect(() => assertArmsDifferOnlyInSwitches(halfOn, OPTIMIZED_ARM)).toThrow(/arm tripwire/);
  });

  it("ablations flip exactly one switch and have distinct digests", () => {
    for (const toggle of ARM_SWITCHES) {
      const ablated = ablationArm(OPTIMIZED_ARM, toggle);
      const differing = ARM_SWITCHES.filter((key) => ablated[key] !== OPTIMIZED_ARM[key]);
      expect(differing).toEqual([toggle]);
      expect(ablated.arm).toBe("ablation");
      expect(armConfigurationDigest(ablated)).not.toBe(armConfigurationDigest(OPTIMIZED_ARM));
    }
    expect(armConfigurationDigest(CONTROL_ARM)).not.toBe(armConfigurationDigest(OPTIMIZED_ARM));
    // The label never influences the digest.
    expect(armConfigurationDigest({ ...CONTROL_ARM, label: "renamed" })).toBe(armConfigurationDigest(CONTROL_ARM));
  });
});

describe("R23 run-record invariants (protocol §16)", () => {
  function skeleton(calls: ModelCallRecord[], overrides: Partial<RunRecord["outcome"]> = {}): RunRecord {
    const reported = calls.filter((c) => c.usageSource === "PROVIDER_REPORTED");
    const all = reported.length === calls.length && calls.length > 0;
    const input = reported.reduce((s, c) => s + (c.promptTokens ?? 0), 0);
    const output = reported.reduce((s, c) => s + (c.completionTokens ?? 0), 0);
    const transmitted = calls.reduce((s, c) => s + c.requestBytes, 0);
    return {
      schemaVersion: "r23-run-record-1",
      identity: { benchmarkVersion: "CodeForge-EfficiencyBench-R23", protocolId: "codeforge-efficiency-protocol-r23", protocolVersion: "1.0.0", protocolDigest: "0".repeat(64), harnessVersion: "t", campaignId: "c", phase: "fixture", runId: "r", pairId: "p", taskId: "t", taskClass: "small_fix", taskLanguage: "ts", repoSizeClass: "small", arm: "optimized", armConfigurationDigest: "d", pairOrder: "control-first", repetition: 1, codeforgeCommit: "abc", codeforgeTreeDirty: false, startingTreeHash: "s", endingTreeHash: "e", taskDigest: "td", modelId: "m", providerId: "p", routeClass: "free", forgeGreenEnabled: true, subagentsEnabled: true, topology: "single_agent_run:tiny", environmentFingerprint: "f", startedAt: "2026-09-20T00:00:00.000Z", endedAt: "2026-09-20T00:00:05.000Z" },
      outcome: { runtimeStatus: "completed", stopReason: "completed", claimedComplete: true, verifierRan: true, verifierPassed: true, completionAuthority: "PASS", completionBlockers: [], forbiddenActionObserved: false, verifiedComplete: true, falseComplete: false, classification: "verified_complete", completionReason: "ok", filesChanged: [], linesAdded: 0, linesRemoved: 0, ...overrides },
      inference: {
        totalInputTokens: all ? { value: input, source: "OBSERVED", origin: "PROVIDER" } : { source: "UNKNOWN" },
        totalOutputTokens: all ? { value: output, source: "OBSERVED", origin: "PROVIDER" } : { source: "UNKNOWN" },
        totalTokens: all ? { value: input + output, source: "DERIVED", origin: "PROVIDER" } : { source: "UNKNOWN" },
        cachedInputTokens: { source: "UNKNOWN" }, uncachedInputTokens: { source: "UNKNOWN" }, reasoningTokens: { source: "UNKNOWN" },
        modelCalls: calls.length, callsWithProviderUsage: reported.length, failedModelCalls: calls.filter((c) => c.outcome === "error").length, retriedModelCalls: 0, rateLimitedCalls: calls.filter((c) => c.rateLimited).length, providerFailovers: 0, modelFailovers: 0, duplicateRequestsSuppressed: 0, calls,
      },
      context: { transmittedContextBytes: transmitted, finalConversationBytes: 100, providerStatelessnessRepeatBytes: Math.max(0, transmitted - 100), avoidableDuplicateBytes: 0, avoidableDuplicateTokens: { source: "UNKNOWN" }, avoidableDuplicateEvents: [], finalComposition: { systemBytes: 0, userTaskBytes: 0, assistantBytes: 0, toolResultBytes: 0, toolResultBytesByTool: {}, otherBytes: 0 }, bootstrapContextBytes: 0, bootstrapSelectedFiles: 0, bootstrapCandidateFiles: 0, canonicalCacheHits: 0, canonicalCacheMisses: 0, toolOutputBytesAvoidedByCompression: 0, providerCacheHitCalls: 0 },
      activity: { role: "coder", toolCallsRequested: 0, toolCallsExecuted: 0, toolCallsFailed: 0, duplicateActionsSuppressed: 0, byTool: {}, fileReads: 0, fileWrites: 0, searches: 0, listings: 0, shellCalls: 0, browserCalls: 0, mcpCalls: 0, pluginCalls: 0, subagentCount: 0, subagentModelCalls: 0 },
      time: { wallClockMs: 5000, activeAgentMs: 4000, modelWaitMs: 2000, toolMs: { source: "UNKNOWN" }, verificationMs: 500, rateLimitWaitMs: 0, forgeGreenOverheadMs: { source: "UNKNOWN" } },
      economics: { pricingSnapshotId: "s", actualCostUsd: { source: "UNKNOWN" }, equivalentPublicApiCostUsd: { source: "UNKNOWN" }, equivalentPublicApiPriceRef: "", equivalentMarketCostUsd: { source: "UNKNOWN" }, equivalentMarketPriceRef: "ref" },
      resources: { cpuUserMs: { source: "UNKNOWN" }, cpuSystemMs: { source: "UNKNOWN" }, peakRssBytes: { source: "UNKNOWN" }, providerResponseBytes: { source: "UNKNOWN" }, providerRequestBytes: { source: "UNKNOWN" }, gpuPowerDrawWattsIdleSample: { source: "UNKNOWN" }, sampler: "none" },
      telemetry: { efficiencyReasonCodes: [] },
      notes: [],
    };
  }

  it("accepts a consistent record", () => {
    expect(runRecordInvariantViolations(skeleton([call(0), call(1)]))).toEqual([]);
  });

  it("catches token totals that do not equal the ledger, and totals that are not UNKNOWN when a call lacks usage", () => {
    const record = skeleton([call(0), call(1)]);
    record.inference.totalInputTokens = { value: 1, source: "OBSERVED", origin: "PROVIDER" };
    expect(runRecordInvariantViolations(record).some((v) => v.startsWith("totalInputTokens"))).toBe(true);
    const partial = skeleton([call(0), call(1, { usageSource: "UNKNOWN", promptTokens: undefined, completionTokens: undefined, totalTokens: undefined })]);
    partial.inference.totalInputTokens = { value: 1000, source: "OBSERVED", origin: "PROVIDER" };
    partial.inference.totalTokens = { value: 1100, source: "DERIVED", origin: "PROVIDER" };
    expect(runRecordInvariantViolations(partial)).toEqual(expect.arrayContaining([expect.stringContaining("must be UNKNOWN")]));
  });

  it("catches a verified claim without a passing verifier / authority and an inconsistent false-completion flag", () => {
    const record = skeleton([call(0)], { verifierPassed: false });
    expect(runRecordInvariantViolations(record)).toEqual(expect.arrayContaining([expect.stringContaining("verifiedComplete requires verifierPassed")]));
    const flagged = skeleton([call(0)], { verifiedComplete: false, falseComplete: false, classification: "false_complete" });
    expect(runRecordInvariantViolations(flagged)).toEqual(expect.arrayContaining([expect.stringContaining("falseComplete must equal")]));
  });

  it("catches an arm whose forgeGreenEnabled flag contradicts the arm", () => {
    const record = skeleton([call(0)]);
    record.identity.arm = "control";
    expect(runRecordInvariantViolations(record)).toEqual(expect.arrayContaining([expect.stringContaining("control arm must have forgeGreenEnabled=false")]));
  });
});

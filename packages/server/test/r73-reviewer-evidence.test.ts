import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { REVIEWER_PROTOCOL, ROLE_QUALIFICATION_SUITE_VERSION, type ModelQualificationReceipt, type RoleQualificationResult } from "@codeforge/eight-bit";
import type { FreeCloudRoutingHooks } from "@codeforge/model-registry";
import { REVIEWER_CLEAN_DIFF_INSTRUCTION, REVIEWER_TEMPERATURE } from "@codeforge/agent";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { assertReviewerEvidenceCurrent, buildReviewerEvidenceSnapshot, REVIEWER_SNAPSHOT_BYTES } from "../src/reviewer-evidence.js";

describe("R73 workspace-bound text Reviewer", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "r73-review-evidence-"));
    await fs.writeFile(path.join(workspace, "source.mjs"), "export const limit = 3;\n");
    await fs.writeFile(path.join(workspace, "source.test.mjs"), "assert.equal(limit, 3);\n");
  });
  afterEach(async () => { await fs.rm(workspace, { recursive: true, force: true }); });

  const snapshot = (workspacePath: string, files = ["source.mjs", "source.test.mjs"]) => buildReviewerEvidenceSnapshot({
    workspacePath, baseRevision: "fixture-base", diff: "-limit = 4\n+limit = 3", files, verificationCommands: ["node --test"],
  });

  it("delivers full changed source and tests without asserting that tests ran, and rejects stale state", async () => {
    const packet = await snapshot(workspace);
    expect(packet.binding.complete).toBe(true);
    const observed = JSON.parse(packet.context) as { files: Array<{ content: string; hash: string }>; verification: { status: string } };
    expect(observed.files.map((file) => file.content)).toEqual(["export const limit = 3;\n", "assert.equal(limit, 3);\n"]);
    expect(observed.files.every((file) => /^[a-f0-9]{64}$/.test(file.hash))).toBe(true);
    expect(observed.verification.status).toBe("pending");
    assertReviewerEvidenceCurrent(packet.binding, workspace, packet.context);
    expect(() => assertReviewerEvidenceCurrent(packet.binding, workspace, `${packet.context} `)).toThrow("REVIEWER_EVIDENCE_STALE");
    await fs.writeFile(path.join(workspace, "source.mjs"), "export const limit = 4;\n");
    expect(() => assertReviewerEvidenceCurrent(packet.binding, workspace, packet.context)).toThrow("REVIEWER_EVIDENCE_STALE");
  });

  it("does not certify truncated, binary, missing, outside, or sensitive content", async () => {
    await fs.writeFile(path.join(workspace, "large.mjs"), "x".repeat(REVIEWER_SNAPSHOT_BYTES));
    await fs.writeFile(path.join(workspace, "binary.dat"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(workspace, ".env"), "PRIVATE_KEY=private-value\n");
    for (const file of ["large.mjs", "binary.dat", "missing.mjs", "../outside.mjs", ".env"]) {
      const packet = await snapshot(workspace, [file]);
      expect(packet.binding.complete).toBe(false);
      expect(packet.context).not.toContain("PRIVATE_KEY=private-value");
    }
  });

  it("rejects a symbolic link even when it points to a file inside the worktree", async () => {
    await fs.symlink(path.join(workspace, "source.mjs"), path.join(workspace, "linked.mjs"));
    expect((await snapshot(workspace, ["linked.mjs"])).binding.complete).toBe(false);
  });

  function qualification(toolQualified = false): ModelQualificationReceipt {
    const at = new Date().toISOString();
    const role = (name: "REVIEWER" | "TOOL_AGENT", status: RoleQualificationResult["status"]): RoleQualificationResult => ({
      role: name, status, testCases: [{ caseId: "measured", category: "reasoning", passed: status === "QUALIFIED", hardFailure: false, latencyMs: 1, retries: 0 }], hardFailures: [], startedAt: at, completedAt: at,
    });
    return {
      suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, providerId: "review-provider", modelId: "review-model", modelDisplayName: "Reviewer", accessClass: "FREE_ROUTED", freeStatus: "verified_free",
      roleResults: { REVIEWER: role("REVIEWER", "QUALIFIED"), TOOL_AGENT: role("TOOL_AGENT", toolQualified ? "QUALIFIED" : "NOT_TESTED") },
      metadata: { roleProtocolVersions: { REVIEWER: REVIEWER_PROTOCOL.version } }, startedAt: at, completedAt: at, totalLatencyMs: 1, qualificationState: "QUALIFIED", hardFailureRoles: [],
    };
  }

  async function review(options: { toolQualified?: boolean; incomplete?: boolean; mutate?: boolean; returnTool?: boolean; smallContext?: boolean } = {}) {
    const requests: ChatRequest[] = [];
    const provider: ProviderAdapter = {
      providerId: "review-provider", isTestProvider: true,
      listModels: async () => [], chat: async () => { throw new Error("stream only"); }, healthCheck: async () => ({ status: "available" }),
      streamChat: async function* (request): AsyncIterable<StreamEvent> {
        requests.push(request);
        if (options.mutate) await fs.writeFile(path.join(workspace, "source.mjs"), "export const limit = 4;\n");
        if (options.returnTool) {
          yield { type: "tool_call_completed", toolCallId: "unexpected", toolName: "read_file", arguments: '{"path":"source.mjs"}' };
          yield { type: "finish", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", delta: '{"verdict":"pass","findings":[],"summary":"Boundary fix matches the task and assertions."}' };
          yield { type: "finish", finishReason: "stop" };
        }
      },
    };
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "review-model", contextWindow: options.smallContext ? 512 : 128_000 }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const receipt = qualification(options.toolQualified);
    const freeCloud: FreeCloudRoutingHooks = {
      isForgeAutoEligible: () => true, canonicalIdOf: () => "review-model", sameModelAlternates: () => [], recordRouteFailure: () => undefined,
      recordRouteSuccess: () => undefined, quotaRemaining: () => undefined, capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }), getQualificationReceipt: () => receipt,
    };
    const runtime = createAgentRuntime({ sessionId: "review-session", workspacePath: workspace, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, freeCloud });
    const packet = await snapshot(workspace);
    try {
      const result = await runtime.executeAgentRun({
        runId: "review-run", agentId: "reviewer", role: "reviewer", goal: "Limit must equal three", workspaceId: "isolated", workspacePath: workspace,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "reviewer", roleRouting: true,
        diff: packet.context, reviewEvidence: { ...packet.binding, complete: options.incomplete ? false : packet.binding.complete },
      });
      return { result, requests, packet };
    } finally { await runtime.shutdown(); await persistence.close(); }
  }

  it("uses the qualified text protocol without advertising or executing unqualified tools", async () => {
    const { result, requests, packet } = await review();
    expect(result.status).toBe("completed");
    expect(result.structuredData).toMatchObject({ verdict: "pass" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools ?? []).toHaveLength(0);
    expect(requests[0]?.toolChoice).toBe("none");
    expect(requests[0]?.temperature).toBe(REVIEWER_TEMPERATURE);
    expect(requests[0]?.messages[0]?.content).toContain(REVIEWER_CLEAN_DIFF_INSTRUCTION);
    expect(requests[0]?.messages.some((message) => message.content.includes(packet.context))).toBe(true);
    expect(result.toolExecutions).toEqual([]);
  });

  it("refuses incomplete snapshots before spending a request on a text-only route", async () => {
    const { result, requests } = await review({ incomplete: true });
    expect(result.status).not.toBe("completed");
    expect(requests).toHaveLength(0);
  });

  it("retains the read-only tool path for a separately Tool Agent-qualified Reviewer", async () => {
    const { result, requests } = await review({ toolQualified: true, incomplete: true });
    expect(result.status).toBe("completed");
    expect(requests[0]?.tools?.length).toBeGreaterThan(0);
  });

  it("blocks a valid verdict when the workspace changed during the independent request", async () => {
    const { result } = await review({ mutate: true });
    expect(result.status).not.toBe("completed");
    expect(result.summary).toContain("REVIEWER_EVIDENCE_STALE");
    expect(result.structuredData).toBeUndefined();
  });

  it("does not execute tool calls that violate the qualified text protocol", async () => {
    const { result } = await review({ returnTool: true });
    expect(result.status).not.toBe("completed");
    expect(result.toolExecutions).toEqual([]);
    expect(result.structuredData).toBeUndefined();
  });

  it("blocks a packet too large for the admitted model instead of truncating delivered evidence", async () => {
    await fs.writeFile(path.join(workspace, "source.mjs"), "export const value = '" + "x".repeat(8_000) + "';\n");
    const { result, requests } = await review({ smallContext: true });
    expect(result.status).not.toBe("completed");
    expect(requests).toHaveLength(0);
  });
});

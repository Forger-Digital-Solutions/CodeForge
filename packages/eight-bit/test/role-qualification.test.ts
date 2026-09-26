import { describe, it, expect } from "vitest";
import type { ChatRequest, StreamEvent } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { runRoleQualification, runRoleAwareQualification, ROLE_QUALIFICATION_SUITE_VERSION } from "../src/qualification/role-suite.js";
import { EXPLORER_REPO, PLANNER_PROTOCOL_V1, PLANNER_PROTOCOL_V2, ROLE_PROTOCOLS } from "../src/qualification/role-protocols.js";

/**
 * R27 role protocol tests. Every adapter is a deterministic script driven by the
 * request's own text, so a verdict is a fact about the scripted behaviour, never a mock of the
 * scorer. Model profiles prove specialization is representable: explorer-strong/coder-weak is
 * a different route capability than coder-strong/explorer-weak.
 */

function ev(events: StreamEvent[]): StreamEvent[] {
  return events;
}
function text(text: string, inputTokens = 200, outputTokens = 120): StreamEvent[] {
  return ev([{ type: "text_delta", delta: text }, { type: "usage", usage: { inputTokens, outputTokens } }, { type: "finish", finishReason: "stop" }]);
}
function call(name: string, args: Record<string, unknown>): StreamEvent[] {
  const id = `c-${Math.random().toString(16).slice(2)}`;
  return ev([
    { type: "tool_call_started", toolCallId: id, toolName: name },
    { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) },
    { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 200, outputTokens: 60 } },
    { type: "finish", finishReason: "tool_calls" },
  ]);
}

class ScriptedAdapter {
  readonly providerId = "scripted";
  readonly requests: ChatRequest[] = [];
  constructor(private readonly script: (req: ChatRequest) => StreamEvent[]) {}
  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    for (const e of this.script(req)) yield e;
  }
}

const MODEL = createGenericFreeRecord({ providerId: "scripted", modelId: "scripted-model", displayName: "Scripted" });

function body(req: ChatRequest): string {
  return req.messages.map((m) => m.content ?? "").join("\n");
}
function hasToolResult(req: ChatRequest): boolean {
  return req.messages.some((m) => m.role === "tool");
}

function plannerJsonFor(req: ChatRequest): string {
  const t = body(req);
  const file = t.includes("admission.ts") ? "src/fabric/admission.ts" : "src/provider/client.ts";
  return JSON.stringify({
    summary: "Implement the smallest safe change and verify it.",
    tasks: [
      { id: "t1", title: `Implement the change in ${file}`, objective: `Make the minimal fix in ${file}`, dependencies: [], assignedRole: "coder" },
      { id: "t2", title: "Review and verify", objective: "Verify the fix with the existing test command", dependencies: ["t1"], assignedRole: "reviewer" },
    ],
  });
}

function reviewerVerdictFor(req: ChatRequest, mode: "good" | "approve_all" | "reject_all"): StreamEvent[] {
  const t = body(req);
  const intentBuggy = t.includes("add()") || t.includes("Record provider failures") || t.includes("fast path") || t.includes("flaky router test");
  const approved = mode === "approve_all" ? true : mode === "reject_all" ? false : !intentBuggy;
  return text(JSON.stringify({ verdict: approved ? "approve" : "reject", findings: approved ? [] : [{ message: "defect in the changed code (a * b / catch swallow / reserve without release / weakened assertion)", path: "src/calc.ts" }] }));
}

/** A universally capable model — passes compact and all three role protocols. */
function goodScript(req: ChatRequest): StreamEvent[] {
  const t = body(req);
  if (t.includes("Open src/calc.ts")) return call("read_file", { path: "src/calc.ts" });
  if (t.includes("has a bug")) return call("edit_file", { path: "src/calc.ts", oldText: "return a - b;", newText: "return a + b;" });
  if (t.includes('"files" (array of strings)')) return text('{"files":["src/calc.ts","test/calc.test.ts"],"verified":true}');
  if (t.includes("read-only repository explorer")) {
    if (hasToolResult(req)) {
      const files = t.includes("reservation") ? ["src/fabric/admission.ts", "src/fabric/ledger.ts"] : ["src/router.ts", "src/provider/client.ts"];
      return text(JSON.stringify({ files }));
    }
    const reads = t.includes("reservation") ? ["src/fabric/admission.ts", "src/fabric/ledger.ts"] : ["src/router.ts", "src/provider/client.ts"];
    return [...call("list_files", { path: "src" }), ...reads.flatMap((p) => call("read_file", { path: p }).slice(0, 3))];
  }
  if (t.includes("task planner")) return text(plannerJsonFor(req));
  if (t.includes("independent change reviewer")) return reviewerVerdictFor(req, "good");
  return text("{}");
}

describe("R27 — versioned role protocols", () => {
  it("keeps R24 evidence frozen while qualifying the R27 planner protocol", () => {
    expect(ROLE_PROTOCOLS.map((p) => p.role)).toEqual(["EXPLORER", "PLANNER", "REVIEWER"]);
    for (const p of ROLE_PROTOCOLS) {
      expect(p.version).toMatch(p.role === "PLANNER" ? /_V3$/ : /_V1$/);
      expect(p.evidenceFormat).toBe("per_case_details_v1");
      expect(p.scoringDimensions.length).toBeGreaterThan(0);
    }
    expect(PLANNER_PROTOCOL_V1.version).toBe("PLANNER_PROTOCOL_V1");
    expect(PLANNER_PROTOCOL_V2.version).toBe("PLANNER_PROTOCOL_V2");
    // Explorer is the only protocol that offers tools — including the edit trap.
    expect(EXPLORER_REPO.files["src/router.ts"]).toBeTruthy();
  });

  it("EXPLORER: a capable explorer qualifies with measurable evidence, not a vibe score", async () => {
    const out = await runRoleQualification(MODEL, new ScriptedAdapter(goodScript));
    const explorer = out.roleResults.EXPLORER!;
    expect(explorer.status).toBe("QUALIFIED");
    const details = explorer.testCases[0]!.details as Record<string, unknown>;
    expect(details.mutationAttempts).toBe(0);
    expect(details.hallucinatedPaths).toEqual([]);
    expect(details.validToolCallRate).toBe(1);
    expect((details.relevantFilesRead as string[]).length).toBeGreaterThan(0);
  });

  it("EXPLORER: hallucinated paths and mutation attempts fail the case on evidence", async () => {
    const bad = new ScriptedAdapter((req) => {
      const t = body(req);
      if (!t.includes("read-only repository explorer")) return text("{}");
      if (hasToolResult(req)) return text('{"files":["src/router.ts","src/secret/impl.ts"]}');
      return [...call("read_file", { path: "src/router.ts" }), ...call("edit_file", { path: "src/router.ts", oldText: "x", newText: "y" })];
    });
    const out = await runRoleQualification(MODEL, bad);
    const explorer = out.roleResults.EXPLORER!;
    expect(explorer.status).not.toBe("QUALIFIED");
    const d = explorer.testCases[0]!.details as Record<string, unknown>;
    expect(d.mutationAttempts).toBe(1);
    expect((d.hallucinatedPaths as string[]).length).toBeGreaterThan(0);
  });

  it("PLANNER: a grounded structured plan qualifies; unparseable plans hard-fail", async () => {
    const out = await runRoleQualification(MODEL, new ScriptedAdapter(goodScript));
    expect(out.roleResults.PLANNER!.status).toBe("QUALIFIED");

    const prose = await runRoleQualification(MODEL, new ScriptedAdapter((req) => body(req).includes("task planner") ? text("sure, just change the file") : goodScript(req)));
    expect(prose.roleResults.PLANNER!.status).toBe("HARD_FAILURE");
    expect(prose.roleResults.PLANNER!.hardFailures).toContain("planner.schema");
  });

  it("R41: a provider-empty response or bounded probe is inconclusive, not a planner schema failure", async () => {
    for (const message of ["OpenRouter returned HTTP 200 but no usable completion choices.", "R41_BOUND: request cap reached"]) {
      const out = await runRoleQualification(MODEL, new ScriptedAdapter(() =>
        ev([{ type: "error", code: "PROVIDER_UNAVAILABLE", message, retryable: false }])));
      expect(out.roleResults.PLANNER!.status).toBe("NOT_TESTED");
      expect(out.roleResults.PLANNER!.hardFailures).toEqual([]);
      expect(out.roleResults.REVIEWER!.status).toBe("NOT_TESTED");
      expect(out.roleResults.REVIEWER!.hardFailures).toEqual([]);
    }
  });

  it("PLANNER: semantic steps qualify only after canonical graph validation", async () => {
    const semantic = new ScriptedAdapter((req) => {
      if (!body(req).includes("task planner")) return goodScript(req);
      const file = body(req).includes("admission.ts") ? "src/fabric/admission.ts" : "src/provider/client.ts";
      return text(JSON.stringify({
        protocol: "semantic_steps_v1",
        summary: "Implement the smallest change and verify it.",
        steps: [
          { id: "implement", intent: `Implement the smallest change in ${file}`, phase: "implementation", after: [] },
          { id: "verify", intent: "Review and verify the existing focused test", phase: "verification", after: ["implement"] },
        ],
      }));
    });
    const out = await runRoleQualification(MODEL, semantic);
    expect(out.roleResults.PLANNER!.status).toBe("QUALIFIED");
    expect(out.roleResults.PLANNER!.testCases[0]!.details).toMatchObject({ protocol: "semantic_steps_v1" });
  });

  it("PLANNER: invented paths and missing reviewer dependency are scored failures", async () => {
    const invented = new ScriptedAdapter((req) => {
      if (!body(req).includes("task planner")) return goodScript(req);
      return text(JSON.stringify({ summary: "Attempt a scoped implementation and review.", tasks: [
        { id: "t1", title: "Rewrite src/architecture/everything.ts", objective: "Rebuild the framework in src/architecture/everything.ts", dependencies: [], assignedRole: "coder" },
        { id: "t2", title: "Review", objective: "verify", dependencies: [], assignedRole: "reviewer" },
      ] }));
    });
    const out = await runRoleQualification(MODEL, invented);
    const d = out.roleResults.PLANNER!.testCases[0]!.details as Record<string, unknown>;
    expect((d.inventedPaths as string[]).length).toBeGreaterThan(0);
    expect(out.roleResults.PLANNER!.status).not.toBe("QUALIFIED");
  });

  it("REVIEWER: a good reviewer qualifies; approving the planted bug is disqualifying", async () => {
    const good = await runRoleQualification(MODEL, new ScriptedAdapter(goodScript));
    const reviewer = good.roleResults.REVIEWER!;
    expect(reviewer.status).toBe("QUALIFIED");
    expect(reviewer.testCases.find((c) => c.caseId === "reviewer.clean")!.passed).toBe(true);
    expect(reviewer.testCases.filter((c) => c.passed).length).toBe(6);

    const approveAll = await runRoleQualification(MODEL, new ScriptedAdapter((req) => body(req).includes("independent change reviewer") ? reviewerVerdictFor(req, "approve_all") : goodScript(req)));
    const lax = approveAll.roleResults.REVIEWER!;
    expect(lax.status).toBe("HARD_FAILURE");
    expect(lax.hardFailures).toContain("reviewer.one_bug");

    const rejectAll = await runRoleQualification(MODEL, new ScriptedAdapter((req) => body(req).includes("independent change reviewer") ? reviewerVerdictFor(req, "reject_all") : goodScript(req)));
    const strict = rejectAll.roleResults.REVIEWER!;
    expect(strict.status).not.toBe("QUALIFIED");
    expect(strict.testCases.find((c) => c.caseId === "reviewer.clean")!.passed).toBe(false);
  });
});

describe("R27 — composed runner emits one receipt with all role evidence", () => {
  it("merges compact + role suites under the R24 suite version", async () => {
    const receipt = await runRoleAwareQualification(MODEL, new ScriptedAdapter(goodScript));
    expect(receipt.suiteVersion).toBe(ROLE_QUALIFICATION_SUITE_VERSION);
    for (const role of ["CODER", "TOOL_AGENT", "ANALYST", "EXPLORER", "PLANNER", "REVIEWER"] as const) {
      expect(receipt.roleResults[role]?.status, `role ${role}`).toBe("QUALIFIED");
    }
    expect(receipt.qualificationState).toBe("QUALIFIED");
    expect((receipt.metadata?.requests as number) >= 8).toBe(true);
  });

  it("a provider-side interruption skips role probes — inconclusive stays pending", async () => {
    let calls = 0;
    const down = new ScriptedAdapter(() => { calls++; return [{ type: "error", message: "429 rate limit" } as StreamEvent]; });
    const receipt = await runRoleAwareQualification(MODEL, down);
    expect(receipt.metadata?.transient).toBe(true);
    expect(receipt.roleResults.EXPLORER).toBeUndefined();
    expect(calls).toBeLessThan(4); // compact's bounded probes only, no role spend
  });

  it("specialization is representable: explorer-strong/coder-weak ≠ coder-strong", async () => {
    const explorerOnly = new ScriptedAdapter((req) => {
      const t = body(req);
      if (t.includes("read-only repository explorer") || t.includes("task planner") || t.includes("independent change reviewer")) return goodScript(req);
      return text("I cannot help with that."); // fails every compact probe
    });
    const receipt = await runRoleAwareQualification(MODEL, explorerOnly);
    expect(receipt.roleResults.CODER!.status).not.toBe("QUALIFIED");
    expect(receipt.roleResults.EXPLORER!.status).toBe("QUALIFIED");
    // The overall gate admits a specialized model — its role vocabulary is what limits it.
    expect(receipt.qualificationState).toBe("QUALIFIED");
  });
});

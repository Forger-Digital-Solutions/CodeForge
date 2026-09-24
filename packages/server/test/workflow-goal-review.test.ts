import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { checkStatedContracts } from "../src/workflow-service.js";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import type { DiffEntry } from "@codeforge/workflow";

type Server = ReturnType<typeof createServer>;
type ApiResponse = { status: number; body: Record<string, unknown> };

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  const json = JSON.stringify(args);
  return [
    { type: "tool_call_started" as const, toolCallId: id, toolName: name },
    { type: "tool_call_delta" as const, toolCallId: id, delta: json },
    { type: "tool_call_completed" as const, toolCallId: id, toolName: name, arguments: json },
    { type: "finish" as const, finishReason: "tool_calls" },
  ];
}

function finalText(text: string) {
  return [
    { type: "text_delta" as const, delta: text },
    { type: "finish" as const, finishReason: "stop" },
  ];
}

const UNMET_VERDICT = `{"verdicts":[{"goal":"sum adds two numbers","status":"unmet","evidence":"src/calc.ts still subtracts","path":"src/calc.ts"}]}`;
const MET_VERDICT = `{"verdicts":[{"goal":"sum adds two numbers","status":"met","evidence":"src/calc.ts returns a + b","path":"src/calc.ts"}]}`;

async function fetchJson(url: string, body?: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("workflow goal-conformance review", () => {
  let workspace: string;
  let server: Server | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "workflow-goal-review-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "calc.ts"), "export const sum = (a: number, b: number) => a - b;\n");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "goal-review-test", type: "module" }));
  });

  afterEach(async () => {
    await server?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  async function runToTerminal(sessionId: string, streamEvents: unknown[][], verification: string, serverOptions: Record<string, unknown> = {}, message = "Fix sum so it adds two numbers"): Promise<{ status: string; events: Array<{ type: string; payload?: { label?: string; blockers?: Array<{ code: string }> } }> }> {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "codeforge", streamEvents: streamEvents as never }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true, ...serverOptions });
    await server.start();
    const base = `http://localhost:${server.httpPort}`;
    expect((await fetchJson(`${base}/api/workspace/set`, { path: workspace })).status).toBe(200);
    const started = await fetchJson(`${base}/api/workflow/run`, {
      sessionId,
      message,
      verificationCommands: [verification],
    });
    expect(started.status).toBe(200);
    const taskId = String(started.body.taskId);

    let status = "";
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const session = await fetchJson(`${base}/api/sessions/${sessionId}`);
      for (const approval of (session.body.pendingApprovals ?? []) as Array<{ approvalId: string }>) {
        await fetchJson(`${base}/api/approvals/${approval.approvalId}/resolve`, { decision: "allow_once" });
      }
      const workflow = await fetchJson(`${base}/api/workflow/${taskId}`);
      status = String((workflow.body.task as { status: string }).status);
      if (["complete", "completed", "blocked", "failed"].includes(status)) break;
    }
    const session = await fetchJson(`${base}/api/sessions/${sessionId}`);
    return { status, events: session.body.events as Array<{ type: string; payload?: { label?: string; blockers?: Array<{ code: string }> } }> };
  }

  it("blocks a run whose weak verification passed but the goal review found the goal unmet", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // The implement turn makes the WRONG edit (a * b) and the configured check is vacuous:
    // without goal review this is exactly the R30 false-completion class.
    const { status, events } = await runToTerminal("goal-review-blocked", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a * b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(UNMET_VERDICT),
    ], "node -e \"process.exit(0)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance").length).toBeGreaterThan(0);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(decided).toBeDefined();
    expect(JSON.stringify(decided?.payload ?? {})).toContain("review_rejected");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("still subtracts");
  }, 30_000);

  it("repairs an unmet goal once, then completes when the re-review confirms", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const wrongHash = createHash("sha256").update("export const sum = (a: number, b: number) => a * b;\n").digest("hex");
    // Vacuous verification keeps the gate open for the wrong edit so the goal review is what
    // drives the conformance repair — verification-driven repair would mask it.
    const { status, events } = await runToTerminal("goal-review-repair", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a * b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(UNMET_VERDICT),
      toolCall("read_file", { path: "src/calc.ts" }, "repair-read"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a * b", newText: "a + b", expectedHash: wrongHash }, "repair-edit"),
      finalText("Corrected the implementation."),
      finalText(MET_VERDICT),
    ], "node -e \"process.exit(0)\"");

    expect(await readFile(join(workspace, "src", "calc.ts"), "utf8")).toContain("a + b");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    expect(status).toBe("complete");
  }, 30_000);

  it("blocks completion when the reviewer produces no decisive verdict, even after a retry", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // R32: a review that yields no usable verdict proves nothing — deterministic checks alone
    // can no longer complete the run. The engine re-reviews once, then the gate blocks.
    const { status, events } = await runToTerminal("goal-review-garbage", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText("I looked at the file and it seems fine, probably."),
      finalText("Second look — still seems fine, I think."),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("continues useful edits beyond the old 32-request envelope and still requires review", async () => {
    let source = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const calls: unknown[][] = [];
    for (let n = 1; n <= 33; n++) {
      const next = source.replace(/a - b(?: \+ \d+)?/, `a - b + ${n}`);
      calls.push(toolCall("edit_file", {
        path: "src/calc.ts",
        oldText: source.trimEnd(),
        newText: next.trimEnd(),
        expectedHash: createHash("sha256").update(source).digest("hex"),
      }, `edit-${n}`));
      source = next;
    }
    calls.push(toolCall("edit_file", {
      path: "src/calc.ts",
      oldText: source.trimEnd(),
      newText: source.replace(/a - b \+ 33/, "a + b").trimEnd(),
      expectedHash: createHash("sha256").update(source).digest("hex"),
    }, "edit-final"));
    calls.push(finalText("Implementation finished."), finalText(MET_VERDICT));

    const { status, events } = await runToTerminal("goal-review-beyond-old-envelope", calls,
      "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"");

    expect(status).toBe("complete");
    expect((await readFile(join(workspace, "src", "calc.ts"), "utf8"))).toContain("a + b");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
  }, 90_000);

  it("still reaches the review when implementation exhausts the primary inference partition", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // total 3 / reserve 1 → the primary lane caps at 2 requests, so the implement turn dies
    // mid-script at its third dispatch (a refused dispatch consumes no script event). The
    // reserved lane still funds one review request — the verdict lands — but the run is
    // blocked on the unfinished plan, never claimed as a success.
    const { status, events } = await runToTerminal("goal-review-primary-exhaustion", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText(MET_VERDICT),
    ], "node -e \"process.exit(0)\"", { workflowInferenceBudget: { total: 3, reserve: 1 } });

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("plan_steps_unfinished");
  }, 30_000);

  it("blocks when the reserved review budget runs out before a verdict", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // Implementation fits the primary partition exactly (2 requests: edit, then final text),
    // leaving the review a single reserved request. The first review turn wastes it on prose;
    // the bounded retry is refused instantly — a starved review must never read as a pass.
    const { status, events } = await runToTerminal("goal-review-reserve-exhaustion", [
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText("Looks right to me."),
      finalText("Another look — I remain unsure."),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"", { workflowInferenceBudget: { total: 3, reserve: 1 } });

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("blocks when every reviewer verdict is explicitly indeterminate", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const indeterminate = `{"verdicts":[{"goal":"sum adds two numbers","status":"indeterminate","evidence":"could not tell","path":"src/calc.ts"}]}`;
    const { status, events } = await runToTerminal("goal-review-indeterminate", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(indeterminate),
      finalText(indeterminate),
    ], "node -e \"process.exit(0)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("blocks when the review response is empty", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const { status, events } = await runToTerminal("goal-review-empty", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      [{ type: "finish", finishReason: "stop" }],
      [{ type: "finish", finishReason: "stop" }],
    ], "node -e \"process.exit(0)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("completes on a decisive verdict even when the primary partition is spent", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // total 5 / reserve 2 → implementation's 3 requests exactly spend the primary partition;
    // the reserved lane still funds the review and its verdict authorizes completion.
    const { status, events } = await runToTerminal("goal-review-reserve-works", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(MET_VERDICT),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"", { workflowInferenceBudget: { total: 5, reserve: 2 } });

    expect(status).toBe("complete");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
  }, 30_000);

  it("blocks on a stated-contract violation the semantic review judged met, then completes after repair", async () => {
    // The R31 false-success class deterministically closed: the goal states
    // validateOrder(input): ValidationResult; the scripted implementation declares string[];
    // the scripted review wrongly says "met". The stated-contract check — not the model —
    // produces the blocking finding and drives a conformance repair.
    const handler = [
      "type OrderInput = { customerId: string };",
      "type HandlerResult = { status: number; body: unknown };",
      "function validateCreate(input: OrderInput): string[] { return input.customerId ? [] : [\"customerId required\"]; }",
      "export function createOrder(input: OrderInput): HandlerResult {",
      "  const errors = validateCreate(input);",
      "  if (errors.length) return { status: 400, body: { errors } };",
      "  return { status: 201, body: { id: `ord-${input.customerId}` } };",
      "}",
    ].join("\n");
    await mkdir(join(workspace, "src", "handlers"), { recursive: true });
    await writeFile(join(workspace, "src", "handlers", "create-order.ts"), handler);
    const wrongValidator = "export function validateOrder(input: { customerId: string }): string[] {\n  return input.customerId ? [] : [\"customerId required\"];\n}\n";
    const fixedValidator = "export type ValidationResult = { ok: true } | { ok: false; errors: string[] };\nexport function validateOrder(input: { customerId: string }): ValidationResult {\n  return input.customerId ? { ok: true } : { ok: false, errors: [\"customerId required\"] };\n}\n";
    const message = "Extract order validation into src/validation/order.ts exporting validateOrder(input): ValidationResult ({ ok: true } or { ok: false, errors: string[] }) and make the handler use it.";
    const lazyMet = `{"verdicts":[{"goal":"validateOrder exported with ValidationResult signature","status":"met","evidence":"src/validation/order.ts exports validateOrder","path":"src/validation/order.ts"}]}`;
    const { status, events } = await runToTerminal("goal-review-contract", [
      toolCall("write_file", { path: "src/validation/order.ts", content: wrongValidator }, "write-1"),
      toolCall("edit_file", { path: "src/handlers/create-order.ts", oldText: "const errors = validateCreate(input);", newText: "const errors = validateOrder(input).ok ? [] : [\"bad\"];" }, "edit-1"),
      finalText("Extracted the validator."),
      finalText(lazyMet),
      toolCall("write_file", { path: "src/validation/order.ts", content: fixedValidator }, "repair-write"),
      finalText("Corrected the return type."),
      finalText(lazyMet),
    ], "node -e \"process.exit(0)\"", {}, message);

    expect(status).toBe("complete");
    expect(await readFile(join(workspace, "src", "validation", "order.ts"), "utf8")).toBe(fixedValidator);
    const decided = JSON.stringify(events.find((event) => event.type === "workflow.completion_decided")?.payload ?? {});
    expect(decided).not.toContain("goal_not_satisfied");
  }, 30_000);

  it("stays blocked when a stated-contract violation survives every repair attempt", async () => {
    const handler = "export function createOrder(input: { customerId: string }) { return { status: 201 }; }\n";
    await mkdir(join(workspace, "src", "handlers"), { recursive: true });
    await writeFile(join(workspace, "src", "handlers", "create-order.ts"), handler);
    const wrongValidator = "export function validateOrder(input: { customerId: string }): string[] {\n  return [];\n}\n";
    const message = "Extract order validation into src/validation/order.ts exporting validateOrder(input): ValidationResult.";
    const lazyMet = `{"verdicts":[{"goal":"validator extracted","status":"met","evidence":"order.ts exists","path":"src/validation/order.ts"}]}`;
    const unrelatedEdit = (id: string) => toolCall("edit_file", { path: "src/handlers/create-order.ts", oldText: "return { status: 201 };", newText: `return { status: 201 }; // ${id}` }, id);
    const { status, events } = await runToTerminal("goal-review-contract-stuck", [
      toolCall("write_file", { path: "src/validation/order.ts", content: wrongValidator }, "write-1"),
      finalText("Extracted the validator."),
      finalText(lazyMet),
      unrelatedEdit("r1"), finalText("Adjusted."),
      finalText(lazyMet),
      unrelatedEdit("r2"), finalText("Adjusted again."),
      finalText(lazyMet),
      unrelatedEdit("r3"), finalText("Adjusted once more."),
      finalText(lazyMet),
    ], "node -e \"process.exit(0)\"", {}, message);

    expect(status).toBe("blocked");
    const decided = JSON.stringify(events.find((event) => event.type === "workflow.completion_decided")?.payload ?? {});
    expect(decided).toContain("review_rejected");
    expect(decided).toContain("Stated contract unmet");
    expect(decided).toContain("ValidationResult");
  }, 60_000);
});

describe("checkStatedContracts", () => {
  const intent = { title: "Extract validateOrder(input): ValidationResult", goals: [] } as Parameters<typeof checkStatedContracts>[0];
  const diff = (added: string): DiffEntry[] => [{
    path: "src/validation/order.ts",
    changeType: "created",
    additions: added.split("\n").length,
    deletions: 0,
    diff: `--- /dev/null\n+++ b/src/validation/order.ts\n${added.split("\n").map((l) => `+${l}`).join("\n")}`,
    beforeHash: "",
    afterHash: "x",
  }];

  it("flags a declaration whose return type contradicts the stated contract", () => {
    const findings = checkStatedContracts(intent, diff("export function validateOrder(input: OrderInput): string[] {\n  return [];\n}"));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("goal_not_satisfied");
    expect(findings[0].severity).toBe("blocking");
    expect(findings[0].message).toContain("string[]");
  });

  it("accepts declarations matching the stated type, including generic wrappers", () => {
    expect(checkStatedContracts(intent, diff("export function validateOrder(input: OrderInput): ValidationResult {"))).toHaveLength(0);
    expect(checkStatedContracts(intent, diff("export function validateOrder(input: OrderInput): Promise<ValidationResult> {"))).toHaveLength(0);
  });

  it("ignores untyped declarations, unstated names, and absent declarations", () => {
    expect(checkStatedContracts(intent, diff("export function validateOrder(input) {\n  return [];\n}"))).toHaveLength(0);
    expect(checkStatedContracts(intent, diff("export function unrelated(input: X): number {"))).toHaveLength(0);
    expect(checkStatedContracts({ title: "rename the thing", goals: [] } as typeof intent, diff("export function f(): string[] {"))).toHaveLength(0);
  });

  it("flags arrow-function and method-shorthand declarations too", () => {
    expect(checkStatedContracts(intent, diff("export const validateOrder = (input: OrderInput): string[] => []"))).toHaveLength(1);
    expect(checkStatedContracts(intent, diff("  validateOrder(input: OrderInput): string[];"))).toHaveLength(1);
  });

  it("cannot be satisfied by signatures inside comments or string literals", () => {
    const commented = "// export function validateOrder(input: OrderInput): ValidationResult {\nexport function validateOrder(input: OrderInput): string[] {\n  return [];\n}";
    const findings = checkStatedContracts(intent, diff(commented));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("goal_not_satisfied");
    const blockCommented = "/* export function validateOrder(input: OrderInput): ValidationResult { */\nexport function validateOrder(input: OrderInput): string[] {";
    expect(checkStatedContracts(intent, diff(blockCommented))).toHaveLength(1);
    const inString = "const expected = \"validateOrder(input): ValidationResult\";\nexport function validateOrder(input: OrderInput): string[] {";
    expect(checkStatedContracts(intent, diff(inString))).toHaveLength(1);
  });
});

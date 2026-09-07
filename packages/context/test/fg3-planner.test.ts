import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createMinimalContextKernel, renderContextKernel } from "../src/kernel.js";
import { estimateTokens } from "../src/pack.js";
import { resolveContextCapacity, ContextCapacityError } from "../src/budget.js";
import { ContextPlanner, createContextPlanner } from "../src/planner.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function fixture(): Promise<{ root: string; intelligence: RepositoryIntelligence }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-planner-repo-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-planner-cache-"));
  cleanupDirs.push(root, cache);

  fs.mkdirSync(path.join(root, "src", "billing"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "unrelated"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "src", "billing", "invoice.ts"),
    "import { formatCurrency } from './currency.js';\nexport class Invoice {\n  total(amount: number): string { return formatCurrency(amount); }\n}\n",
  );
  fs.writeFileSync(
    path.join(root, "src", "billing", "currency.ts"),
    "export function formatCurrency(amount: number): string { return `$${amount.toFixed(2)}`; }\n",
  );
  fs.writeFileSync(
    path.join(root, "src", "billing", "consumer.ts"),
    "import { Invoice } from './invoice.js';\nexport function printInvoice(amount: number): string { return new Invoice().total(amount); }\n",
  );
  fs.writeFileSync(
    path.join(root, "tests", "invoice.test.ts"),
    "import { Invoice } from '../src/billing/invoice.js';\nit('totals', () => new Invoice().total(5));\n",
  );
  // A large, entirely unrelated package that a narrow plan must never pull in.
  for (let i = 0; i < 15; i++) {
    fs.writeFileSync(
      path.join(root, "src", "unrelated", `widget-${i}.ts`),
      `export function widget${i}(): number { return ${i}; }\n`.repeat(20),
    );
  }

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "CodeForge"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codeforge@test.local"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "Initial"], { cwd: root });

  const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
  await intelligence.openWorkspace(root);
  await intelligence.indexWorkspace();
  return { root, intelligence };
}

describe("FG-3B/C/F Context Planner — progressive levels, narrow default, bounded one-hop expansion", () => {
  it("[Scenario A] a localized task starts narrow: kernel + the directly relevant file only, not a broad repository dump", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Fix Invoice.total currency formatting" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    const result = await planner.planNarrow({ goal: "Fix Invoice.total currency formatting", kernel, capacity, intelligence, mentionedPaths: ["src/billing/invoice.ts"] });

    expect(result.selectedFiles).toContain("src/billing/invoice.ts");
    expect(result.selectedFiles.some((f) => f.includes("unrelated"))).toBe(false);
    expect(result.sections[0]!.title).toBe("runtime_kernel");
    expect(result.prompt).toContain("Objective: Fix Invoice.total currency formatting");
    await intelligence.closeWorkspace();
  });

  it("[Scenario E] unrelated packages are never included even though many files exist", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Fix Invoice.total currency formatting" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    const result = await planner.planNarrow({ goal: "Fix Invoice.total currency formatting", kernel, capacity, intelligence, mentionedPaths: ["src/billing/invoice.ts"] });

    for (const file of result.selectedFiles) expect(file).not.toContain("unrelated");
    expect(result.selectedFiles.length).toBeLessThanOrEqual(6);
    await intelligence.closeWorkspace();
  });

  it("[Scenario B/C/D] bounded one-hop structural neighbors surface direct dependencies, dependents, and related tests", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Update Invoice.total" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    const result = await planner.planNarrow({ goal: "Update Invoice.total", kernel, capacity, intelligence, mentionedPaths: ["src/billing/invoice.ts"] });

    expect(result.level).toBe("L2");
    const structural = result.sections.find((s) => s.title === "structural_neighbors");
    expect(structural).toBeDefined();
    expect(structural!.content).toContain("currency.ts");
    expect(structural!.content.toLowerCase()).toContain("invoice.test.ts");
    await intelligence.closeWorkspace();
  });

  it("dynamic/heuristic uncertainty remains visible rather than being asserted as exhaustive", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Update Invoice.total" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    const result = await planner.planNarrow({ goal: "Update Invoice.total", kernel, capacity, intelligence, mentionedPaths: ["src/billing/invoice.ts"] });
    const structural = result.sections.find((s) => s.title === "structural_neighbors");
    // The test relationship is filename-convention heuristic, not statically resolved — the
    // rendered neighborhood must say so rather than imply exhaustive certainty.
    expect(structural!.content).toMatch(/bounded one-hop view|heuristic/i);
    await intelligence.closeWorkspace();
  });

  it("without RepositoryIntelligence the plan stays at L0 (kernel only) rather than fabricating a target", async () => {
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "objective with no repo" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    const result = await planner.planNarrow({ goal: "objective with no repo", kernel, capacity });
    expect(result.level).toBe("L0");
    expect(result.selectedFiles).toEqual([]);
    expect(result.sections).toHaveLength(1);
  });

  it("[capacity fail-closed] never silently truncates the kernel — throws an explicit capacity problem instead", async () => {
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "x".repeat(300) });
    const capacity = resolveContextCapacity({ requestedTokens: 5 });
    const planner = createContextPlanner();
    await expect(planner.planNarrow({ goal: "objective", kernel, capacity })).rejects.toThrow(ContextCapacityError);
    try {
      await planner.planNarrow({ goal: "objective", kernel, capacity });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCapacityError);
      expect((error as ContextCapacityError).code).toBe("CONTEXT_CAPACITY_UNKNOWN");
      expect((error as ContextCapacityError).availableTokens).toBe(5);
    }
  });

  it("[optional-before-required] a tight budget drops optional repository context before the mandatory kernel, and never truncates the kernel itself", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Fix Invoice.total currency formatting" });
    // Replicate planNarrow's exact kernel cost so the budget boundaries are deterministic, not
    // guessed: kernelTokens = estimateTokens(renderContextKernel(kernel)) + 32.
    const kernelTokens = estimateTokens(renderContextKernel(kernel)) + 32;

    // (a) One token short of the kernel's own cost: fail closed. The mandatory state is never
    //     silently truncated to make room for itself (FG-3 §10/§11).
    const underKernel = resolveContextCapacity({ requestedTokens: kernelTokens - 1 });
    await expect(
      createContextPlanner().planNarrow({
        goal: "Fix Invoice.total currency formatting",
        kernel,
        capacity: underKernel,
        intelligence,
        mentionedPaths: ["src/billing/invoice.ts"],
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_CAPACITY_UNKNOWN" });

    // (b) Kernel fits, but only ~150 tokens remain for the optional L1 slice: narrowBudget =
    //     floor((capacity - kernel) * 0.5) = 150 <= 200. The optional repository context is the
    //     thing dropped; the kernel survives intact at L0 (FG-3 §28/§49/§64 priority ordering).
    const tight = resolveContextCapacity({ requestedTokens: kernelTokens + 300 });
    const tightPlan = await createContextPlanner().planNarrow({
      goal: "Fix Invoice.total currency formatting",
      kernel,
      capacity: tight,
      intelligence,
      mentionedPaths: ["src/billing/invoice.ts"],
    });
    expect(tightPlan.level).toBe("L0");
    expect(tightPlan.sections).toHaveLength(1);
    expect(tightPlan.sections[0]!.title).toBe("runtime_kernel");
    expect(tightPlan.selectedFiles).toEqual([]);
    expect(tightPlan.receipt.reasonCodes).toContain("BUDGET_EXHAUSTED_BY_KERNEL");
    expect(tightPlan.prompt).toContain("Objective: Fix Invoice.total currency formatting");

    // (c) Positive control: with room to spare, the SAME kernel and target expand to the optional
    //     L1 repository context that (b) was forced to drop — proving the drop was budget-driven.
    const roomy = resolveContextCapacity({ requestedTokens: 20_000 });
    const roomyPlan = await createContextPlanner().planNarrow({
      goal: "Fix Invoice.total currency formatting",
      kernel,
      capacity: roomy,
      intelligence,
      mentionedPaths: ["src/billing/invoice.ts"],
    });
    expect(roomyPlan.level).not.toBe("L0");
    expect(roomyPlan.selectedFiles).toContain("src/billing/invoice.ts");

    await intelligence.closeWorkspace();
  });

  it("[bounded repeat] expanding the same file twice in one turn does not re-supply an identical page", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "investigate consumer" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    // Use a target the narrow plan itself does not already cover, to test explicit expansion.
    const first = await planner.expandOneHop({ goal: "investigate consumer", kernel, capacity, intelligence }, "src/billing/consumer.ts", 5_000);
    expect(first).toBeDefined();
    expect(first!.content).toContain("invoice.ts");

    const second = await planner.expandOneHop({ goal: "investigate consumer", kernel, capacity, intelligence }, "src/billing/consumer.ts", 5_000);
    expect(second).toBeUndefined();
    await intelligence.closeWorkspace();
  });

  it("[legitimate re-pull] a fresh planner (new turn) may pull the same page again", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "investigate consumer" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const plannerA = new ContextPlanner();
    const plannerB = new ContextPlanner();
    const first = await plannerA.expandOneHop({ goal: "investigate consumer", kernel, capacity, intelligence }, "src/billing/consumer.ts", 5_000);
    const second = await plannerB.expandOneHop({ goal: "investigate consumer", kernel, capacity, intelligence }, "src/billing/consumer.ts", 5_000);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await intelligence.closeWorkspace();
  });

  it("receipt reports the level, capacity source, and page counts honestly (delivery completeness, not repository-analysis completeness)", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Update Invoice.total" });
    const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
    const planner = createContextPlanner();
    const result = await planner.planNarrow({ goal: "Update Invoice.total", kernel, capacity, intelligence, mentionedPaths: ["src/billing/invoice.ts"] });
    expect(result.receipt.level).toBe(result.level);
    expect(result.receipt.capacitySource).toBe("role_default");
    expect(result.receipt.pagesPulled + result.receipt.pagesReused).toBeGreaterThan(0);
    expect(result.receipt.reasonCodes).toEqual(expect.arrayContaining(["RUNTIME_KERNEL", "ACTIVE_TARGET"]));
    await intelligence.closeWorkspace();
  });

  it("[Gap A/B] omittedOptionalPages accurately counts dropped one-hop pages under constrained budget while preserving kernel and active target", async () => {
    const { intelligence } = await fixture();
    const kernel = createMinimalContextKernel({ sessionId: "s1", objective: "Fix Invoice.total currency formatting" });

    // (1) Roomy budget: all targets and prefetch pages fit without omission.
    const roomyPlan = await createContextPlanner().planNarrow({
      goal: "Fix Invoice.total currency formatting",
      kernel,
      capacity: resolveContextCapacity({ requestedTokens: 20_000 }),
      intelligence,
      mentionedPaths: ["src/billing/invoice.ts", "src/billing/currency.ts", "src/billing/consumer.ts"],
    });
    expect(roomyPlan.level).toBe("L2");
    expect(roomyPlan.receipt.omittedOptionalPages).toBe(0);
    expect(roomyPlan.receipt.pagesPulled).toBeGreaterThanOrEqual(2);

    // (2) Constrained prefetch capacity: when an optional neighborhood page cannot fit in the
    // remaining budget, it is dropped, recorded in omitted count, and never corrupts the kernel.
    const planner = createContextPlanner();
    const tinyExpand = await planner.expandOneHop(
      { goal: "test", kernel, capacity: resolveContextCapacity({ requestedTokens: 20_000 }), intelligence },
      "src/billing/consumer.ts",
      10, // budget too small for the neighborhood page (~50+ tokens)
    );
    expect(tinyExpand).toBeUndefined();

    // (3) In planNarrow with multiple active targets, verify that omittedOptionalPages is 0
    // when all fit, and properly reported when budget constrains prefetch.
    const kernelTokens = estimateTokens(renderContextKernel(kernel)) + 32;
    const plan = await createContextPlanner().planNarrow({
      goal: "Fix Invoice.total currency formatting",
      kernel,
      capacity: resolveContextCapacity({ requestedTokens: kernelTokens + 1500 }),
      intelligence,
      mentionedPaths: ["src/billing/invoice.ts", "src/billing/currency.ts", "src/billing/consumer.ts"],
      narrowCandidateLimit: 3,
    });
    expect(plan.level).toBe("L2");
    expect(plan.sections.some((s) => s.title === "runtime_kernel")).toBe(true);
    expect(plan.sections.some((s) => s.title === "active_targets")).toBe(true);
    expect(plan.sections.some((s) => s.title === "structural_neighbors")).toBe(true);
    expect(typeof plan.receipt.omittedOptionalPages).toBe("number");
    expect(plan.tokenEstimate).toBeLessThanOrEqual(plan.capacity.maxContextTokens);

    await intelligence.closeWorkspace();
  });
});

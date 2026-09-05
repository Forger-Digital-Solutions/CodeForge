import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import {
  buildContextPack,
  createContextAssembler,
  estimateTokens,
  type ContextPack,
} from "../src/index.js";

const cleanupDirs: string[] = [];

function fixture(): { root: string; cache: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf14-ctx-repo-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cf14-ctx-cache-"));
  cleanupDirs.push(root, cache);

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "src", "dispatcher.ts"),
    "export class EventDispatcher {\n  dispatch(event: string): boolean { return event.length > 0; }\n}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src", "handler.ts"),
    "import { EventDispatcher } from './dispatcher.js';\nexport class ActionHandler {\n  private d = new EventDispatcher();\n  handle(action: string): void { this.d.dispatch(action); }\n}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "tests", "handler.test.ts"),
    "import { ActionHandler } from '../src/handler.js';\nit('handles action', () => new ActionHandler().handle('test'));\n",
    "utf8",
  );

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "CodeForge"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codeforge@test.local"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "Initial"], { cwd: root });

  return { root, cache };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("CF-14 Context Assembly & Provenance", () => {
  it("assembles context deterministically with identical hash across replays", async () => {
    const { root, cache } = fixture();
    const intel = createRepositoryIntelligence({ cacheRoot: cache });
    await intel.openWorkspace(root);
    await intel.indexWorkspace();

    const task = "Fix the EventDispatcher dispatch logic and update handler tests";
    const pack1 = await buildContextPack(task, intel, { contextWindow: 32_000 });
    const pack2 = await buildContextPack(task, intel, { contextWindow: 32_000 });

    // Deterministic ordering and content hash
    expect(pack1.receipt.contextHash).toBe(pack2.receipt.contextHash);
    expect(pack1.selectedFiles).toEqual(pack2.selectedFiles);
    expect(pack1.chunks.map((c) => c.id)).toEqual(pack2.chunks.map((c) => c.id));
    expect(pack1.receipt.repositoryGeneration).toBeGreaterThanOrEqual(1);
    expect(pack1.receipt.reasonCodes.length).toBeGreaterThan(0);

    await intel.closeWorkspace();
  });

  it("enforces role-based subagent context isolation", async () => {
    const { root, cache } = fixture();
    const intel = createRepositoryIntelligence({ cacheRoot: cache });
    await intel.openWorkspace(root);
    await intel.indexWorkspace();

    const assembler = createContextAssembler(32_000);

    // 1. Explorer: gets repo map overview and candidate hints
    const explorerCtx = await assembler.assemble({
      role: "explorer",
      goal: "Explore ActionHandler architecture",
      workspacePath: root,
      intelligence: intel,
    });
    expect(explorerCtx.contextPrompt).toContain("Repository Map");
    expect(explorerCtx.contextPrompt).toContain("ActionHandler");
    expect(explorerCtx.evidence.some((e) => e.source === "search")).toBe(true);

    // 2. Coder: gets task plan and bounded file slices (does not get explorer raw findings)
    const coderCtx = await assembler.assemble({
      role: "coder",
      goal: "Implement ActionHandler enhancements",
      workspacePath: root,
      intelligence: intel,
      taskPlan: "1. Update ActionHandler\n2. Add test case",
    });
    expect(coderCtx.contextPrompt).toContain("Implementation Plan");
    expect(coderCtx.contextPrompt).toContain("File: src/handler.ts");
    expect(coderCtx.evidence.some((e) => e.source === "file")).toBe(true);

    // 3. Reviewer: gets git diff and verification results, STRICTLY omitting Coder's plan or scratchpad
    const reviewerCtx = await assembler.assemble({
      role: "reviewer",
      goal: "Review ActionHandler changes",
      workspacePath: root,
      diff: "diff --git a/src/handler.ts b/src/handler.ts\n+ export const reviewNeedle = true;",
      verificationEvidence: "PASS: tests/handler.test.ts (1 test passed)",
    });
    expect(reviewerCtx.contextPrompt).toContain("Git Diff Under Review");
    expect(reviewerCtx.contextPrompt).toContain("reviewNeedle");
    expect(reviewerCtx.contextPrompt).toContain("Verification Results");
    expect(reviewerCtx.contextPrompt).not.toContain("Implementation Plan");

    await intel.closeWorkspace();
  });

  it("bounds context strictly within budget and never dumps entire repository", async () => {
    const { root, cache } = fixture();
    // Add multiple additional large files
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(root, "src", `extra-${i}.ts`),
        `export function extraHelper${i}(): number { return ${i}; }\n`.repeat(100),
        "utf8",
      );
    }

    const intel = createRepositoryIntelligence({ cacheRoot: cache });
    await intel.openWorkspace(root);
    await intel.indexWorkspace();

    // Request with small budget
    const smallBudget = 8_000;
    const pack = await buildContextPack("Fix ActionHandler", intel, {
      contextWindow: smallBudget,
      systemPromptTokens: 2_000,
      toolSchemaTokens: 2_000,
      reservedOutputTokens: 1_000,
      safetyMarginTokens: 500,
    });

    expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.budget.repository);
    expect(pack.chunks.length).toBeGreaterThan(0);
    // Irrelevant extra files must not be dumped into context
    expect(pack.selectedFiles).not.toContain("src/extra-19.ts");

    await intel.closeWorkspace();
  });
});

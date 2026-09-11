import fs from "node:fs";
import path from "node:path";
import { createContextPlanner, createMinimalContextKernel, resolveContextCapacity, type ContextPlanResult } from "@codeforge/context";
import { createVerifierRegistry, type VerificationPolicy, type VerificationPolicyVersion, type VerifierDefinition, type VerifierId, type VerifierVersion } from "@codeforge/workflow";
import type { ObservationInput, ObservationStore } from "./observation-store.js";
import { observeCandidateA, type CandidateAStep } from "./candidate-a-observer.js";
import { observeCandidateB, type TurnPlanResult } from "./candidate-b-observer.js";
import { observeCandidateC } from "./candidate-c-observer.js";
import { observeCandidateD } from "./candidate-d-observer.js";
import { disposeFixture, FIXTURE_FILE_SETS, materializeFixture, mutateFixtureFile, type CampaignFixture } from "./fixtures.js";
import type { CampaignIdentity } from "./source-state.js";

export interface RunContext {
  store: ObservationStore;
  identity: CampaignIdentity;
}

async function turn(fixture: CampaignFixture, turnIndex: number, goal: string, mentionedPaths: string[], requiredPaths?: string[]): Promise<TurnPlanResult> {
  const kernel = createMinimalContextKernel({ sessionId: fixture.id, objective: goal });
  const capacity = resolveContextCapacity({ requestedTokens: 20_000 });
  const planner = createContextPlanner();
  const plan: ContextPlanResult = await planner.planNarrow({
    goal,
    kernel,
    capacity,
    intelligence: fixture.intelligence,
    mentionedPaths,
    pageStore: fixture.pageStore,
    requiredPaths,
  });
  return { turnIndex, plan };
}

function syntaxVerifier(id: string, relFilePath: string): VerifierDefinition {
  return {
    id: id as VerifierId,
    version: "1" as VerifierVersion,
    name: `syntax:${relFilePath}`,
    category: "lint",
    description: `Node syntax check for ${relFilePath}`,
    execution: { executable: process.execPath, args: ["--check", relFilePath] },
    defaultRequirement: "required",
    timeoutMs: 15_000,
    maxAttempts: 1,
    supportedScopes: ["workspace"],
  };
}

function policyFor(verifierIds: string[]): VerificationPolicy {
  return { version: "fg11-campaign-verify-1" as VerificationPolicyVersion, requiredVerifierIds: verifierIds as VerifierId[] };
}

let runCounter = 0;
function nextRunId(taskId: string, fixtureId: string): string {
  runCounter += 1;
  return `fg11-${taskId}-${fixtureId}-${runCounter}-${Date.now().toString(36)}`;
}

interface TaskResult {
  taskId: string;
  observationsInserted: number;
}

function ingestAll(ctx: RunContext, observations: readonly ObservationInput[]): number {
  let inserted = 0;
  for (const observation of observations) {
    if (ctx.store.ingest(observation).inserted) inserted += 1;
  }
  return inserted;
}

const BILLING = FIXTURE_FILE_SETS[0]!;
const AUTH = FIXTURE_FILE_SETS[1]!;
const BILLING_MENTIONED = ["src/billing/invoice.ts", "src/billing/currency.ts", "src/billing/consumer.ts"];
const AUTH_MENTIONED = ["src/auth/middleware.ts", "src/auth/session.ts", "src/auth/token.ts"];

// ---------------------------------------------------------------------------
// Task 1 — Small bug fix: read a small file set, revisit the same targets in a later turn
// (real Candidate B re-pull + Candidate C classification opportunities).
// ---------------------------------------------------------------------------
async function task1SmallBugFix(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task1-small-bug-fix";
  const fileSet = variant % 2 === 0 ? BILLING : AUTH;
  const mentioned = fileSet === BILLING ? BILLING_MENTIONED.slice(0, 1) : AUTH_MENTIONED.slice(0, 1);
  const required = fileSet === BILLING ? ["src/billing/currency.ts"] : ["src/auth/token.ts"];
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Fix a small formatting/logic bug in a single-file change`;
    const turn1 = await turn(fixture, 1, goal, mentioned, required);
    const turn2 = await turn(fixture, 2, goal, mentioned, required);
    const dims = { repositoryState: `${fixture.id}-s1`, task: taskId, variant: String(variant) };
    const bObs = observeCandidateB({ runId, taskId, ...ctx.identity, turns: [turn1, turn2], diversityDimensions: dims });
    const cObs = observeCandidateC({ runId, taskId, ...ctx.identity, turns: [turn1, turn2], diversityDimensions: dims });

    const target = fileSet === BILLING ? "src/billing/invoice.ts" : "src/auth/session.ts";
    const verifierId = `fg11.task1.v${variant}.syntax`;
    const registry = createVerifierRegistry([syntaxVerifier(verifierId, target)]);
    const policy = policyFor([verifierId]);
    const { observations: dObs } = await observeCandidateD({
      runId,
      taskId,
      ...ctx.identity,
      registry,
      policy,
      workspacePath: fixture.root,
      scope: "workspace",
      mutate: async () => mutateFixtureFile(fixture, target, `${await readCurrent(fixture, target)}\n// fg11 task1 v${variant} edit\n`),
      diversityDimensions: { ...dims, invalidationReason: "CHANGED_SOURCE" },
    });

    return { taskId, observationsInserted: ingestAll(ctx, bObs) + ingestAll(ctx, cObs) + ingestAll(ctx, dObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

async function readCurrent(fixture: CampaignFixture, relPath: string): Promise<string> {
  return fs.readFileSync(path.join(fixture.root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Task 2 — Multi-file bug fix across a dependency chain; several files each re-visited.
// ---------------------------------------------------------------------------
async function task2MultiFileBugFix(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task2-multi-file-bug-fix";
  const fileSet = variant % 2 === 0 ? BILLING : AUTH;
  const mentioned = fileSet === BILLING ? BILLING_MENTIONED : AUTH_MENTIONED;
  const required = mentioned.slice(1);
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Trace and fix a bug across the whole dependency chain`;
    const turns: TurnPlanResult[] = [];
    for (let i = 1; i <= 3; i++) turns.push(await turn(fixture, i, goal, mentioned, required));
    const dims = { repositoryState: `${fixture.id}-s1`, task: taskId, variant: String(variant) };
    const bObs = observeCandidateB({ runId, taskId, ...ctx.identity, turns, diversityDimensions: dims });
    const cObs = observeCandidateC({ runId, taskId, ...ctx.identity, turns, diversityDimensions: dims });

    const targets = fileSet === BILLING ? ["src/billing/consumer.ts", "src/billing/invoice.ts", "src/billing/currency.ts"] : ["src/auth/middleware.ts", "src/auth/session.ts", "src/auth/token.ts"];
    const ids = targets.map((_, i) => `fg11.task2.v${variant}.${i}`);
    const registry = createVerifierRegistry(targets.map((t, i) => syntaxVerifier(ids[i]!, t)));
    const policy = policyFor(ids);
    const { observations: dObs } = await observeCandidateD({
      runId,
      taskId,
      ...ctx.identity,
      registry,
      policy,
      workspacePath: fixture.root,
      scope: "workspace",
      mutate: async () => mutateFixtureFile(fixture, targets[0]!, `${await readCurrent(fixture, targets[0]!)}\n// fg11 task2 v${variant} edit\n`),
      diversityDimensions: { ...dims, invalidationReason: "CHANGED_SOURCE" },
    });

    return { taskId, observationsInserted: ingestAll(ctx, bObs) + ingestAll(ctx, cObs) + ingestAll(ctx, dObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 3 — Repository search: exploratory turns, no required-ness signal at all (INSUFFICIENT).
// ---------------------------------------------------------------------------
async function task3RepositorySearch(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task3-repository-search";
  const fileSet = variant % 2 === 0 ? AUTH : BILLING;
  const mentioned = fileSet === BILLING ? BILLING_MENTIONED : AUTH_MENTIONED;
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Locate where the relevant chain is implemented`;
    const turns: TurnPlanResult[] = [await turn(fixture, 1, goal, mentioned, undefined), await turn(fixture, 2, goal, mentioned, undefined)];
    const dims = { repositoryState: `${fixture.id}-s1`, task: taskId, variant: String(variant) };
    const bObs = observeCandidateB({ runId, taskId, ...ctx.identity, turns, diversityDimensions: dims });
    const cObs = observeCandidateC({ runId, taskId, ...ctx.identity, turns, controlCase: "insufficient_no_required_signal", diversityDimensions: dims });
    return { taskId, observationsInserted: ingestAll(ctx, bObs) + ingestAll(ctx, cObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 4 — Context-heavy: a wide surface, several progressive turns.
// ---------------------------------------------------------------------------
async function task4ContextHeavy(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task4-context-heavy";
  const fileSet = variant % 2 === 0 ? AUTH : BILLING;
  const mentioned = fileSet === BILLING ? BILLING_MENTIONED : AUTH_MENTIONED;
  const required = mentioned.slice(0, 2);
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Review the whole surface before making a change`;
    const turns: TurnPlanResult[] = [];
    for (let i = 1; i <= 4; i++) turns.push(await turn(fixture, i, goal, mentioned, required));
    const dims = { repositoryState: `${fixture.id}-s1`, task: taskId, variant: String(variant) };
    const bObs = observeCandidateB({ runId, taskId, ...ctx.identity, turns, diversityDimensions: dims });
    const cObs = observeCandidateC({ runId, taskId, ...ctx.identity, turns, diversityDimensions: dims });
    return { taskId, observationsInserted: ingestAll(ctx, bObs) + ingestAll(ctx, cObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 5 — Tool-heavy: Candidate A positive control.
// ---------------------------------------------------------------------------
async function task5ToolHeavy(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task5-tool-heavy";
  const runId = nextRunId(taskId, `toolheavy-v${variant}`);
  const targetFile = variant % 2 === 0 ? "src/billing/invoice.ts" : "src/auth/session.ts";
  const steps: CandidateAStep[] = [
    { tool: "read_file", args: { path: targetFile }, simulatedBytes: 512, simulatedMs: 8 },
    { tool: "read_file", args: { path: targetFile }, simulatedBytes: 512, simulatedMs: 8 },
    { tool: "read_file", args: { path: targetFile }, simulatedBytes: 512, simulatedMs: 8 },
    { tool: "write_file", args: { path: targetFile }, simulatedBytes: 512, simulatedMs: 8 },
    { tool: "read_file", args: { path: targetFile }, simulatedBytes: 512, simulatedMs: 8, mutationBefore: true },
    { tool: "search_files", args: { query: `token-${variant}` }, simulatedBytes: 256, simulatedMs: 4 },
    { tool: "search_files", args: { query: `token-${variant}` }, simulatedBytes: 256, simulatedMs: 4 },
    { tool: "list_files", args: { dir: "src" }, simulatedBytes: 128, simulatedMs: 2 },
    { tool: "list_files", args: { dir: "src" }, simulatedBytes: 128, simulatedMs: 2 },
  ];
  const observations = observeCandidateA({ runId, taskId, ...ctx.identity, steps, diversityDimensions: { task: taskId, variant: String(variant) } });
  return { taskId, observationsInserted: ingestAll(ctx, observations) };
}

// ---------------------------------------------------------------------------
// Task 6 — Verification-heavy: several verifiers, identical-state rerun control.
// ---------------------------------------------------------------------------
async function task6VerificationHeavy(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task6-verification-heavy";
  const fileSet = variant % 2 === 0 ? BILLING : AUTH;
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const targets = fileSet === BILLING ? ["src/billing/invoice.ts", "src/billing/currency.ts", "src/billing/consumer.ts"] : ["src/auth/middleware.ts", "src/auth/session.ts", "src/auth/token.ts"];
    const ids = targets.map((_, i) => `fg11.task6.v${variant}.${i}`);
    const registry = createVerifierRegistry(targets.map((t, i) => syntaxVerifier(ids[i]!, t)));
    const policy = policyFor(ids);
    const dims = { repositoryState: `${fixture.id}-s1-unchanged`, task: taskId, variant: String(variant) };
    const { observations: dObs } = await observeCandidateD({
      runId,
      taskId,
      ...ctx.identity,
      registry,
      policy,
      workspacePath: fixture.root,
      scope: "workspace",
      controlCase: "identical_state_equivalent_pass",
      diversityDimensions: dims,
    });
    return { taskId, observationsInserted: ingestAll(ctx, dObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 7 — Change-and-rerun: baseline verification, a real mutation, rerun (D invalidation).
// Cycles through several distinct invalidation shapes across variants.
// ---------------------------------------------------------------------------
async function task7ChangeAndRerun(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task7-change-and-rerun";
  const fileSet = variant % 2 === 0 ? BILLING : AUTH;
  const target = fileSet === BILLING ? "src/billing/currency.ts" : "src/auth/token.ts";
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const verifierId = `fg11.task7.v${variant}`;
    const shapes = ["changed_source", "changed_verification_command", "restart_between_evidence_and_rerun"] as const;
    const controlCase = shapes[variant % shapes.length]!;

    const registry = createVerifierRegistry([syntaxVerifier(verifierId, target)]);
    const policy = policyFor([verifierId]);
    let mutate: (() => Promise<void>) | undefined = async () => mutateFixtureFile(fixture, target, `${await readCurrent(fixture, target)}\n// fg11 task7 ${controlCase}\n`);
    let freshRegistry = registry;

    if (controlCase === "changed_verification_command") {
      // The rerun plan uses a DIFFERENT verifier definition (different args) for the same id —
      // definitionDigest changes even though the source file itself is never mutated.
      mutate = undefined;
      freshRegistry = createVerifierRegistry([{ ...syntaxVerifier(verifierId, target), execution: { executable: process.execPath, args: ["--stack-trace-limit=64", "--check", target] } }]);
    }

    const dims = { repositoryState: `${fixture.id}-s1->s2`, task: taskId, variant: String(variant) };
    const { observations: dObs } = await observeCandidateD({
      runId,
      taskId,
      ...ctx.identity,
      registry,
      policy,
      freshRegistry,
      workspacePath: fixture.root,
      scope: "workspace",
      controlCase,
      mutate,
      diversityDimensions: dims,
    });
    return { taskId, observationsInserted: ingestAll(ctx, dObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 8 — Optional-context task: a one-hop page pulled but never actually required (SAFE).
// ---------------------------------------------------------------------------
async function task8OptionalContext(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task8-optional-context-unnecessary";
  const fileSet = variant % 2 === 0 ? AUTH : BILLING;
  const primary = fileSet === BILLING ? "src/billing/consumer.ts" : "src/auth/middleware.ts";
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Add a log line inside the entrypoint only`;
    const turns = [await turn(fixture, 1, goal, [primary], [primary])];
    const dims = { repositoryState: `${fixture.id}-s1`, task: taskId, variant: String(variant) };
    const cObs = observeCandidateC({ runId, taskId, ...ctx.identity, turns, controlCase: "optional_remains_unnecessary", diversityDimensions: dims });
    return { taskId, observationsInserted: ingestAll(ctx, cObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 9 — Optional-context promotion: material that starts with no signal becomes required.
// ---------------------------------------------------------------------------
async function task9OptionalPromotion(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task9-optional-context-promoted";
  const fileSet = variant % 2 === 0 ? AUTH : BILLING;
  const primary = fileSet === BILLING ? "src/billing/invoice.ts" : "src/auth/session.ts";
  const promoted = fileSet === BILLING ? "src/billing/currency.ts" : "src/auth/token.ts";
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Change how the primary entrypoint behaves`;
    const turn1 = await turn(fixture, 1, goal, [primary], undefined);
    const turn2 = await turn(fixture, 2, goal, [primary], [promoted]);
    const dims = { repositoryState: `${fixture.id}-s1`, task: taskId, variant: String(variant) };
    const cObs = observeCandidateC({ runId, taskId, ...ctx.identity, turns: [turn1, turn2], controlCase: "later_required_dependency_discovered", diversityDimensions: dims });
    return { taskId, observationsInserted: ingestAll(ctx, cObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 10 — Restart/recovery: a fresh ObservationStore over the same file must not inflate counts.
// ---------------------------------------------------------------------------
async function task10RestartRecovery(ctx: RunContext, storeFactory: () => ObservationStore): Promise<TaskResult> {
  const taskId = "task10-restart-recovery";
  const fixture = await materializeFixture(BILLING);
  try {
    const runId = nextRunId(taskId, fixture.id);
    const goal = "Fix Invoice.total currency formatting (restart-recovery run)";
    const mentioned = ["src/billing/invoice.ts"];
    const required = ["src/billing/currency.ts"];
    const turn1 = await turn(fixture, 1, goal, mentioned, required);
    const turn2 = await turn(fixture, 2, goal, mentioned, required);
    const bObs = observeCandidateB({ runId, taskId, ...ctx.identity, turns: [turn1, turn2], controlCase: "restart_between_occurrences", diversityDimensions: { repositoryState: "billing-s1", task: taskId } });

    const inserted = ingestAll(ctx, bObs);
    const recreatedStore = storeFactory();
    const beforeReplay = recreatedStore.all("B").length;
    for (const observation of bObs) recreatedStore.ingest(observation);
    const afterReplay = recreatedStore.all("B").length;
    if (afterReplay !== beforeReplay) {
      throw new Error(`FG11 restart-replay inflated Candidate B count: ${beforeReplay} -> ${afterReplay}`);
    }
    return { taskId, observationsInserted: inserted };
  } finally {
    await disposeFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// Task 11 — Candidate B deliberate invalidation control: a real content edit to the mentioned
// target between two turns must never validate as a duplicate transmission.
// ---------------------------------------------------------------------------
async function task11BInvalidationControl(ctx: RunContext, variant: number): Promise<TaskResult> {
  const taskId = "task11-b-invalidation-control";
  const fileSet = variant % 2 === 0 ? BILLING : AUTH;
  const target = fileSet === BILLING ? "src/billing/invoice.ts" : "src/auth/session.ts";
  const dependency = fileSet === BILLING ? "src/billing/currency.ts" : "src/auth/token.ts";
  const fixture = await materializeFixture(fileSet);
  try {
    const runId = nextRunId(taskId, `${fixture.id}-v${variant}`);
    const goal = `[v${variant}] Change behavior in the primary entrypoint`;
    const turn1 = await turn(fixture, 1, goal, [target], [dependency]);
    await mutateFixtureFile(fixture, target, `${await readCurrent(fixture, target)}\n// fg11 task11 v${variant} real content edit\n`);
    const turn2 = await turn(fixture, 2, goal, [target], [dependency]);
    const bObs = observeCandidateB({
      runId,
      taskId,
      ...ctx.identity,
      turns: [turn1, turn2],
      controlCase: "changed_content_between_turns",
      diversityDimensions: { repositoryState: `${fixture.id}-s1->s2`, task: taskId, variant: String(variant) },
    });
    return { taskId, observationsInserted: ingestAll(ctx, bObs) };
  } finally {
    await disposeFixture(fixture);
  }
}

export async function runAllTasks(ctx: RunContext, storeFactory: () => ObservationStore): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  const variants = [0, 1, 2, 3];
  for (const v of variants) results.push(await task1SmallBugFix(ctx, v));
  for (const v of variants) results.push(await task2MultiFileBugFix(ctx, v));
  for (const v of [0, 1]) results.push(await task3RepositorySearch(ctx, v));
  for (const v of [0, 1]) results.push(await task4ContextHeavy(ctx, v));
  for (const v of [0, 1]) results.push(await task5ToolHeavy(ctx, v));
  for (const v of [0, 1, 2]) results.push(await task6VerificationHeavy(ctx, v));
  for (const v of [0, 1, 2, 3, 4, 5]) results.push(await task7ChangeAndRerun(ctx, v));
  results.push(await task8OptionalContext(ctx, 0));
  results.push(await task8OptionalContext(ctx, 1));
  results.push(await task9OptionalPromotion(ctx, 0));
  results.push(await task9OptionalPromotion(ctx, 1));
  results.push(await task10RestartRecovery(ctx, storeFactory));
  for (const v of [0, 1, 2, 3]) results.push(await task11BInvalidationControl(ctx, v));
  return results;
}

export const TASK_IDS = [
  "task1-small-bug-fix",
  "task2-multi-file-bug-fix",
  "task3-repository-search",
  "task4-context-heavy",
  "task5-tool-heavy",
  "task6-verification-heavy",
  "task7-change-and-rerun",
  "task8-optional-context-unnecessary",
  "task9-optional-context-promoted",
  "task10-restart-recovery",
] as const;

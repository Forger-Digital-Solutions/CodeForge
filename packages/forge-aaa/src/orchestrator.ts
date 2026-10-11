import crypto from "node:crypto";
import { classifyGoalSpecialties, forgeAaaSpecialty } from "./specialties.js";
import type { ForgeAaaLeadResolution } from "./lead-policy.js";
import type { ForgeAaaRouteDecision } from "./router.js";
import type { ForgeAaaVerificationReport } from "./verification.js";
import type { ForgeAaaAssetManifest } from "./manifest.js";
import type {
  ForgeAaaEngineTarget,
  ForgeAaaFinalStatus,
  ForgeAaaLeadPolicyId,
  ForgeAaaSpecialtyId,
  ForgeAaaTaskStatus,
} from "./types.js";

/**
 * ForgeAAA Director (mission §5): plan → capability-route → specialist execute → artifact
 * validate → independent review → verified deliverable. The director owns run state and
 * honesty: a task only reaches `verified` when its checks actually ran and passed.
 *
 * Model-backed execution is injected — the director itself never calls a provider. This
 * keeps ForgeAAA inside the server's entitlement boundaries: the executor supplied by the
 * server dispatches through existing roster/allowance machinery.
 */

export interface ForgeAaaTask {
  id: string;
  title: string;
  objective: string;
  specialty: ForgeAaaSpecialtyId;
  dependencies: string[];
  status: ForgeAaaTaskStatus;
  attempts: number;
  lastFailureSignature?: string;
  /** Produced manifest assetIds, or paths when no manifest applies. */
  artifacts: string[];
  evidence: { kind: "manifest" | "check" | "log" | "screenshot" | "route" | "review"; ref: string; detail?: string }[];
  detail?: string;
  /** Durable handoff: successful execution must not replay when verification resumes. */
  execution?: { partial: boolean; detail?: string };
}

export type ForgeAaaRunPhase =
  | "created"
  | "planning"
  | "executing"
  | "verifying"
  | "reviewing"
  | "done"
  | "cancelled";

export interface ForgeAaaRun {
  id: string;
  goal: string;
  projectPath?: string;
  engineTarget: ForgeAaaEngineTarget;
  leadPolicy: ForgeAaaLeadPolicyId;
  status: ForgeAaaRunPhase;
  tasks: ForgeAaaTask[];
  leadResolution?: ForgeAaaLeadResolution;
  routeDecisions: ForgeAaaRouteDecision[];
  verificationReports: ForgeAaaVerificationReport[];
  manifests: ForgeAaaAssetManifest[];
  review?: { approved: boolean; findings: string[]; independent: boolean };
  counters: { taskAttempts: number; retries: number; modelCalls: number; adapterOps: number };
  blockers: string[];
  finalStatus?: ForgeAaaFinalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  maxAttemptsPerTask?: number;
}

export interface ForgeAaaTaskExecution {
  ok: boolean;
  detail?: string;
  /** Asset manifests produced; also recorded on the run for provenance. */
  manifests?: ForgeAaaAssetManifest[];
  artifacts?: string[];
  evidence?: ForgeAaaTask["evidence"];
  /** When set, overrides status mapping: partial = useful output, checks incomplete. */
  partial?: boolean;
  /** Actual work reported by the executor; deterministic adapters are not model calls. */
  modelCalls?: number;
  adapterOps?: number;
}

export interface ForgeAaaDirectorDeps {
  /** Decomposes the goal into specialty tasks. Default: deterministic classifier plan —
   *  a bounded inspect→implement→verify chain per specialty, honest and model-free. */
  planner?: (goal: string, ctx: { engineTarget: ForgeAaaEngineTarget }) => ForgeAaaTask[];
  /** Capability routing per task; absent → every task blocks NO_ELIGIBLE_ROUTE. */
  routeTask?: (task: ForgeAaaTask, run: ForgeAaaRun) => ForgeAaaRouteDecision;
  /** Performs the task's work (model call and/or adapter ops). Required to execute. */
  executeTask?: (task: ForgeAaaTask, ctx: { run: ForgeAaaRun; route?: ForgeAaaRouteDecision }) => Promise<ForgeAaaTaskExecution>;
  /** Task verification; absent verification leaves successful work unverified. */
  verifyTask?: (task: ForgeAaaTask, run: ForgeAaaRun) => Promise<ForgeAaaVerificationReport>;
  /**
   * Independent review of produced artifacts/evidence before verified completion. The
   * reviewer reports whether it is actually independent of the implementer — the director
   * records it verbatim; structural-only reviewers report `independent: false`, which keeps
   * the run's claimed assurance honest.
   */
  reviewRun?: (run: ForgeAaaRun) => Promise<{ approved: boolean; findings: string[]; independent?: boolean }>;
  /** Durable checkpoint — invoked after every material transition. */
  persist?: (run: ForgeAaaRun) => Promise<void>;
  maxAttemptsPerTask?: number;
  now?: () => string;
}

const MAX_TASKS = 24;
const DEFAULT_MAX_ATTEMPTS = 2;

const TERMINAL_TASK_STATES = new Set<ForgeAaaTaskStatus>(["verified", "partial", "blocked", "failed"]);

function count(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function orderedTasks(tasks: ForgeAaaTask[]): ForgeAaaTask[] {
  if (tasks.length === 0 || tasks.length > MAX_TASKS) throw new Error(`task count must be between 1 and ${MAX_TASKS}`);
  const byId = new Map<string, ForgeAaaTask>();
  for (const task of tasks) {
    if (!task.id || byId.has(task.id)) throw new Error(`duplicate or empty task id: ${task.id}`);
    if (!Array.isArray(task.dependencies) || !count(task.attempts) || !Array.isArray(task.artifacts) || !Array.isArray(task.evidence)) {
      throw new Error(`malformed task: ${task.id}`);
    }
    if (!["planned", "generating", "integrating", "testing", "verified", "partial", "blocked", "failed"].includes(task.status)) {
      throw new Error(`invalid task status: ${task.id}`);
    }
    byId.set(task.id, task);
  }
  const ordered: ForgeAaaTask[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(task: ForgeAaaTask): void {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error(`cyclic dependency: ${task.id}`);
    visiting.add(task.id);
    for (const id of task.dependencies) {
      const dep = byId.get(id);
      if (!dep) throw new Error(`missing dependency ${id} for ${task.id}`);
      visit(dep);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  }
  for (const task of tasks) visit(task);
  return ordered;
}

function newTask(id: string, title: string, objective: string, specialty: ForgeAaaSpecialtyId, dependencies: string[] = []): ForgeAaaTask {
  return { id, title, objective, specialty, dependencies, status: "planned", attempts: 0, artifacts: [], evidence: [] };
}

/**
 * Deterministic slice planner: one inspection task, one implementation task per
 * classified specialty, one verification task depending on all implementations. A lead
 * model may replace this later — the output contract stays identical either way.
 */
export function defaultForgeAaaPlanner(goal: string): ForgeAaaTask[] {
  const specialties = classifyGoalSpecialties(goal).slice(0, 4);
  const tasks: ForgeAaaTask[] = [
    newTask("aaa-inspect", "Inspect project and target assets", `Inspect the project state relevant to: ${goal}`, "forge-architect"),
  ];
  const implIds: string[] = [];
  for (const [i, specialty] of specialties.entries()) {
    const id = `aaa-impl-${i}`;
    implIds.push(id);
    const spec = forgeAaaSpecialty(specialty)!;
    tasks.push(newTask(id, `${spec.displayName}: implement`, goal, specialty, ["aaa-inspect"]));
  }
  tasks.push(newTask("aaa-verify", "Verify deliverable", `Verify produced artifacts satisfy: ${goal}`, "forge-verify", implIds));
  return tasks;
}

function failureSignature(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[0-9a-f-]{16,}/gi, "#").slice(0, 200);
}

export class ForgeAaaDirector {
  private readonly runs = new Map<string, ForgeAaaRun>();
  private readonly maxAttempts: number;
  private readonly now: () => string;

  constructor(private readonly deps: ForgeAaaDirectorDeps = {}) {
    this.maxAttempts = deps.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS;
    if (!count(this.maxAttempts) || this.maxAttempts === 0) throw new Error("maxAttemptsPerTask must be a positive safe integer");
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  createRun(input: {
    goal: string;
    projectPath?: string;
    engineTarget?: ForgeAaaEngineTarget;
    leadPolicy?: ForgeAaaLeadPolicyId;
    leadResolution?: ForgeAaaLeadResolution;
  }): ForgeAaaRun {
    const now = this.now();
    const run: ForgeAaaRun = {
      id: `aaa-${crypto.randomUUID()}`,
      goal: input.goal,
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      engineTarget: input.engineTarget ?? "any",
      leadPolicy: input.leadPolicy ?? "auto",
      status: "created",
      tasks: [],
      routeDecisions: [],
      verificationReports: [],
      manifests: [],
      counters: { taskAttempts: 0, retries: 0, modelCalls: 0, adapterOps: 0 },
      blockers: [],
      createdAt: now,
      updatedAt: now,
      maxAttemptsPerTask: this.maxAttempts,
    };
    if (input.leadResolution) run.leadResolution = input.leadResolution;
    this.runs.set(run.id, run);
    return run;
  }

  getRun(runId: string): ForgeAaaRun | undefined {
    return this.runs.get(runId);
  }

  /** Serializable durable state — the whole run round-trips through persistence. */
  serialize(runId: string): ForgeAaaRun | undefined {
    const run = this.runs.get(runId);
    return run ? (JSON.parse(JSON.stringify(run)) as ForgeAaaRun) : undefined;
  }

  restore(run: ForgeAaaRun): void {
    this.runs.set(run.id, JSON.parse(JSON.stringify(run)) as ForgeAaaRun);
  }

  private async persist(run: ForgeAaaRun): Promise<void> {
    run.updatedAt = this.now();
    await this.deps.persist?.(run);
  }

  /**
   * Execute the run's pipeline to a terminal state. Sequential by default — the target
   * laptop cannot parallelize editor workloads, and ordered execution keeps failure
   * attribution exact. `verifying` is a real phase: task checks must execute, not assert.
   */
  async execute(runId: string): Promise<ForgeAaaRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} unknown`);
    if (run.status === "done" || run.status === "cancelled") return run;

    let tasks: ForgeAaaTask[];
    try {
      const storedLimit = run.maxAttemptsPerTask ?? this.maxAttempts;
      if (!count(storedLimit) || storedLimit === 0 || !Object.values(run.counters).every(count)) throw new Error("invalid execution budget or counters");
      run.maxAttemptsPerTask = Math.min(storedLimit, this.maxAttempts);
      if (run.tasks.length === 0) {
        if (run.status !== "created" && run.status !== "planning") throw new Error("interrupted run has no durable plan");
        run.status = "planning";
        const planner = this.deps.planner ?? ((goal: string) => defaultForgeAaaPlanner(goal));
        run.tasks = planner(run.goal, { engineTarget: run.engineTarget });
        if (run.tasks.some((task) => task.status !== "planned" || task.attempts !== 0)) throw new Error("planner must produce unexecuted tasks");
      }
      tasks = orderedTasks(run.tasks);
      if (tasks.some((task) => task.status === "verified" && task.dependencies.some((id) => run.tasks.find((dep) => dep.id === id)?.status !== "verified"))) {
        throw new Error("verified task has unfinished dependencies");
      }
    } catch (err) {
      run.blockers.push(`invalid plan or recovery state: ${err instanceof Error ? err.message : String(err)}`);
      run.finalStatus = "FORGEAAA_BLOCKED";
      run.status = "done";
      run.completedAt = this.now();
      await this.persist(run);
      return run;
    }
    await this.persist(run);

    if (tasks.some((task) => !TERMINAL_TASK_STATES.has(task.status))) delete run.review;
    run.status = "executing";
    for (const task of tasks) {
      if (TERMINAL_TASK_STATES.has(task.status)) continue;
      const unfinishedDeps = task.dependencies.filter((id) => run.tasks.find((dep) => dep.id === id)?.status !== "verified");
      if (unfinishedDeps.length > 0) {
        task.status = "blocked";
        task.detail = `dependency unfinished: ${unfinishedDeps.join(", ")}`;
        await this.persist(run);
        continue;
      }
      if (task.execution) {
        await this.verifyExecutedTask(run, task);
        continue;
      }
      if (task.status === "integrating" || task.status === "testing") {
        task.status = "blocked";
        task.detail = "interrupted execution has no durable result";
        await this.persist(run);
        continue;
      }
      const decision = this.deps.routeTask?.(task, run);
      if (decision) {
        run.routeDecisions.push(decision);
        task.evidence.push({ kind: "route", ref: `${decision.selected ? `${decision.selected.providerId}/${decision.selected.providerModelId}` : "none"}`, detail: decision.reasonCodes.join(",") });
      }
      if (!this.deps.executeTask) {
        task.status = "blocked";
        task.detail = "no executor configured";
        run.blockers.push(`${task.id}: no executor`);
        await this.persist(run);
        continue;
      }
      if (decision && decision.outcome !== "selected") {
        task.status = "blocked";
        task.detail = decision.reasonCodes.join("; ") || "no eligible route";
        await this.persist(run);
        continue;
      }
      await this.executeTaskBounded(run, task, decision);
      await this.persist(run);
    }

    run.status = "reviewing";
    await this.persist(run);
    if (!run.review && this.deps.reviewRun) {
      const review = await this.deps.reviewRun(run).catch((err) => ({ approved: false, findings: [err instanceof Error ? err.message : String(err)], independent: false }));
      run.review = { approved: review.approved, findings: review.findings, independent: review.independent === true };
      await this.persist(run);
    }
    run.finalStatus = this.finalStatus(run);
    run.status = "done";
    run.completedAt = this.now();
    await this.persist(run);
    return run;
  }

  private async executeTaskBounded(run: ForgeAaaRun, task: ForgeAaaTask, decision?: ForgeAaaRouteDecision): Promise<void> {
    const limit = run.maxAttemptsPerTask ?? this.maxAttempts;
    if (task.attempts >= limit) {
      task.status = "blocked";
      task.detail = "task attempt budget exhausted";
      return;
    }
    while (task.attempts < limit) {
      if (task.attempts > 0) run.counters.retries++;
      task.attempts++;
      run.counters.taskAttempts++;
      task.status = "generating";
      // Reserve the attempt before dispatch so a restart cannot replenish its budget.
      await this.persist(run);
      let result: ForgeAaaTaskExecution;
      try {
        result = await this.deps.executeTask!(task, { run, ...(decision ? { route: decision } : {}) });
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      if (!count(result.modelCalls ?? 0) || !count(result.adapterOps ?? 0)) {
        task.status = "blocked";
        task.detail = "invalid execution accounting";
        await this.persist(run);
        return;
      }
      run.counters.modelCalls += result.modelCalls ?? 0;
      run.counters.adapterOps += result.adapterOps ?? 0;
      for (const manifest of result.manifests ?? []) run.manifests.push(manifest);
      task.artifacts.push(...(result.artifacts ?? []), ...(result.manifests ?? []).map((manifest) => manifest.assetId));
      task.evidence.push(...(result.evidence ?? []));
      if (!result.ok) {
        const sig = failureSignature(result.detail ?? "unknown");
        if (sig === task.lastFailureSignature) {
          task.status = "blocked";
          task.detail = `repeated failure signature: ${sig.slice(0, 120)}`;
        } else {
          task.lastFailureSignature = sig;
          task.status = task.attempts < limit ? "generating" : "failed";
          task.detail = result.detail ?? "execution failed";
        }
        await this.persist(run);
        if (task.status === "generating") continue;
        return;
      }
      task.execution = { partial: result.partial === true, ...(result.detail ? { detail: result.detail } : {}) };
      task.status = "integrating";
      await this.persist(run);
      await this.verifyExecutedTask(run, task);
      return;
    }
  }

  private async verifyExecutedTask(run: ForgeAaaRun, task: ForgeAaaTask): Promise<void> {
    if (!this.deps.verifyTask) {
      task.status = "partial";
      task.detail = "no verifier configured";
      await this.persist(run);
      return;
    }
    run.status = "verifying";
    task.status = "testing";
    await this.persist(run);
    try {
      const report = await this.deps.verifyTask(task, run);
      run.verificationReports.push(report);
      task.evidence.push({ kind: "check", ref: `report:${run.verificationReports.length - 1}`, detail: `${report.passed} passed/${report.failed} failed/${report.blocked} blocked` });
      const verified = report.verified && count(report.passed) && report.passed > 0 && report.failed === 0 && report.blocked === 0;
      task.status = verified ? task.execution?.partial ? "partial" : "verified" : report.failed > 0 ? "failed" : task.execution?.partial ? "partial" : "blocked";
      task.detail = verified ? task.execution?.detail : `verification: ${report.failed} failed, ${report.blocked} blocked`;
    } catch (err) {
      task.status = "blocked";
      task.detail = `verification failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.persist(run);
    run.status = "executing";
  }

  /**
   * Terminal verdict (mission §17): VERIFIED only when every task verified,
   * at least one real evidence artifact exists, and independent review approved.
   * PARTIAL means useful verified work exists but the run is not complete — never success.
   */
  finalStatus(run: ForgeAaaRun): ForgeAaaFinalStatus {
    if (run.tasks.length === 0) return "FORGEAAA_BLOCKED";
    const verified = run.tasks.filter((t) => t.status === "verified").length;
    const partial = run.tasks.filter((t) => t.status === "partial").length;
    const failed = run.tasks.filter((t) => t.status === "failed").length;
    const hasEvidence = run.manifests.length > 0 || run.verificationReports.some((r) => r.passed > 0);
    if (verified === run.tasks.length && hasEvidence && run.review?.approved === true && run.review.independent === true) return "FORGEAAA_VERIFIED";
    // A task that failed after bounded retries is a gate that failed and was not repaired —
    // verified siblings make the run's evidence partial, not the outcome.
    if (failed > 0) return "FORGEAAA_FAILED";
    if (verified + partial > 0 && hasEvidence) return "FORGEAAA_PARTIAL";
    return "FORGEAAA_BLOCKED";
  }
}

export function createForgeAaaDirector(deps: ForgeAaaDirectorDeps = {}): ForgeAaaDirector {
  return new ForgeAaaDirector(deps);
}

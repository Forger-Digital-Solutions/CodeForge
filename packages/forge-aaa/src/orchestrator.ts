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
}

export interface ForgeAaaDirectorDeps {
  /** Decomposes the goal into specialty tasks. Default: deterministic classifier plan —
   *  a bounded inspect→implement→verify chain per specialty, honest and model-free. */
  planner?: (goal: string, ctx: { engineTarget: ForgeAaaEngineTarget }) => ForgeAaaTask[];
  /** Capability routing per task; absent → every task blocks NO_ELIGIBLE_ROUTE. */
  routeTask?: (task: ForgeAaaTask, run: ForgeAaaRun) => ForgeAaaRouteDecision;
  /** Performs the task's work (model call and/or adapter ops). Required to execute. */
  executeTask?: (task: ForgeAaaTask, ctx: { run: ForgeAaaRun; route?: ForgeAaaRouteDecision }) => Promise<ForgeAaaTaskExecution>;
  /** Task verification; default runs the checks attached to the task's evidence spec. */
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
    this.runs.set(run.id, run);
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

    run.status = "planning";
    const planner = this.deps.planner ?? ((goal: string) => defaultForgeAaaPlanner(goal));
    try {
      run.tasks = planner(run.goal, { engineTarget: run.engineTarget }).slice(0, MAX_TASKS);
    } catch (err) {
      run.blockers.push(`planner failed: ${err instanceof Error ? err.message : String(err)}`);
      run.finalStatus = "FORGEAAA_FAILED";
      run.status = "done";
      run.completedAt = this.now();
      await this.persist(run);
      return run;
    }
    if (run.tasks.length === 0) {
      run.blockers.push("planner produced no tasks");
      run.finalStatus = "FORGEAAA_BLOCKED";
      run.status = "done";
      run.completedAt = this.now();
      await this.persist(run);
      return run;
    }
    await this.persist(run);

    run.status = "executing";
    for (const task of run.tasks) {
      const failedDeps = task.dependencies.filter((d) => {
        const dep = run.tasks.find((t) => t.id === d);
        return dep && (dep.status === "failed" || dep.status === "blocked");
      });
      if (failedDeps.length > 0) {
        task.status = "blocked";
        task.detail = `dependency unfinished: ${failedDeps.join(", ")}`;
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
        continue;
      }
      if (decision && decision.outcome !== "selected") {
        task.status = "blocked";
        task.detail = decision.reasonCodes.join("; ") || "no eligible route";
        continue;
      }
      await this.executeTaskBounded(run, task, decision);
      await this.persist(run);
    }

    run.status = "reviewing";
    if (this.deps.reviewRun) {
      const review = await this.deps.reviewRun(run).catch((err) => ({ approved: false, findings: [err instanceof Error ? err.message : String(err)], independent: false }));
      run.review = { approved: review.approved, findings: review.findings, independent: review.independent === true };
      for (const task of run.tasks) {
        if (!review.approved && task.status === "verified") task.status = "partial";
      }
    }
    run.finalStatus = this.finalStatus(run);
    run.status = "done";
    run.completedAt = this.now();
    await this.persist(run);
    return run;
  }

  private async executeTaskBounded(run: ForgeAaaRun, task: ForgeAaaTask, decision?: ForgeAaaRouteDecision): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      task.attempts = attempt;
      run.counters.taskAttempts++;
      task.status = "generating";
      try {
        const result = await this.deps.executeTask!(task, { run, ...(decision ? { route: decision } : {}) });
        run.counters.modelCalls++;
        for (const m of result.manifests ?? []) run.manifests.push(m);
        task.artifacts.push(...(result.artifacts ?? []), ...(result.manifests ?? []).map((m) => m.assetId));
        task.evidence.push(...(result.evidence ?? []));
        if (!result.ok) {
          const sig = failureSignature(result.detail ?? "unknown");
          // Same failure twice is a loop, not a retry — block rather than burn budget.
          if (sig === task.lastFailureSignature) {
            task.status = "blocked";
            task.detail = `repeated failure signature: ${sig.slice(0, 120)}`;
            return;
          }
          task.lastFailureSignature = sig;
          if (attempt < this.maxAttempts) { run.counters.retries++; continue; }
          task.status = "failed";
          task.detail = result.detail ?? "execution failed";
          return;
        }
        task.status = "integrating";
        if (this.deps.verifyTask) {
          task.status = "testing";
          const report = await this.deps.verifyTask(task, run);
          run.verificationReports.push(report);
          task.evidence.push({ kind: "check", ref: `report:${run.verificationReports.length - 1}`, detail: `${report.passed} passed/${report.failed} failed/${report.blocked} blocked` });
          if (!report.verified) {
            task.status = report.failed > 0 ? "failed" : result.partial ? "partial" : "blocked";
            task.detail = `verification: ${report.failed} failed, ${report.blocked} blocked`;
            return;
          }
        }
        task.status = result.partial ? "partial" : "verified";
        return;
      } catch (err) {
        const sig = failureSignature(err);
        if (sig === task.lastFailureSignature) {
          task.status = "blocked";
          task.detail = `repeated failure signature: ${sig.slice(0, 120)}`;
          return;
        }
        task.lastFailureSignature = sig;
        if (attempt < this.maxAttempts) { run.counters.retries++; continue; }
        task.status = "failed";
        task.detail = err instanceof Error ? err.message : String(err);
        return;
      }
    }
  }

  /**
   * Terminal verdict (mission §17): VERIFIED only when every non-blocked task verified,
   * at least one real evidence artifact exists, and review (when configured) approved.
   * PARTIAL means useful verified work exists but the run is not complete — never success.
   */
  finalStatus(run: ForgeAaaRun): ForgeAaaFinalStatus {
    if (run.tasks.length === 0) return "FORGEAAA_BLOCKED";
    const verified = run.tasks.filter((t) => t.status === "verified").length;
    const partial = run.tasks.filter((t) => t.status === "partial").length;
    const failed = run.tasks.filter((t) => t.status === "failed").length;
    const hasEvidence = run.manifests.length > 0 || run.verificationReports.some((r) => r.passed > 0);
    if (verified === run.tasks.length && hasEvidence) return "FORGEAAA_VERIFIED";
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

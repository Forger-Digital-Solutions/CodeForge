import crypto from "node:crypto";
import type { ContextBundle, PlanStep, RepoMap, TaskIntent, WorkflowPlan } from "./types.js";

function riskForKind(kind: PlanStep["kind"]): PlanStep["risk"] {
  switch (kind) {
    case "read":
    case "inspect":
      return "safe";
    case "edit":
    case "write":
      return "moderate";
    case "command":
      return "moderate";
    case "verify":
      return "safe";
    case "review":
      return "safe";
    default:
      return "moderate";
  }
}

function requiresApprovalForStep(step: PlanStep): boolean {
  if (step.kind === "edit" || step.kind === "write") return true;
  if (step.kind === "command" && step.command) {
    const cmd = step.command.toLowerCase();
    if (/(npm test|npx tsc|typecheck|vitest)/.test(cmd)) return false;
    return true;
  }
  return false;
}

function inferEditTargets(intent: TaskIntent, context: ContextBundle): Array<{ path: string; hint: string }> {
  const targets: Array<{ path: string; hint: string }> = [];
  for (const file of context.primaryFiles.slice(0, 3)) {
    if (file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".tsx") || file.endsWith(".jsx")) {
      targets.push({ path: file, hint: `Update ${file} to address: ${intent.title}` });
    }
  }
  // If no suitable file, suggest creating a new file for implementation tasks
  if (targets.length === 0 && (intent.taskType === "implementation" || intent.taskType === "multi_file_feature")) {
    targets.push({ path: "src/feature.ts", hint: `Create new module for: ${intent.title}` });
  }
  return targets;
}

export function createPlan(
  intent: TaskIntent,
  context: ContextBundle,
  _repoMap: RepoMap,
  taskId: string,
): WorkflowPlan {
  const steps: PlanStep[] = [];
  let idCounter = 1;
  const nextId = () => `s${idCounter++}`;

  // 1. Inspection already done but record as completed step for traceability
  steps.push({
    id: nextId(),
    description: "Repository inspection completed — context built",
    status: "completed",
    kind: "inspect",
    risk: "safe",
    requiresApproval: false,
  });

  // 2. Planning step itself
  steps.push({
    id: nextId(),
    description: `Plan creation for "${intent.title}"`,
    status: "completed",
    kind: "inspect",
    risk: "safe",
    requiresApproval: false,
  });

  // 3. Read primary files (if any)
  for (const file of context.primaryFiles.slice(0, 4)) {
    steps.push({
      id: nextId(),
      description: `Read and analyze ${file}`,
      status: "queued",
      kind: "read",
      targetPath: file,
      risk: "safe",
      requiresApproval: false,
    });
  }

  // 4. Implementation steps
  const editTargets = inferEditTargets(intent, context);
  for (const target of editTargets) {
    steps.push({
      id: nextId(),
      description: target.hint,
      status: "queued",
      kind: "edit",
      targetPath: target.path,
      risk: "moderate",
      requiresApproval: true,
    });
  }

  // 5. Special handling per task type
  if (intent.taskType === "bugfix") {
    steps.push({
      id: nextId(),
      description: "Create checkpoint before fix",
      status: "queued",
      kind: "command",
      command: "git checkpoint",
      risk: "safe",
      requiresApproval: false,
    });
  }

  if (intent.taskType === "testing" || intent.taskType === "bugfix" || intent.taskType === "implementation") {
    steps.push({
      id: nextId(),
      description: "Run verification (tests / typecheck)",
      status: "queued",
      kind: "verify",
      command: "npm test",
      risk: "safe",
      requiresApproval: false,
    });
  }

  // 6. Diff review
  steps.push({
    id: nextId(),
    description: "Review diff and validate changes",
    status: "queued",
    kind: "review",
    risk: "safe",
    requiresApproval: false,
  });

  // Ensure every step has requiresApproval computed correctly
  for (const s of steps) {
    s.requiresApproval = requiresApprovalForStep(s);
    s.risk = riskForKind(s.kind);
    // but edits are moderate regardless
    if (s.kind === "edit") s.risk = "moderate";
  }

  const now = new Date().toISOString();
  const plan: WorkflowPlan = {
    id: `plan-${taskId.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`,
    title: `Plan for ${intent.title}`,
    taskId,
    status: "draft",
    steps,
    createdAt: now,
    updatedAt: now,
  };
  return plan;
}

export function updatePlanStatus(plan: WorkflowPlan, status: WorkflowPlan["status"]): WorkflowPlan {
  return { ...plan, status, updatedAt: new Date().toISOString() };
}

export function updateStepStatus(
  plan: WorkflowPlan,
  stepId: string,
  status: PlanStep["status"],
): WorkflowPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, status } : s)),
    updatedAt: new Date().toISOString(),
  };
}

export function planRequiresApproval(plan: WorkflowPlan): boolean {
  return plan.steps.some((s) => s.requiresApproval && s.status === "queued");
}

export function getNextExecutableStep(plan: WorkflowPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "queued");
}

export function isPlanComplete(plan: WorkflowPlan): boolean {
  return plan.steps.every((s) => s.status === "completed" || s.status === "skipped");
}

export function summarizePlan(plan: WorkflowPlan): string {
  const total = plan.steps.length;
  const completed = plan.steps.filter((s) => s.status === "completed").length;
  const queued = plan.steps.filter((s) => s.status === "queued").length;
  const failed = plan.steps.filter((s) => s.status === "failed").length;
  return `Plan ${plan.id}: ${completed}/${total} completed, ${queued} queued, ${failed} failed — status ${plan.status}`;
}

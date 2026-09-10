import { randomUUID } from "node:crypto";
import type { DesktopWorkerActionRequest, DesktopWorkerActionResult } from "@codeforge/protocol";
import { createDesktopWorkerBridge, createDurableAgentContinuationStore, type DesktopWorkerBridge, type DurableAgentContinuationStore, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";

type HostedWorkflow = Extract<WorkItem, { kind: "hosted_workflow" }>;

export class HostedWorkflowAuthority {
  private readonly workerBridge: DesktopWorkerBridge;
  private readonly continuationStore: DurableAgentContinuationStore;
  constructor(private readonly persistence: ISessionPersistence) {
    this.workerBridge = createDesktopWorkerBridge(persistence);
    this.continuationStore = createDurableAgentContinuationStore(persistence);
  }

  async init(): Promise<void> { await this.persistence.init(); }

  async create(input: { ownerUserId: string; workerId: string; workspaceId: string; task: string }): Promise<HostedWorkflow> {
    const now = new Date().toISOString();
    const id = `hosted-${randomUUID()}`;
    await this.persistence.upsertSession({ id, title: input.task.slice(0, 80), taskTitle: input.task, createdAt: now, updatedAt: now, status: "running" });
    const workflow: HostedWorkflow = { kind: "hosted_workflow", id, sessionId: id, ownerUserId: input.ownerUserId, workerId: input.workerId, workspaceId: input.workspaceId, revision: 0, status: "active", createdAt: now, updatedAt: now };
    await this.persistence.insertIfAbsent(workflow);
    return workflow;
  }

  async get(id: string, ownerUserId: string): Promise<HostedWorkflow | undefined> {
    const item = await this.persistence.getWorkItem(id);
    return item?.kind === "hosted_workflow" && item.ownerUserId === ownerUserId ? item : undefined;
  }

  async list(ownerUserId: string): Promise<HostedWorkflow[]> {
    return (await this.persistence.getWorkItemsByKind("hosted_workflow"))
      .filter((item): item is HostedWorkflow => item.kind === "hosted_workflow" && item.ownerUserId === ownerUserId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async cancel(ownerUserId: string, id: string): Promise<HostedWorkflow> {
    const workflow = await this.get(id, ownerUserId);
    if (!workflow) throw new Error("Hosted workflow is not authorized");
    if (["cancelled", "blocked", "completed"].includes(workflow.status)) return workflow;
    const cancelled: HostedWorkflow = {
      ...workflow,
      revision: workflow.revision + 1,
      status: "cancelled",
      failureReason: "cancelled_by_owner",
      updatedAt: new Date().toISOString(),
    };
    await this.persistence.upsertWorkItem(cancelled);
    await this.continuationStore.cancelForWorkflow(workflow.id);
    return cancelled;
  }

  async dispatch(ownerUserId: string, request: DesktopWorkerActionRequest): Promise<{ duplicate: boolean }> {
    const workflow = await this.get(request.workflowId, ownerUserId);
    if (!workflow || workflow.sessionId !== request.sessionId || workflow.workerId !== request.workerId || workflow.status !== "active") throw new Error("Hosted workflow action is not authorized");
    const dispatched = await this.workerBridge.dispatch(request);
    await this.persistence.upsertWorkItem({ ...workflow, status: "awaiting_worker", updatedAt: new Date().toISOString() });
    return { duplicate: dispatched.duplicate };
  }

  async pending(ownerUserId: string, workerId: string): Promise<DesktopWorkerActionRequest[]> {
    const actions = await this.workerBridge.pending(workerId);
    const allowed: DesktopWorkerActionRequest[] = [];
    for (const action of actions) {
      const workflow = await this.get(action.workflowId, ownerUserId);
      if (workflow?.status === "awaiting_worker") allowed.push(action);
    }
    return allowed;
  }

  async result(ownerUserId: string, result: DesktopWorkerActionResult): Promise<{ duplicate: boolean }> {
    const action = await this.persistence.getWorkItem(result.actionId);
    if (!action || action.kind !== "desktop_worker_action") throw new Error("Unknown hosted worker action");
    const workflow = await this.get(action.workflowId, ownerUserId);
    if (!workflow || workflow.workerId !== result.workerId || (workflow.status !== "awaiting_worker" && !action.result)) throw new Error("Hosted worker result is stale or unauthorized");
    const recorded = await this.workerBridge.recordResult(result);
    await this.continuationStore.markResultAvailable(result.actionId);
    await this.persistence.upsertWorkItem({ ...workflow, status: result.status === "succeeded" ? "active" : "blocked", ...(result.status === "succeeded" ? {} : { failureReason: result.status }), updatedAt: new Date().toISOString() });
    return { duplicate: recorded.duplicate };
  }
}

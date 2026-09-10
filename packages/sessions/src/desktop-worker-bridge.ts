import {
  DesktopWorkerActionRequestSchema,
  DesktopWorkerActionResultSchema,
  type DesktopWorkerActionRequest,
  type DesktopWorkerActionResult,
} from "@codeforge/protocol";
import type { ISessionPersistence } from "./interface.js";
import type { WorkItem } from "./session-state.js";

type WorkerActionRecord = Extract<WorkItem, { kind: "desktop_worker_action" }>;

function toRequest(record: WorkerActionRecord): DesktopWorkerActionRequest {
  return DesktopWorkerActionRequestSchema.parse({
    actionId: record.id,
    workflowId: record.workflowId,
    turnId: record.turnId,
    sessionId: record.sessionId,
    workerId: record.workerId,
    type: record.actionType,
    arguments: record.actionArguments,
    idempotencyKey: record.idempotencyKey,
    expectedWorkspaceRevision: record.expectedWorkspaceRevision,
    cancellationId: record.cancellationId
  });
}

function toResult(record: WorkerActionRecord): DesktopWorkerActionResult | undefined {
  if (record.result === undefined) return undefined;
  return DesktopWorkerActionResultSchema.parse({
    actionId: record.id,
    workerId: record.workerId,
    status: record.state === "succeeded" ? "succeeded" : record.state === "pending" ? "succeeded" : record.state,
    output: record.result,
    ...(record.resultExitCode !== undefined ? { exitCode: record.resultExitCode } : {}),
    ...(record.resultWorkspaceRevision ? { workspaceRevision: record.resultWorkspaceRevision } : {}),
    changedResources: record.resultChangedResources ?? []
  });
}

export class DesktopWorkerBridge {
  constructor(private readonly persistence: ISessionPersistence) {}

  async dispatch(input: DesktopWorkerActionRequest): Promise<{ request: DesktopWorkerActionRequest; duplicate: boolean }> {
    const request = DesktopWorkerActionRequestSchema.parse(input);
    const now = new Date().toISOString();
    const record: WorkerActionRecord = {
      kind: "desktop_worker_action",
      id: request.actionId,
      sessionId: request.sessionId,
      workflowId: request.workflowId,
      turnId: request.turnId,
      workerId: request.workerId,
      actionType: request.type,
      actionArguments: request.arguments,
      idempotencyKey: request.idempotencyKey,
      ...(request.expectedWorkspaceRevision ? { expectedWorkspaceRevision: request.expectedWorkspaceRevision } : {}),
      ...(request.cancellationId ? { cancellationId: request.cancellationId } : {}),
      state: "pending",
      createdAt: now,
      updatedAt: now
    };
    const inserted = await this.persistence.insertIfAbsent(record);
    if (inserted) return { request, duplicate: false };
    const existing = await this.persistence.getWorkItem(request.actionId);
    if (!existing || existing.kind !== "desktop_worker_action") throw new Error("Worker action identity conflicts with a different durable record");
    if (existing.workerId !== request.workerId || existing.idempotencyKey !== request.idempotencyKey) throw new Error("Worker action identity conflicts with a different authenticated request");
    return { request: toRequest(existing), duplicate: true };
  }

  async pending(workerId: string, sessionId?: string): Promise<DesktopWorkerActionRequest[]> {
    return (await this.persistence.getWorkItemsByKind("desktop_worker_action"))
      .filter((record): record is WorkerActionRecord => record.kind === "desktop_worker_action")
      .filter((record) => record.state === "pending" && record.workerId === workerId && (!sessionId || record.sessionId === sessionId))
      .map(toRequest);
  }

  async recordResult(input: DesktopWorkerActionResult): Promise<{ result: DesktopWorkerActionResult; duplicate: boolean }> {
    const result = DesktopWorkerActionResultSchema.parse(input);
    const item = await this.persistence.getWorkItem(result.actionId);
    if (!item || item.kind !== "desktop_worker_action") throw new Error("Unknown desktop worker action");
    if (item.workerId !== result.workerId) throw new Error("Desktop worker is not authorized for this action");
    const prior = toResult(item);
    if (prior) return { result: prior, duplicate: true };
    const next: WorkerActionRecord = {
      ...item,
      state: result.status === "succeeded" ? "succeeded" : result.status,
      result: result.output,
      ...(result.exitCode !== undefined ? { resultExitCode: result.exitCode } : {}),
      ...(result.workspaceRevision ? { resultWorkspaceRevision: result.workspaceRevision } : {}),
      resultChangedResources: result.changedResources,
      updatedAt: new Date().toISOString()
    };
    await this.persistence.upsertWorkItem(next);
    return { result, duplicate: false };
  }
}

export class DesktopWorkerExecutor {
  constructor(private readonly persistence: ISessionPersistence) {}
  async execute(request: DesktopWorkerActionRequest, handler: (action: DesktopWorkerActionRequest) => Promise<Omit<DesktopWorkerActionResult, "actionId" | "workerId">>): Promise<DesktopWorkerActionResult> {
    const bridge = new DesktopWorkerBridge(this.persistence);
    await bridge.dispatch(request);
    const record = await this.persistence.getWorkItem(request.actionId);
    if (record?.kind === "desktop_worker_action") {
      const prior = toResult(record);
      if (prior) return prior;
    }
    return (await bridge.recordResult({ ...(await handler(request)), actionId: request.actionId, workerId: request.workerId })).result;
  }
}

export const createDesktopWorkerBridge = (persistence: ISessionPersistence): DesktopWorkerBridge => new DesktopWorkerBridge(persistence);

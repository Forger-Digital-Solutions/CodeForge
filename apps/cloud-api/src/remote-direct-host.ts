import { randomUUID } from "node:crypto";
import { FreeFabric, type EightBitRouteHealthAuthority, type EightBitRole } from "@codeforge/eight-bit";
import type { FreeCloudService } from "@codeforge/model-registry";
import type { ChatRequest, ProviderExecutionContext } from "@codeforge/providers";
import type { RouteDataContext } from "@codeforge/forge-zero";
import { createRemoteDirectFabricAdmission, RemoteDirectProviderAdapter, type RemoteDirectBinding, type ServerOptions } from "@codeforge/server";
import { CodeForgeCloudServer, type CodeForgeCloudServerConfig } from "./server.js";

const roleMap: Record<string, { fabric: string; health: EightBitRole }> = {
  CODER: { fabric: "PRIMARY_CODING_AGENT", health: "CODER" },
  EXPLORER: { fabric: "SUBAGENT", health: "EXPLORER" },
  TOOL_AGENT: { fabric: "SUBAGENT", health: "TOOL_AGENT" },
  PLANNER: { fabric: "PLANNER", health: "PLANNER" },
  REVIEWER: { fabric: "REVIEWER", health: "REVIEWER" },
};

export function createRemoteDirectHost(options: {
  cloud: Omit<CodeForgeCloudServerConfig, "remoteDirectAdmission" | "remoteDirectScopeAuthorization" | "remoteDirectSubmit">;
  freeCloud: FreeCloudService;
  freeCloudForAccount?: (accountId: string) => FreeCloudService;
  health: EightBitRouteHealthAuthority;
  privacyForWorkspace: (accountId: string, workspaceId: string) => RouteDataContext;
}): { cloud: CodeForgeCloudServer; provider: RemoteDirectProviderAdapter; runtimeOptions: Pick<ServerOptions, "freeCloud" | "routeHealth" | "remoteDirect"> } {
  const sourceFor = options.freeCloudForAccount ?? (() => options.freeCloud);
  let cloud: CodeForgeCloudServer;
  const authorized = async (binding: Pick<RemoteDirectBinding, "accountId" | "workspaceId" | "deviceId">): Promise<boolean> => {
    return (await cloud.hostedWorkflowAuthority.list(binding.accountId)).some((workflow) => workflow.workerId === binding.deviceId
      && workflow.workspaceId === binding.workspaceId && ["active", "awaiting_worker"].includes(workflow.status));
  };
  const admission = async (binding: RemoteDirectBinding, request: ChatRequest): Promise<boolean> => {
    const source = sourceFor(binding.accountId);
    const fabric = new FreeFabric({ managedRoutes: () => [], userSources: [source], health: options.health });
    const workflow = (await cloud.hostedWorkflowAuthority.list(binding.accountId)).find((item) => item.id === binding.runId);
    if (!workflow || workflow.workerId !== binding.deviceId || workflow.workspaceId !== binding.workspaceId) return false;
    const stored = workflow.execution?.remoteDirectDataContext;
    const dataContext = stored && typeof stored === "object" && "dataClass" in stored && stored.dataClass === "PUBLIC_CODE"
      && "userConsented" in stored && stored.userConsented === true ? { dataClass: "PUBLIC_CODE" as const, userConsented: true }
      : options.privacyForWorkspace(binding.accountId, binding.workspaceId);
    return createRemoteDirectFabricAdmission({ fabric,
    authorizeScope: async (binding) => {
      const role = roleMap[binding.role ?? "CODER"];
      const receipt = source.getReceipt("kilo-free-direct", source.routesForUser(binding.accountId).find((route) => route.routeId === binding.routeId)?.modelId ?? "");
      return !!role && receipt?.roleResults[role.health]?.status === "QUALIFIED" && await authorized(binding);
    },
    context: (binding) => ({ role: roleMap[binding.role ?? "CODER"]?.fabric ?? "DENIED_ROLE",
      healthRole: roleMap[binding.role ?? "CODER"]?.health, userIdentities: source.capacityIdentitiesFor(binding.accountId), dataContext }),
    })(binding, request);
  };
  cloud = new CodeForgeCloudServer({ ...options.cloud, remoteDirectAdmission: admission,
    remoteDirectSubmit: async (accountId, workflowId, request, role) => {
      const workflow = await cloud.hostedWorkflowAuthority.get(workflowId, accountId);
      if (!workflow || !["active", "awaiting_worker"].includes(workflow.status)) throw new Error("REMOTE_WORKFLOW_DENIED");
      const route = sourceFor(accountId).routesForUser(accountId).find((candidate) => candidate.providerId === "kilo-free-direct"
        && candidate.modelId === request.model && candidate.egressMode === "CLIENT_DIRECT");
      if (!route) throw new Error("REMOTE_ROUTE_DENIED");
      return cloud.remoteDirectTransport.enqueue({ accountId, deviceId: workflow.workerId, workspaceId: workflow.workspaceId,
        runId: workflow.id, routeId: route.routeId, quotaDomainId: route.capacityPoolId, role }, request, request.dispatchId ?? randomUUID());
    },
    remoteDirectScopeAuthorization: (principal, scope) => authorized({ accountId: principal.accountId, ...scope }) });
  const bindingForContext = async (context: ProviderExecutionContext, request: ChatRequest): Promise<RemoteDirectBinding | undefined> => {
    if (!context.userId) return;
    const workflows = await cloud.hostedWorkflowAuthority.list(context.userId);
    const workspaceId = typeof context.metadata?.workspaceId === "string" ? context.metadata.workspaceId
      : typeof context.workspaceId === "string" ? context.workspaceId : undefined;
    const workflow = workflows.find((item) => ["active", "awaiting_worker"].includes(item.status)
      && (workspaceId ? item.workspaceId === workspaceId : item.sessionId === context.sessionId));
    if (!workflow) return;
    const route = sourceFor(context.userId).routesForUser(context.userId).find((candidate) => candidate.providerId === "kilo-free-direct"
      && candidate.modelId === request.model && candidate.egressMode === "CLIENT_DIRECT");
    if (!route) return;
    const role = typeof context.metadata?.role === "string" ? context.metadata.role : typeof context.role === "string" ? context.role : "CODER";
    return { accountId: context.userId, deviceId: workflow.workerId, workspaceId: workflow.workspaceId,
      runId: workflow.id, routeId: route.routeId, quotaDomainId: route.capacityPoolId, role };
  };
  const provider = new RemoteDirectProviderAdapter(cloud.remoteDirectTransport, bindingForContext);
  return { cloud, provider, runtimeOptions: { freeCloud: options.freeCloud, routeHealth: options.health,
    remoteDirect: { transport: cloud.remoteDirectTransport, bindingForContext } } };
}

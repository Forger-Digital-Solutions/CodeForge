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
  cloud: Omit<CodeForgeCloudServerConfig, "remoteDirectAdmission" | "remoteDirectScopeAuthorization">;
  freeCloud: FreeCloudService;
  health: EightBitRouteHealthAuthority;
  privacyForWorkspace: (accountId: string, workspaceId: string) => RouteDataContext;
}): { cloud: CodeForgeCloudServer; provider: RemoteDirectProviderAdapter; runtimeOptions: Pick<ServerOptions, "freeCloud" | "routeHealth" | "remoteDirect"> } {
  const fabric = new FreeFabric({ managedRoutes: () => [], userSources: [options.freeCloud], health: options.health });
  let cloud: CodeForgeCloudServer;
  const authorized = async (binding: Pick<RemoteDirectBinding, "accountId" | "workspaceId" | "deviceId">): Promise<boolean> => {
    return (await cloud.hostedWorkflowAuthority.list(binding.accountId)).some((workflow) => workflow.workerId === binding.deviceId
      && workflow.workspaceId === binding.workspaceId && ["active", "awaiting_worker"].includes(workflow.status));
  };
  const admission = createRemoteDirectFabricAdmission({ fabric,
    authorizeScope: async (binding) => {
      const role = roleMap[binding.role ?? "CODER"];
      const receipt = options.freeCloud.getReceipt("kilo-free-direct", options.freeCloud.routesForUser(binding.accountId).find((route) => route.routeId === binding.routeId)?.modelId ?? "");
      return !!role && receipt?.roleResults[role.health]?.status === "QUALIFIED" && await authorized(binding);
    },
    context: (binding) => ({ role: roleMap[binding.role ?? "CODER"]?.fabric ?? "DENIED_ROLE",
      healthRole: roleMap[binding.role ?? "CODER"]?.health, userIdentities: options.freeCloud.capacityIdentitiesFor(binding.accountId),
      dataContext: options.privacyForWorkspace(binding.accountId, binding.workspaceId) }),
  });
  cloud = new CodeForgeCloudServer({ ...options.cloud, remoteDirectAdmission: admission,
    remoteDirectScopeAuthorization: (principal, scope) => authorized({ accountId: principal.accountId, ...scope }) });
  const bindingForContext = async (context: ProviderExecutionContext, request: ChatRequest): Promise<RemoteDirectBinding | undefined> => {
    if (!context.userId) return;
    const workflows = await cloud.hostedWorkflowAuthority.list(context.userId);
    const workspaceId = typeof context.metadata?.workspaceId === "string" ? context.metadata.workspaceId
      : typeof context.workspaceId === "string" ? context.workspaceId : undefined;
    const workflow = workflows.find((item) => ["active", "awaiting_worker"].includes(item.status)
      && (workspaceId ? item.workspaceId === workspaceId : item.sessionId === context.sessionId));
    if (!workflow) return;
    const route = options.freeCloud.routesForUser(context.userId).find((candidate) => candidate.providerId === "kilo-free-direct"
      && candidate.modelId === request.model && candidate.egressMode === "CLIENT_DIRECT");
    if (!route) return;
    const role = typeof context.metadata?.role === "string" ? context.metadata.role : typeof context.role === "string" ? context.role : "CODER";
    const runId = typeof context.metadata?.runId === "string" ? context.metadata.runId : typeof context.runId === "string" ? context.runId
      : typeof context.turnId === "string" ? context.turnId : workflow.id;
    return { accountId: context.userId, deviceId: workflow.workerId, workspaceId: workflow.workspaceId,
      runId, routeId: route.routeId, quotaDomainId: route.capacityPoolId, role };
  };
  const provider = new RemoteDirectProviderAdapter(cloud.remoteDirectTransport, bindingForContext);
  return { cloud, provider, runtimeOptions: { freeCloud: options.freeCloud, routeHealth: options.health,
    remoteDirect: { transport: cloud.remoteDirectTransport, bindingForContext } } };
}

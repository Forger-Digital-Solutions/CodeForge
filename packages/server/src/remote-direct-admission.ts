import { FreeFabric, type FabricRequest } from "@codeforge/eight-bit";
import type { ChatRequest } from "@codeforge/providers";
import { digestRemoteDirectRequest } from "./remote-client-direct.js";
import type { RemoteDirectBinding } from "./remote-direct-transport.js";

export function createRemoteDirectFabricAdmission(options: {
  fabric: FreeFabric;
  authorizeScope: (binding: RemoteDirectBinding) => boolean | Promise<boolean>;
  context: (binding: RemoteDirectBinding) => Pick<FabricRequest, "userIdentities" | "dataContext" | "role" | "healthRole">;
}): (binding: RemoteDirectBinding, request: ChatRequest) => Promise<boolean> {
  return async (binding, request) => {
    if (!(await options.authorizeScope(binding))) return false;
    const decision = options.fabric.decide({
      ...options.context(binding), userId: binding.accountId,
      requestId: `remote-check-${digestRemoteDirectRequest([binding, request])}`,
      routeAdmission: (providerId, modelId) => providerId === "kilo-free-direct" && modelId === request.model,
      demand: { requests: 1, estimatedPromptTokens: Math.ceil(JSON.stringify(request).length / 4), outputTokens: request.maxTokens ?? 4096 },
      leaseMs: 120_000,
    });
    const selected = decision.selected;
    if (selected?.reservationId) options.fabric.release(selected.reservationId);
    return decision.outcome === "ADMITTED" && selected?.routeId === binding.routeId
      && selected.capacityPoolId === binding.quotaDomainId && selected.egressMode === "CLIENT_DIRECT";
  };
}

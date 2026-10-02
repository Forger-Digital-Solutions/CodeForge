# Hosted client-direct Free inference

R63 adds the hosted queue, authenticated HTTP transport, runtime adapter, and client worker. The published Cloud endpoint must be updated before this path can be used. The production endpoint checked during R63 returned HTTP 404 for `/v1/remote-direct/sessions`.

Two trusted host integrations are required. The Cloud API needs an admission supplier over current qualified quota-domain records. The runtime needs a binding resolver that chooses the owning account, enrolled device, workspace, run, route, and quota domain. Request bodies cannot install either integration. Omitting Cloud admission denies every assignment.

The host can compose these interfaces with an existing `FreeCloudService`:

```ts
import { FreeFabric } from "@codeforge/eight-bit";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { createServer, createRemoteDirectFabricAdmission } from "@codeforge/server";

const guardFabric = new FreeFabric({
  managedRoutes: () => freeCloud.productionCapacityRoutes(),
  managedPools: () => freeCloud.capacityPools(),
  userSources: [{
    routesForUser: (userId) => freeCloud.routesForUser(userId),
    poolsForUser: (userId) => freeCloud.poolsForUser(userId),
  }],
  health: routeHealth,
});

const cloud = new CodeForgeCloudServer({
  ...validatedCloudConfiguration,
  remoteDirectAdmission: createRemoteDirectFabricAdmission({
    fabric: guardFabric,
    authorizeScope: (binding) => enrolledDevices.ownsExactScope(binding),
    context: (binding) => ({
      userIdentities: freeCloud.capacityIdentitiesFor(binding.accountId),
      dataContext: trustedPrivacyFor(binding.accountId, binding.workspaceId),
      role: "PRIMARY_CODING_AGENT",
      healthRole: "CODER",
    }),
  }),
});

const runtime = createServer({
  ...validatedRuntimeConfiguration,
  freeCloud,
  routeHealth,
  remoteDirect: {
    transport: cloud.remoteDirectTransport,
    bindingForContext: (context, request) => enrolledDevices.resolveAdmittedBinding(context, request),
  },
});
```

The configuration, `freeCloud`, privacy choices, and device registry above are existing trusted host authorities, not client declarations. A host must supply them from real authenticated enrollment and qualified domain receipts. The runtime's normal Fabric reservation and completion authorities remain required. The separate guard Fabric checks current policy without creating a second long-lived accounting reservation for the same runtime dispatch.

The binding resolver must reject an unknown owner or unregistered workspace/device. It must use the admitted route and quota-domain identifiers, and match `context.userId`. Interactive dispatch carries session, turn, and workspace context directly. Role dispatch supplies `role`, `runId`, and `workspaceId` in `context.metadata`. Each role must use its current qualification; a fixed coding admission context must not authorize unqualified Reviewer or Explorer work.

After building and publishing that host, start the client worker in the owning user's environment:

```powershell
node scripts/cloud/remote-direct-worker.mjs --cloud-url https://your-published-host --device-id exact-enrolled-device --workspace-id exact-authorized-workspace --quota-domain-id exact-admitted-domain
```

The worker reads `CODEFORGE_WORKER_ACCESS_TOKEN`, a short-lived CodeForge identity token from the authorized account. It does not read upstream provider API keys. Token values must remain in the trusted process environment or a trusted token resolver; do not place them in command arguments, renderer state, logs, or evidence. The `RemoteDirectHttpClient` API also accepts a token resolver for integration with the desktop's encrypted identity storage.

The worker performs anonymous Kilo inference through a fixed HTTPS endpoint and accepts only its pinned quota domain. It returns proposed tool calls; the authoritative runtime executes tools and applies its existing verification and completion gates. The transport job's `settled` state is an inference receipt, never a completed engineering task.

An access-token session rotation requires a new transport session. The worker reconnects with bounded retries, and interrupted leases recover with a new assignment nonce. Recovery stops after three assignment generations by default. Cancellation reaches active inference through the authenticated heartbeat. Session MAC keys persist in encrypted envelopes and are never returned by status routes.

For deployed acceptance, capture authenticated bootstrap, assignment, acknowledgement, heartbeat, result, feedback, cancellation and disconnect recovery against the published release. A socket test with mocked upstream inference verifies transport and runtime integration; it cannot replace live domain provenance, current role qualification, live coding, Reviewer, ForgeVerify, or completion evidence.

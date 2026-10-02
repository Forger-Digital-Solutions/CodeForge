import { RemoteDirectHttpClient } from "../../packages/server/dist/index.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cloudUrl = argument("--cloud-url");
const deviceId = argument("--device-id");
const workspaceId = argument("--workspace-id");
const domainId = argument("--quota-domain-id");
if (!cloudUrl || !deviceId || !workspaceId || !domainId || !process.env.CODEFORGE_WORKER_ACCESS_TOKEN) {
  console.error("Requires --cloud-url, --device-id, --workspace-id, --quota-domain-id and CODEFORGE_WORKER_ACCESS_TOKEN (CodeForge identity token).");
  process.exitCode = 1;
} else {
  const client = new RemoteDirectHttpClient({ cloudUrl, deviceId, workspaceId,
    getAccessToken: () => process.env.CODEFORGE_WORKER_ACCESS_TOKEN,
    routeAllowed: (assignment) => assignment.quotaDomainId === domainId && assignment.workspaceId === workspaceId && assignment.deviceId === deviceId });
  const controller = new AbortController();
  process.once("SIGINT", () => { controller.abort(); });
  process.once("SIGTERM", () => { controller.abort(); });
  try {
    await client.connect();
    console.log("Authenticated client-direct worker connected.");
    await client.run(controller.signal);
  } catch (error) {
    console.error(error instanceof Error && /^REMOTE_[A-Z_0-9]+$/.test(error.message) ? error.message : "REMOTE_WORKER_FAILED");
    process.exitCode = 1;
  } finally { await client.disconnect().catch(() => undefined); }
}

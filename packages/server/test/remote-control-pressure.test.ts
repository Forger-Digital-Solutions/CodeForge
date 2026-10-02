import { afterEach, expect, it, vi } from "vitest";
import { RemoteDirectCloudProviderAdapter } from "../src/remote-direct-cloud-provider.js";
import { RemoteDirectHttpClient } from "../src/remote-direct-client.js";

afterEach(() => vi.useRealTimers());

it("keeps pending inference and an idle worker within the shared 120-request production minute", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const paths: string[] = [];
  let limited = 0;
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (paths.length > 120) { limited++; return Response.json({}, { status: 429 }); }
    if (path === "/v1/remote-direct/sessions") return Response.json({
      identity: { accountId: "fixture-owner", deviceId: "fixture-device", sessionId: "fixture-session", workspaceId: "fixture-workspace" },
      secret: Buffer.alloc(32, 1).toString("base64url"), expiresAt: new Date(3_600_000).toISOString(),
    }, { status: 201 });
    if (path.endsWith("/poll")) return Response.json([]);
    if (path.endsWith("/heartbeat")) return Response.json({ cancelledJobIds: [] });
    if (path === "/v1/workflows/fixture-workflow/remote-direct") return Response.json({ jobId: "fixture-job" }, { status: 201 });
    if (path.endsWith("/fixture-job")) return Response.json({ state: "queued" });
    return Response.json({});
  };
  const abort = new AbortController();
  const worker = new RemoteDirectHttpClient({ cloudUrl: "http://127.0.0.1", getAccessToken: () => "fixture-token",
    deviceId: "fixture-device", workspaceId: "fixture-workspace", routeAllowed: () => true, cloudFetch: fetcher });
  const consumer = new RemoteDirectCloudProviderAdapter({ cloudUrl: "http://127.0.0.1", getAccessToken: () => "fixture-token",
    workflowId: "fixture-workflow", ownerUserId: "fixture-owner", fetcher });
  let consumerSettled = false;
  let workerSettled = false;
  const consume = (async () => {
    for await (const _event of consumer.streamChatWithContext({ model: "kilo-auto/free", messages: [{ role: "user", content: "Public fixture" }] },
      { userId: "fixture-owner", role: "CODER" }, abort.signal)) { /* Queued work must not emit a result. */ }
  })().finally(() => { consumerSettled = true; });
  const run = worker.run(abort.signal).finally(() => { workerSettled = true; });
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consumerSettled).toBe(false);
    expect(workerSettled).toBe(false);
    expect(limited).toBe(0);
    expect(paths.length).toBeLessThanOrEqual(110);
    expect(paths.filter((path) => path.endsWith("/heartbeat")).length).toBeGreaterThanOrEqual(12);
    expect(paths.filter((path) => path.endsWith("/poll")).length).toBeGreaterThanOrEqual(60);
  } finally {
    abort.abort();
    await Promise.allSettled([consume, run]);
  }
});

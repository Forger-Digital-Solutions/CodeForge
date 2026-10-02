import { z } from "zod";
import { ChatResponseSchema } from "@codeforge/providers";
import type { RemoteDirectTransport, RemoteDirectPrincipal, SignedRemoteDirectFeedback } from "@codeforge/server";

const id = z.string().min(1).max(256);
const mac = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const acknowledgement = z.object({ acknowledgement: z.object({ requestId: id, sessionId: id, nonce: id }).strict(), mac }).strict();
const result = z.object({ result: z.object({ requestId: id, nonce: id, response: ChatResponseSchema,
  toolExecutionState: z.literal("PROPOSED_ONLY") }).strict(), mac }).strict();
const feedback = z.object({ feedback: z.object({ requestId: id, runId: id, routeId: id, quotaDomainId: id,
  provider: z.literal("kilo-free-direct"), physicalModel: id,
  status: z.enum(["success", "rate_limited", "provider_error", "cancelled", "client_offline"]),
  latencyMs: z.number().nonnegative(), httpClass: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(5)]),
  rateLimitResetAt: z.string().datetime().optional(), inputTokens: z.number().int().nonnegative().optional(),
  providerErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  outputTokens: z.number().int().nonnegative().optional(), toolCallCount: z.number().int().nonnegative(),
  terminationReason: z.enum(["completed", "provider_rate_limit", "provider_error", "cancelled", "client_offline"]),
  timestamp: z.string().datetime(), accountId: id, deviceId: id, sessionId: id, workspaceId: id, nonce: id }).strict(), mac }).strict();

export async function handleRemoteDirectHttp(input: {
  path: string; method: string; principal: RemoteDirectPrincipal; transport: RemoteDirectTransport;
  read: () => Promise<unknown>; send: (status: number, body: unknown) => void;
}): Promise<void> {
  const { path, method, principal, transport, read, send } = input;
  try {
    if (path === "/v1/remote-direct/sessions" && method === "POST") {
      const scope = z.object({ deviceId: id, workspaceId: id }).strict().parse(await read());
      send(201, await transport.bootstrap(principal, scope));
      return;
    }
    const session = path.match(/^\/v1\/remote-direct\/sessions\/([^/]+)\/(poll|heartbeat|revoke)$/);
    if (session && method === "POST") {
      if (session[2] === "poll") send(200, await transport.poll(principal, session[1]!));
      else if (session[2] === "heartbeat") send(200, await transport.heartbeat(principal, session[1]!));
      else { await transport.revoke(principal, session[1]!); send(200, { revoked: true }); }
      return;
    }
    const job = path.match(/^\/v1\/remote-direct\/sessions\/([^/]+)\/jobs\/([^/]+)\/(ack|result|feedback)$/);
    if (job && method === "POST") {
      const body = await read();
      if (job[3] === "ack") await transport.acknowledge(principal, job[1]!, job[2]!, acknowledgement.parse(body));
      else if (job[3] === "result") await transport.result(principal, job[1]!, job[2]!, result.parse(body));
      else await transport.feedback(principal, job[1]!, job[2]!, feedback.parse(body) as SignedRemoteDirectFeedback);
      send(200, { accepted: true });
      return;
    }
    const cancel = path.match(/^\/v1\/remote-direct\/jobs\/([^/]+)\/cancel$/);
    if (cancel && method === "POST") { await transport.cancel(principal.accountId, cancel[1]!); send(200, { cancelled: true }); return; }
    send(404, { error: "Remote transport route not found" });
  } catch (error) {
    const message = error instanceof z.ZodError ? "REMOTE_BODY_INVALID"
      : error instanceof Error && /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_REQUEST_DENIED";
    send(error instanceof z.ZodError ? 400 : 409, { error: message });
  }
}

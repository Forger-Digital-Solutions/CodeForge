import type http from "node:http";
import { z } from "zod";
import { ChatRequestSchema } from "@codeforge/providers";
import type { SponsorOperatorService } from "./sponsor-operator-service.js";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const enrollment = z.object({ operatorId: id }).strict();
const key = z.object({ keyId: id, publicKeyPem: z.string().min(1).max(4096), validFrom: z.string().datetime(), validUntil: z.string().datetime(), rotateKeyId: id.optional() }).strict();
const execution = z.object({ offerId: id, requestId: id, role: z.enum(["CODER", "EXPLORER", "PLANNER", "REVIEWER", "TESTER", "LEAD"]), request: ChatRequestSchema }).strict();
export interface SponsorHttpContext {
  service?: SponsorOperatorService;
  authenticate(req: http.IncomingMessage): Promise<string>;
  readJson<T>(req: http.IncomingMessage, schema: z.ZodSchema<T>): Promise<T>;
  sendJson(res: http.ServerResponse, status: number, body: unknown): void;
}

export async function handleSponsorOperatorHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL, context: SponsorHttpContext): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/free-capacity/sponsor/")) return false;
  const userId = await context.authenticate(req);
  if (!context.service) { context.sendJson(res, 503, { error: "SPONSOR_OPERATOR_NOT_CONFIGURED" }); return true; }
  const service = context.service;
  try {
    const operation = url.pathname.slice("/v1/free-capacity/sponsor/".length);
    if (operation === "operators" && req.method === "POST") {
      const body = await context.readJson(req, enrollment);
      context.sendJson(res, 201, await service.enroll(userId, body.operatorId));
    } else if (operation === "status" && req.method === "GET") {
      context.sendJson(res, 200, await service.status(userId));
    } else if (operation === "manifests" && req.method === "POST") {
      const body = await context.readJson(req, z.unknown());
      context.sendJson(res, 202, await service.submitManifest(userId, body));
    } else if (operation === "execute" && req.method === "POST") {
      const body = await context.readJson(req, execution);
      context.sendJson(res, 202, await service.enqueue(userId, body.offerId, body.requestId, body.role, body.request));
    } else {
      const keys = operation.match(/^operators\/([A-Za-z0-9_.:-]+)\/keys$/);
      const revoke = operation.match(/^operators\/([A-Za-z0-9_.:-]+)(?:\/keys\/([A-Za-z0-9_.:-]+))?\/revoke$/);
      const offer = operation.match(/^offers\/([A-Za-z0-9_.:-]+)\/(verify|revoke)$/);
      const result = operation.match(/^results\/([A-Za-z0-9_.:-]+)$/);
      if (keys && req.method === "POST") {
        const { rotateKeyId, ...body } = await context.readJson(req, key);
        context.sendJson(res, 201, await service.addKey(userId, keys[1]!, body, rotateKeyId));
      } else if (revoke && req.method === "POST") {
        await service.revoke(userId, revoke[1]!, revoke[2]); context.sendJson(res, 200, { state: "REVOKED" });
      } else if (offer && req.method === "POST") {
        if (offer[2] === "verify") context.sendJson(res, 200, await service.verifyOffer(userId, offer[1]!));
        else { await service.revokeOffer(userId, offer[1]!); context.sendJson(res, 200, { state: "REVOKED" }); }
      } else if (result && req.method === "GET") {
        context.sendJson(res, 200, await service.jobStatus(userId, result[1]!));
      } else context.sendJson(res, 404, { error: "SPONSOR_OPERATION_NOT_FOUND" });
    }
  } catch (error) {
    const message = error instanceof Error && /^SPONSOR_[A-Z_]+$/.test(error.message) ? error.message : "SPONSOR_REQUEST_INVALID";
    context.sendJson(res, /NOT_AUTHORIZED|SCOPE_DENIED/.test(message) ? 403 : /NOT_FOUND/.test(message) ? 404 : /LIMIT|EXHAUSTED/.test(message) ? 429 : 400, { error: message });
  }
  return true;
}

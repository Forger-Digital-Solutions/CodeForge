// R41: run the existing frozen role-qualification protocol on one R40-verified
// Mistral free-allowance route. This is evidence collection, not new scoring.
import { readFile, writeFile } from "node:fs/promises";
import { createMistralAdapter } from "../packages/providers/dist/index.js";
import { runRoleAwareQualification } from "../packages/eight-bit/dist/index.js";

const out = process.argv[2] ?? "docs/evidence/r41-role-intelligence/R41-MISTRAL-QUALIFICATION-RAW.json";
const preflight = JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-LIVE-PREFLIGHT.json", "utf8"));
const r40 = JSON.parse(await readFile("docs/evidence/r40-free-intelligence/R40-LIVE-FREE-INVENTORY.json", "utf8"));
const providerId = "mistral";
const modelId = "codestral-latest";
if (preflight.providers.find((p) => p.provider === providerId)?.httpStatus !== 200
  || !preflight.providers.find((p) => p.provider === providerId)?.models.some((m) => m.id === modelId)
  || !r40.byProvider?.mistral?.includes(modelId)) {
  throw new Error("Fail closed: Mistral route is not in both current catalog and R40 verified-free inventory.");
}
const adapter = createMistralAdapter({ timeoutMs: 45_000 });
let requests = 0;
let attempted = 0;
let halt = false;
const usage = [];
const bounded = {
  providerId,
  streamChat: async function* (request, signal) {
    attempted++;
    if (halt || requests >= 28) throw new Error("R41_BOUND: request cap reached; no more calls");
    requests++;
    const receipt = { maxTokens: request.maxTokens ?? null, inputTokens: null, outputTokens: null, reasoningTokens: null, finishReason: null, errorCode: null };
    usage.push(receipt);
    for await (const event of adapter.streamChat(request, signal)) {
      if (event.type === "usage") {
        receipt.inputTokens = event.usage.inputTokens;
        receipt.outputTokens = event.usage.outputTokens;
        receipt.reasoningTokens = event.usage.reasoningTokens ?? null;
      }
      if (event.type === "finish") receipt.finishReason = event.finishReason;
      if (event.type === "error") {
        receipt.errorCode = event.code;
        if (event.status === 402 || event.status === 429 || event.status === 403) halt = true;
      }
      yield event;
    }
  },
};
const model = {
  providerId, modelId, displayName: modelId, freeStatus: "verified_free",
  capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
  costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "R40 verified-free inventory; R41 live catalog match" },
  isRemote: true, isCloudHosted: true,
};
const data = { at: new Date().toISOString(), providerId, modelId, source: "R27 frozen role qualification; R40 free inventory + R41 catalog", maxRequests: 28, requests, attempted, usage, receipt: null, errorCode: null };
try {
  const receipt = await runRoleAwareQualification(model, bounded, { timeoutMs: 45_000 });
  data.receipt = {
    suiteVersion: receipt.suiteVersion,
    qualificationState: receipt.qualificationState,
    hardFailureRoles: receipt.hardFailureRoles,
    roleResults: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, r]) => [role, {
      status: r.status, overallScore: r.overallScore, startedAt: r.startedAt, completedAt: r.completedAt,
      cases: r.testCases.map(({ caseId, passed, hardFailure, retries, latencyMs, details, error }) => ({
        caseId, passed, hardFailure, retries, latencyMs, details,
        ...(error ? { errorKind: /429|rate.?limit/i.test(error) ? "RATE_LIMITED" : /402|payment/i.test(error) ? "PAYMENT_REQUIRED" : "OTHER" } : {}),
      })),
    }])),
  };
} catch (error) {
  data.errorCode = error?.code ?? (String(error?.message).includes("R41_BOUND") ? "REQUEST_BOUND" : "RUNNER_ERROR");
}
data.requests = requests;
data.attempted = attempted;
await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(JSON.stringify({ providerId, modelId, requests, state: data.receipt?.qualificationState, roles: Object.fromEntries(Object.entries(data.receipt?.roleResults ?? {}).map(([role, value]) => [role, value.status])), errorCode: data.errorCode }));

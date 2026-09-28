#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createProviderAdapterById } from "../../packages/providers/dist/index.js";
import { runRoleAwareQualification } from "../../packages/eight-bit/dist/index.js";

const inventoryPath = "docs/evidence/r53-role-intelligence/R53-FREE-ROUTE-INVENTORY.json";
const outputPath = "docs/evidence/r54-eight-bit-intelligence/R54-GROQ-REVIEWER-QUALIFICATION.json";
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const providerId = "groq";
const modelIds = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
const maxRequestsPerModel = 28;
const rows = [];

for (const modelId of modelIds) {
  const route = inventory.routes.find((entry) =>
    entry.providerId === providerId
    && entry.modelId === modelId
    && entry.pool.startsWith("managed:")
    && entry.enabled === true
    && entry.explicitZeroPrice === true
    && entry.paidFallbackDisabled === true
  );
  if (!route) {
    rows.push({ providerId, modelId, status: "SKIPPED_NOT_VERIFIED_FREE", requests: 0 });
    continue;
  }

  const adapter = createProviderAdapterById(providerId);
  if (!adapter?.streamChat) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_ADAPTER", requests: 0 });
    continue;
  }

  let requests = 0;
  let halted = false;
  const usage = [];
  const boundedAdapter = {
    providerId,
    streamChat: async function* (request, signal) {
      if (halted || requests >= maxRequestsPerModel) {
        throw new Error("R54_QUALIFICATION_BOUND");
      }
      requests++;
      const requestUsage = {
        request: requests,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        source: "UNKNOWN",
        errorCode: null,
      };
      usage.push(requestUsage);
      for await (const event of adapter.streamChat(request, signal)) {
        if (event.type === "usage") {
          requestUsage.inputTokens = event.usage.inputTokens ?? null;
          requestUsage.outputTokens = event.usage.outputTokens ?? null;
          requestUsage.totalTokens = requestUsage.inputTokens !== null && requestUsage.outputTokens !== null
            ? requestUsage.inputTokens + requestUsage.outputTokens
            : null;
          requestUsage.source = "PROVIDER_REPORTED";
        }
        if (event.type === "error") {
          requestUsage.errorCode = event.code ?? "PROVIDER_ERROR";
          if (event.status === 402 || event.status === 403 || event.status === 429 || (event.status ?? 0) >= 500) {
            halted = true;
          }
        }
        yield event;
      }
    },
  };

  const startedAt = new Date().toISOString();
  let receipt = null;
  let errorCode = null;
  try {
    receipt = await runRoleAwareQualification({
      providerId,
      modelId,
      displayName: modelId,
      accessClass: "FREE_ALLOWANCE",
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        isFree: true,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "R53 certified managed-free inventory",
      },
      isRemote: true,
      isCloudHosted: true,
    }, boundedAdapter, { caseTimeoutMs: 45_000 });
  } catch (error) {
    errorCode = String(error?.message ?? error).includes("R54_QUALIFICATION_BOUND")
      ? "REQUEST_BOUND"
      : "RUNNER_ERROR";
  }

  rows.push({
    providerId,
    modelId,
    status: receipt ? "EXECUTED" : "INCONCLUSIVE",
    startedAt,
    completedAt: new Date().toISOString(),
    requests,
    maxRequests: maxRequestsPerModel,
    halted,
    paidSpendUsd: 0,
    usage,
    errorCode,
    receipt: receipt ? {
      suiteVersion: receipt.suiteVersion,
      qualificationState: receipt.qualificationState,
      hardFailureRoles: receipt.hardFailureRoles,
      roleResults: Object.fromEntries(Object.entries(receipt.roleResults).map(([role, result]) => [role, {
        status: result.status,
        overallScore: result.overallScore,
        cases: result.testCases.map((testCase) => ({
          caseId: testCase.caseId,
          passed: testCase.passed,
          hardFailure: testCase.hardFailure,
          retries: testCase.retries,
          latencyMs: testCase.latencyMs,
          details: testCase.details,
          errorKind: testCase.error
            ? /429|rate.?limit/i.test(testCase.error)
              ? "RATE_LIMITED"
              : /5\d\d|unavailable|overload/i.test(testCase.error)
                ? "PROVIDER_UNAVAILABLE"
                : "OTHER"
            : null,
        })),
      }])),
    } : null,
  });
}

await writeFile(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  round: "R54",
  generatedAt: new Date().toISOString(),
  protocol: "production runRoleAwareQualification suite",
  sourceInventory: inventoryPath,
  sourceInventoryGeneratedAt: inventory.generatedAt,
  paidSpendUsd: 0,
  normalizedShillings: "NOT_DEFINED_IN_R54",
  rows,
}, null, 2)}\n`);

for (const row of rows) {
  const reviewer = row.receipt?.roleResults?.REVIEWER;
  console.log(`${row.providerId}/${row.modelId}: status=${row.status} reviewer=${reviewer?.status ?? "NOT_TESTED"} requests=${row.requests}`);
}

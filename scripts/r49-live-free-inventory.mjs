#!/usr/bin/env node
// Live metadata-only inventory. It never invokes model inference.
import os from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  isQualificationValid,
  SqliteQualificationPersistence,
} from "../packages/eight-bit/dist/index.js";
import { PROVIDER_DEFINITIONS } from "../packages/model-registry/dist/index.js";
import {
  createOpenRouterAdapter,
  createProviderAdapterById,
} from "../packages/providers/dist/index.js";
import { createSessionPersistence } from "../packages/sessions/dist/index.js";

const outPath = path.resolve("docs/evidence/r49-free-supply/R49-LIVE-FREE-INVENTORY.json");
const qualificationDb = process.env.R49_QUAL_DB ?? path.join(os.tmpdir(), "r46-qualification.db");
const staged = JSON.parse(readFileSync(path.resolve("docs/evidence/r49-free-supply/R49-STAGED-FREE-PROBES.json"), "utf8"));
const qualificationEvidence = JSON.parse(readFileSync(path.resolve("docs/evidence/r49-free-supply/R49-OPENROUTER-QUALIFICATION.json"), "utf8"));

const persistence = createSessionPersistence({ dbPath: qualificationDb });
await persistence.init();
const qualificationStore = new SqliteQualificationPersistence(persistence);
const receipts = await qualificationStore.loadAll();
const receiptByRoute = new Map(receipts.map((receipt) => [`${receipt.providerId}::${receipt.modelId}`, receipt]));

const catalogs = {};
for (const providerId of ["groq", "mistral", "openrouter"]) {
  const adapter = providerId === "openrouter"
    ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" })
    : createProviderAdapterById(providerId);
  if (!adapter) continue;
  try {
    catalogs[providerId] = await adapter.listModels();
  } catch (error) {
    catalogs[providerId] = { error: error instanceof Error ? error.message : String(error), models: [] };
  }
}

const openRouterKeyResponse = await fetch("https://openrouter.ai/api/v1/key", {
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
});
const openRouterKeyBody = await openRouterKeyResponse.json();
const openRouterKey = openRouterKeyBody.data ?? openRouterKeyBody;
const now = new Date().toISOString();
const groqProbe = staged.probes.find((probe) => probe.providerId === "groq" && probe.classification === "reachable_free_allowance");
const orQualificationResponses = qualificationEvidence.responseObservations ?? [];

function roleStatuses(receipt) {
  const roles = ["EXPLORER", "PLANNER", "CODER", "REVIEWER", "TOOL_AGENT", "ANALYST"];
  return Object.fromEntries(roles.map((role) => [role, receipt?.roleResults?.[role]?.status ?? "NOT_TESTED"]));
}

function receiptSummary(providerId, modelId) {
  const receipt = receiptByRoute.get(`${providerId}::${modelId}`);
  if (!receipt) return { current: false, suiteVersion: null, completedAt: null, qualificationState: "NOT_TESTED", roles: roleStatuses(undefined) };
  return {
    current: isQualificationValid(receipt),
    suiteVersion: receipt.suiteVersion,
    completedAt: receipt.completedAt,
    qualificationState: receipt.qualificationState,
    roles: roleStatuses(receipt),
    caseCounts: Object.fromEntries(Object.entries(receipt.roleResults ?? {}).map(([role, result]) => [
      role,
      {
        passed: result.testCases.filter((testCase) => testCase.passed).length,
        total: result.testCases.length,
        transient: result.testCases.filter((testCase) => testCase.error && /429|rate.?limit|quota|5\d\d|timed? ?out|fetch failed/i.test(testCase.error)).length,
      },
    ])),
  };
}

const routes = [];
for (const model of Array.isArray(catalogs.openrouter) ? catalogs.openrouter : []) {
  if (model.isFree !== true) continue;
  const qualification = receiptSummary("openrouter", model.modelId);
  const observations = orQualificationResponses.filter((observation) => observation.modelId === model.modelId);
  routes.push({
    providerId: "openrouter",
    modelId: model.modelId,
    routeId: `openrouter/${model.modelId}`,
    catalogPresent: true,
    zeroCost: {
      proven: true,
      classification: "ALWAYS_FREE",
      accessClass: "FREE_ROUTED",
      source: "live OpenRouter /api/v1/models prompt/completion price = 0",
      observedAt: now,
      paidFallbackDisabled: true,
    },
    credentialDomain: "OPENROUTER_API_KEY",
    accountId: "live-acct-openrouter",
    capacityPoolId: "managed:openrouter:live-acct-openrouter",
    correlationGroup: "openrouter-account-free-model-daily-requests",
    capabilities: {
      toolCalling: model.capabilities.toolCalling,
      streaming: true,
      structuredOutput: model.capabilities.structuredOutput,
      coding: model.capabilities.coding,
      vision: model.capabilities.vision,
    },
    contextWindow: model.contextWindow ?? null,
    knownLimits: {
      accountFreeModelDailyRequests: openRouterKey.free_model_daily_requests,
      modelAvailability: "volatile upstream capacity",
    },
    health: {
      status: observations.some((observation) => observation.status >= 400) ? "DEGRADED" : observations.length > 0 ? "HEALTHY" : "UNKNOWN",
      lastSuccessfulInvocation: observations.filter((observation) => observation.status === 200).at(-1)?.observedAt ?? null,
      lastRateLimitEvent: staged.probes.filter((probe) => probe.providerId === "openrouter" && probe.modelId === model.modelId && probe.response?.status === 429).at(-1)?.observedAt ?? null,
      cooldownUntil: null,
      durableAuthorityState: "not persisted",
    },
    qualification,
    lifecycle: "active",
    productAdmission: qualification.current && ["QUALIFIED", "PROBATION"].includes(qualification.qualificationState),
    providerDataPolicy: "standard; upstream free-model provider may vary",
  });
}

for (const model of Array.isArray(catalogs.groq) ? catalogs.groq : []) {
  if (/whisper|guard|tts|stt/i.test(model.modelId)) continue;
  const qualification = receiptSummary("groq", model.modelId);
  const observedThisRoute = groqProbe?.modelId === model.modelId;
  routes.push({
    providerId: "groq",
    modelId: model.modelId,
    routeId: `groq/${model.modelId}`,
    catalogPresent: true,
    zeroCost: {
      proven: Boolean(groqProbe),
      classification: "LIMITED_FREE_ALLOWANCE",
      accessClass: "FREE_ALLOWANCE",
      source: "provider free-plan definition + bounded live allowance probe",
      observedAt: groqProbe?.observedAt ?? null,
      paidFallbackDisabled: true,
    },
    credentialDomain: "GROQ_API_KEY",
    accountId: "live-acct-groq",
    capacityPoolId: `managed:groq:live-acct-groq:model:${model.modelId}`,
    correlationGroup: `groq-account:model:${model.modelId}`,
    correlationCaveat: "one credential; documented/observed model-scoped rate windows are not account independence",
    capabilities: {
      toolCalling: model.capabilities.toolCalling,
      streaming: true,
      structuredOutput: model.capabilities.structuredOutput,
      coding: model.capabilities.coding,
      vision: model.capabilities.vision,
    },
    contextWindow: model.contextWindow ?? null,
    knownLimits: groqProbe?.quotaHeaders ?? null,
    health: {
      status: observedThisRoute ? "HEALTHY" : "UNKNOWN",
      lastSuccessfulInvocation: observedThisRoute ? groqProbe.observedAt : null,
      lastRateLimitEvent: null,
      cooldownUntil: null,
      durableAuthorityState: "not persisted",
    },
    qualification,
    lifecycle: "active",
    productAdmission: Boolean(groqProbe) && qualification.current && ["QUALIFIED", "PROBATION"].includes(qualification.qualificationState),
    providerDataPolicy: "standard",
  });
}

const excludedProviders = [
  {
    providerId: "mistral",
    credentialPresent: Boolean(process.env.MISTRAL_API_KEY?.trim()),
    catalogModels: Array.isArray(catalogs.mistral) ? catalogs.mistral.length : 0,
    economicClassification: "LIMITED_FREE_ALLOWANCE",
    reason: "DATA_POLICY_USER_CONSENT_REQUIRED",
    independence: "one credential domain, excluded from product traffic without explicit consent",
  },
  {
    providerId: "cloudflare-workers-ai",
    credentialPresent: Boolean(process.env.CLOUDFLARE_API_KEY?.trim() && process.env.CLOUDFLARE_ACCOUNT_ID?.trim()),
    catalogModels: PROVIDER_DEFINITIONS["cloudflare-workers-ai"].freeAccess.allowanceModels?.length ?? 0,
    economicClassification: "INCLUDED_FREE",
    reason: "CLOUDFLARE_USAGE_SCOPE_REQUIRED",
    independence: "one account; fail-closed budget guard cannot read current neuron usage",
  },
  {
    providerId: "google",
    credentialPresent: Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()),
    economicClassification: "LIMITED_FREE_ALLOWANCE",
    reason: "USER_POLICY_ACCEPTANCE_REQUIRED_AND_TRAINING_POSSIBLE",
  },
  {
    providerId: "cerebras",
    credentialPresent: Boolean(process.env.CEREBRAS_API_KEY?.trim()),
    economicClassification: "TRIAL_CREDIT",
    reason: "PROMOTIONAL_CREDIT_NOT_MANAGED_FREE",
  },
  {
    providerId: "github-models",
    credentialPresent: Boolean(process.env.GITHUB_MODELS_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()),
    economicClassification: "LIMITED_FREE_ALLOWANCE",
    reason: "LEGAL_REVIEW_REQUIRED_FOR_PRODUCTION",
  },
  {
    providerId: "openai",
    credentialPresent: Boolean(process.env.OPENAI_API_KEY?.trim()),
    economicClassification: "PAID",
    reason: "PAID_ONLY_FORBIDDEN_TO_8BIT",
  },
  {
    providerId: "anthropic",
    credentialPresent: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    economicClassification: "PAID",
    reason: "PAID_ONLY_FORBIDDEN_TO_8BIT",
  },
];

const productionRoutes = routes.filter((route) => route.productAdmission);
const pools = [...new Set(productionRoutes.map((route) => route.capacityPoolId))];
const credentialDomains = [...new Set(productionRoutes.map((route) => `${route.providerId}:${route.accountId}`))];
const roles = ["EXPLORER", "PLANNER", "CODER", "REVIEWER", "TOOL_AGENT", "ANALYST"];
const roleCoverage = Object.fromEntries(roles.map((role) => {
  const qualified = productionRoutes.filter((route) => route.qualification.roles[role] === "QUALIFIED");
  const probation = productionRoutes.filter((route) => route.qualification.roles[role] === "PROBATION");
  return [role, {
    qualifiedRoutes: qualified.length,
    probationRoutes: probation.length,
    independentCredentialDomains: [...new Set([...qualified, ...probation].map((route) => `${route.providerId}:${route.accountId}`))].length,
    availableNow: [...qualified, ...probation].filter((route) => route.health.status === "HEALTHY").length,
  }];
}));

const inventory = {
  schemaVersion: 1,
  round: "R49",
  generatedAt: now,
  provenance: {
    catalogs: "live zero-cost metadata",
    qualification: "durable replay plus R49 live zero-cost qualification",
    health: "live probes where present; otherwise unknown",
    exclusions: "deterministic policy",
  },
  paidSpendUsd: 0,
  summary: {
    liveCatalogModels: {
      groq: Array.isArray(catalogs.groq) ? catalogs.groq.length : 0,
      mistral: Array.isArray(catalogs.mistral) ? catalogs.mistral.length : 0,
      openrouter: Array.isArray(catalogs.openrouter) ? catalogs.openrouter.length : 0,
    },
    explicitZeroUnitOpenRouterModels: routes.filter((route) => route.providerId === "openrouter").length,
    currentlyProvenZeroCostCandidates: routes.filter((route) => route.zeroCost.proven).length,
    productionQualifiedRoutes: productionRoutes.length,
    productionProviders: [...new Set(productionRoutes.map((route) => route.providerId))].length,
    independentCredentialDomains: credentialDomains.length,
    physicalCapacityPools: pools.length,
    healthyProductionRoutes: productionRoutes.filter((route) => route.health.status === "HEALTHY").length,
    degradedProductionRoutes: productionRoutes.filter((route) => route.health.status === "DEGRADED").length,
    exhaustedProductionRoutes: productionRoutes.filter((route) => route.health.status === "QUOTA_EXHAUSTED").length,
  },
  openRouterAccount: {
    observedAt: now,
    isFreeTier: openRouterKey.is_free_tier,
    freeModelDailyRequests: openRouterKey.free_model_daily_requests,
    poolCount: 1,
  },
  roleCoverage,
  routes,
  excludedProviders,
};
writeFileSync(outPath, `${JSON.stringify(inventory, null, 2)}\n`);
await persistence.close();
console.log(`[r49-inventory] routes=${routes.length} productionQualified=${productionRoutes.length} providers=${inventory.summary.productionProviders} credentialDomains=${credentialDomains.length}`);
console.log(`[r49-inventory] evidence=${outPath}`);

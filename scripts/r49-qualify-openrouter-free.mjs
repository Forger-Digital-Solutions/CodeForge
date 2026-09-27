#!/usr/bin/env node
// Staged R49 qualification for one explicit-zero OpenRouter route.
import os from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import {
  createEightBitRouteHealthAuthority,
  runRoleAwareQualification,
  SqliteQualificationPersistence,
} from "../packages/eight-bit/dist/index.js";
import {
  createFreeCloudService,
  NormalizedModelRegistry,
} from "../packages/model-registry/dist/index.js";
import {
  createOpenRouterAdapter,
  InMemoryProviderCatalog,
} from "../packages/providers/dist/index.js";
import { createSessionPersistence } from "../packages/sessions/dist/index.js";

const target = process.argv[2] ?? "nvidia/nemotron-3-super-120b-a12b:free";
const probePath = path.resolve("docs/evidence/r49-free-supply/R49-STAGED-FREE-PROBES.json");
const evidencePath = path.resolve("docs/evidence/r49-free-supply/R49-OPENROUTER-QUALIFICATION.json");
const qualificationDb = process.env.R49_QUAL_DB ?? path.join(os.tmpdir(), "r46-qualification.db");
if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY is required.");

const staged = JSON.parse(readFileSync(probePath, "utf8"));
const preflight = staged.probes?.find((probe) =>
  probe.providerId === "openrouter" &&
  probe.modelId === target &&
  probe.classification === "protocol_preflight_pass"
);
if (!preflight) {
  throw new Error(`Refusing qualification: no frozen passing protocol preflight for openrouter/${target}.`);
}

async function accountCapacity() {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  });
  if (!response.ok) throw new Error(`OpenRouter key status failed with HTTP ${response.status}.`);
  const body = await response.json();
  const data = body.data ?? body;
  return {
    observedAt: new Date().toISOString(),
    isFreeTier: data.is_free_tier,
    freeModelDailyRequests: data.free_model_daily_requests,
  };
}

const before = await accountCapacity();
const firewall = new ForgeZero();
const routeHealth = createEightBitRouteHealthAuthority();
const registry = new NormalizedModelRegistry();
const catalog = new InMemoryProviderCatalog();
const freeCloud = createFreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth });
freeCloud.registerManagedPool("openrouter", "live-acct-openrouter");
const responseObservations = [];
const managedObserver = freeCloud.managedAccountObserver("openrouter", "live-acct-openrouter");
const adapter = createOpenRouterAdapter({
  baseUrl: "https://openrouter.ai/api/v1",
  onResponse: (observation) => {
    managedObserver(observation);
    responseObservations.push({
      providerId: observation.providerId,
      modelId: observation.modelId ?? null,
      status: observation.status,
      headers: observation.headers,
      observedAt: new Date(observation.observedAt).toISOString(),
    });
  },
});
catalog.register(adapter);

const refresh = await freeCloud.createCatalogRefresh({
  maxAllowanceProbes: 0,
  requireCredentials: true,
}).refresh();
freeCloud.setConnection({
  providerId: "openrouter",
  connected: true,
  credentialSource: "ENVIRONMENT",
  authState: "ok",
  planAttested: true,
});
const model = firewall.getModel("openrouter", target);
if (!model || model.freeStatus !== "verified_free" || !model.costProfile.isFree || model.costProfile.paidFallbackPossible) {
  throw new Error(`Refusing qualification: openrouter/${target} lacks current explicit-zero, no-paid-fallback proof.`);
}

const persistence = createSessionPersistence({ dbPath: qualificationDb });
await persistence.init();
freeCloud.attachQualificationStore(new SqliteQualificationPersistence(persistence));
const priorReceiptCount = await freeCloud.loadQualification();
const receipt = await runRoleAwareQualification(model, adapter, {
  caseTimeoutMs: 90_000,
});
await freeCloud.recordReceipt(receipt);
const after = await accountCapacity();

const evidence = {
  schemaVersion: 1,
  round: "R49",
  generatedAt: new Date().toISOString(),
  provenance: "live zero-cost",
  target: {
    providerId: "openrouter",
    modelId: target,
    accessClass: model.accessClass,
    freeStatus: model.freeStatus,
    costProfile: model.costProfile,
    contextWindow: model.contextWindow,
    capabilities: model.capabilities,
  },
  stagedPreflight: preflight,
  catalog: {
    source: refresh.registry.source,
    modelCount: refresh.registry.modelCount,
    registered: refresh.registered,
    errors: refresh.errors,
    allowanceProbeBudget: 0,
  },
  accountCapacity: { before, after },
  exactHttpResponseCount: responseObservations.length,
  responseObservations,
  priorReceiptCount,
  receipt,
  paidSpendUsd: 0,
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
await persistence.close();
console.log(`[r49-qualification] ${target}: ${receipt.qualificationState}`);
for (const [role, result] of Object.entries(receipt.roleResults ?? {})) {
  console.log(`[r49-qualification] ${role}=${result.status}`);
}
console.log(`[r49-qualification] responses=${responseObservations.length} freeRequests=${before.freeModelDailyRequests?.remaining}->${after.freeModelDailyRequests?.remaining}`);
console.log(`[r49-qualification] evidence=${evidencePath}`);

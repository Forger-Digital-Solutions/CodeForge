#!/usr/bin/env node
// R47 Phase B: 16-Bit campaign harness. Every paid call passes through the durable campaign
// ledger via BudgetGatedProviderAdapter — no reserve, no dispatch; settlement once; receipts
// always. Hard gates: CODEFORGE_16BIT_CAMPAIGN=1 + a finite --cap ceiling + a live-catalog
// PriceCard for the exact route. Nothing here authorizes a mission by itself.
//
//   CODEFORGE_16BIT_CAMPAIGN=1 node scripts/r47-16bit-campaign.mjs probe  --model glm-5.3-flash
//   CODEFORGE_16BIT_CAMPAIGN=1 node scripts/r47-16bit-campaign.mjs qualify --model glm-5.3-flash [--cap 0.50]
import os from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createOpenRouterAdapter } from "../packages/providers/dist/index.js";
import { createSessionPersistence } from "../packages/sessions/dist/index.js";
import { BudgetGatedProviderAdapter, DurablePaidEvaluationBudgetLedger, paidAutoModel } from "../packages/paid-auto/dist/index.js";
import { createGenericFreeRecord } from "../packages/forge-zero/dist/index.js";
import { runRoleAwareQualification } from "../packages/eight-bit/dist/index.js";

const args = process.argv.slice(2);
const CMD = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL_ID = opt("model", "");
const CAP = opt("cap", "0.50");
const EVIDENCE_DIR = path.resolve("docs/evidence/r47-16bit");
const CAMPAIGN_DB = process.env.R47_PAID_DB ?? path.join(os.tmpdir(), "r47-16bit-ledger.db");
const CAMPAIGN_ID = "r47-16bit";
const SESSION_ID = "r47-16bit-campaign";

if (process.env.CODEFORGE_16BIT_CAMPAIGN !== "1") {
  console.error("fail-closed: CODEFORGE_16BIT_CAMPAIGN=1 is required for any 16-Bit spend");
  process.exit(1);
}
if (!["probe", "qualify"].includes(CMD) || !MODEL_ID) {
  console.error("usage: r47-16bit-campaign.mjs probe|qualify --model <canonicalId> [--cap usd]");
  process.exit(1);
}
const model = paidAutoModel(MODEL_ID);
if (!model) {
  console.error(`unknown canonical model ${MODEL_ID}`);
  process.exit(1);
}
const route = model.fallback;
const pricing = JSON.parse(readFileSync(path.join(EVIDENCE_DIR, "R47-16BIT-PRICING.json"), "utf8"));
const priceCards = pricing.priceCards.filter(
  (c) => c.canonicalModelId === route.canonicalModelId && c.providerId === route.providerId && c.providerModelId === route.providerModelId,
);
if (priceCards.length !== 1) {
  console.error(`fail-closed: need exactly one exact PriceCard for ${route.providerModelId}, found ${priceCards.length}`);
  process.exit(1);
}

const persistence = createSessionPersistence({ dbPath: CAMPAIGN_DB });
await persistence.init();
await persistence.upsertSession({ id: SESSION_ID, title: "R47 16-Bit campaign", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
const ledger = new DurablePaidEvaluationBudgetLedger(persistence, { campaignId: CAMPAIGN_ID, sessionId: SESSION_ID, authorizedUsd: CAP });
const receipts = [];
const upstream = createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" });
const gated = new BudgetGatedProviderAdapter(upstream, { ledger, priceCards, onReceipt: (r) => receipts.push(r) });

const record = createGenericFreeRecord({
  providerId: route.providerId,
  modelId: route.providerModelId,
  displayName: model.displayName,
  freeStatus: "paid",
  tier: "paid",
  contextWindow: model.contextWindow,
  capabilities: model.capabilities,
});

const finish = async (result) => {
  const snapshot = await ledger.snapshot();
  const out = {
    generatedAt: new Date().toISOString(),
    campaignId: CAMPAIGN_ID,
    model: MODEL_ID,
    route: route.routeId,
    command: CMD,
    priceCardSource: priceCards[0].source,
    result,
    budget: snapshot,
    receipts,
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `R47-16BIT-${CMD.toUpperCase()}-${MODEL_ID}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`evidence: ${file}`);
  console.log(`committed=${snapshot.committedUsd} reserved=${snapshot.reservedUsd} available=${snapshot.availableUsd} receipts=${receipts.length}`);
  await persistence.close();
};

if (CMD === "probe") {
  const response = await gated.chat({
    model: route.providerModelId,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxTokens: 8,
  });
  await finish({ servedModel: response.model, content: response.choices[0]?.message.content?.slice(0, 80), usage: response.usage });
} else {
  const output = await runRoleAwareQualification(record, gated);
  await finish({
    qualificationState: output.qualificationState,
    roleResults: output.roleResults,
    requestCount: output.metadata?.requests,
    transientCases: output.metadata?.roleTransientCases,
  });
}

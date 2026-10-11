import { readFile, writeFile } from "node:fs/promises";
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter } from "@codeforge/providers";
import { reverifyKiloPolicy } from "@codeforge/model-registry";

/**
 * R81 PHASE H — bounded free-capacity delta investigation. Catalog-level only by
 * default (zero inference spend): diff the live kilo-free-direct and blockrun free
 * catalogs against the R80 phase-g baseline. A compact qualification probe runs ONLY
 * for a model that is (a) new in the free catalog since R80 and (b) credibly
 * coding-capable (capability flag or code-oriented id). Existing qualified models
 * are not re-qualified — receipts are durable evidence; health re-checks are catalog
 * observations, not inference.
 */

const EVIDENCE_DIR = "docs/evidence/r81-forgeaaa-native-gameplay";
const BASELINE_FILE = "docs/evidence/r80-forgeaaa-autonomous-gameplay/phase-g-coder-capacity-1791699174859.json";

const report = {
  startedAt: new Date().toISOString(),
  evidenceClass: "R81_PHASE_H_FREE_CAPACITY_DELTA",
  catalogs: {},
  delta: {},
  probes: {},
};
const file = `${EVIDENCE_DIR}/phase-h-capacity-delta-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(report, null, 2));

const kilo = createKiloFreeDirectAdapter();
report.policy = await reverifyKiloPolicy(report.startedAt);
const kiloCatalog = (await kilo.listModels()).map((m) => ({
  modelId: m.modelId, isFree: m.isFree, freeStatus: m.freeStatus,
  tools: m.capabilities?.toolCalling, structured: m.capabilities?.structuredOutput,
  contextWindow: m.contextWindow, coding: m.capabilities?.coding,
}));
report.catalogs["kilo-free-direct"] = kiloCatalog;
try {
  const blockrun = createBlockRunFreeAdapter();
  const models = await blockrun.listModels();
  report.catalogs["blockrun-free-direct"] = { ok: true, freeCount: models.filter((m) => m.isFree).length, models: models.filter((m) => m.isFree).map((m) => m.modelId) };
} catch (e) {
  report.catalogs["blockrun-free-direct"] = { ok: false, error: String(e?.message ?? e), code: e?.code, status: e?.status };
}
await persist();

const baseline = JSON.parse(await readFile(BASELINE_FILE, "utf8"));
const prevIds = new Set((baseline.catalogs["kilo-free-direct"] ?? []).map((m) => m.modelId));
const nowIds = new Set(kiloCatalog.map((m) => m.modelId));
report.delta.added = [...nowIds].filter((id) => !prevIds.has(id));
report.delta.removed = [...prevIds].filter((id) => !nowIds.has(id));
report.delta.stillFree = [...nowIds].filter((id) => prevIds.has(id));

const codeLike = /code|coder|devstral|deepseek|qwen|starcoder|codestral|granite.*code|nemotron.*super|nemotron.*ultra/i;
const newCandidates = kiloCatalog.filter((m) =>
  report.delta.added.includes(m.modelId) && m.isFree && (m.coding === true || codeLike.test(m.modelId)));
report.delta.newCodingCandidates = newCandidates.map((m) => m.modelId);

if (newCandidates.length === 0) {
  report.probes.note = "no new coding-credible free models since R80 baseline — zero inference spent";
} else {
  const candidate = newCandidates[0];
  const frames = [];
  report.probes[candidate.modelId] = { frames };
  try {
    let text = "";
    for await (const ev of kilo.streamChat({
      model: candidate.modelId,
      messages: [{ role: "user", content: "Reply with exactly one JSON object: {\"ok\":true,\"fn\":\"add\",\"result\":4} when asked to add 2+2. Do it now." }],
      temperature: 0, maxTokens: 120,
    })) {
      frames[0] = frames[0] ?? { at: new Date().toISOString(), events: 0, chars: 0 };
      frames[0].events++;
      if (ev?.type === "text_delta") { text += ev.delta; frames[0].chars = text.length; }
      else if (ev?.type === "error") throw Object.assign(new Error(ev.message), { code: ev.code, status: ev.status });
    }
    report.probes[candidate.modelId].response = text.slice(0, 400);
    report.probes[candidate.modelId].reachable = text.length > 0;
  } catch (e) {
    report.probes[candidate.modelId].reachable = false;
    report.probes[candidate.modelId].error = String(e?.message ?? e);
  }
}
await persist();

report.quotaDomains = {
  "kilo-free-direct": "SINGLE_ANONYMOUS_DOMAIN — every :free model shares one anonymous quota; catalog breadth is capacity, not provider redundancy",
  "blockrun-free-direct": report.catalogs["blockrun-free-direct"]?.ok ? "catalog reachable — see freeCount" : "unavailable — see error",
};
report.independentCoderRoutes = "still 1 quota domain (kilo anonymous) — model count ≠ independence";
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({
  file,
  kiloCount: kiloCatalog.length,
  added: report.delta.added, removed: report.delta.removed,
  newCodingCandidates: report.delta.newCodingCandidates,
  blockrun: report.catalogs["blockrun-free-direct"],
  probes: Object.fromEntries(Object.entries(report.probes).filter(([k]) => k !== "note").map(([k, v]) => [k, v.reachable ?? v.error])),
}));

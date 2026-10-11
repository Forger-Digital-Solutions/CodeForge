import { writeFile } from "node:fs/promises";
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter } from "@codeforge/providers";
import { reverifyKiloPolicy } from "@codeforge/model-registry";
import { runCompactQualification } from "@codeforge/eight-bit";
import { createGenericFreeRecord } from "@codeforge/forge-zero";

/**
 * R80 PHASE G — bounded free-coder capacity probe.
 * 1. Live catalogs: kilo-free-direct (anonymous, zero-account) + blockrun listModels (read-only
 *    catalog check, no inference — quota state only).
 * 2. Bounded compact qualification: nemotron-3-super demonstrated real structured authoring
 *    (the R80 doorSpec) but holds no CODER receipt — 3-probe suite is justified.
 * 3. north-mini-code health re-check: its R76 CODER receipt exists; it was 429-excluded then.
 * Quota-domain rule: every kilo model shares one anonymous quota domain — a second kilo model
 * is capacity, never independence. Evidence recorded verbatim.
 */

const EVIDENCE_DIR = "docs/evidence/r80-forgeaaa-autonomous-gameplay";
const SUPER = "nvidia/nemotron-3-super-120b-a12b:free";
const NORTH = "cohere/north-mini-code:free";

const report = {
  startedAt: new Date().toISOString(),
  evidenceClass: "R80_PHASE_G_FREE_CODER_CAPACITY",
  catalogs: {},
  qualifications: {},
  quotaDomains: {},
};
const file = `${EVIDENCE_DIR}/phase-g-coder-capacity-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(report, null, 2));

const kilo = createKiloFreeDirectAdapter();
report.policy = await reverifyKiloPolicy(report.startedAt);
report.catalogs["kilo-free-direct"] = (await kilo.listModels()).map((m) => ({
  modelId: m.modelId, isFree: m.isFree, freeStatus: m.freeStatus,
  tools: m.capabilities?.toolCalling, structured: m.capabilities?.structuredOutput,
  contextWindow: m.contextWindow, coding: m.capabilities?.coding,
}));
try {
  const blockrun = createBlockRunFreeAdapter();
  const models = await blockrun.listModels();
  report.catalogs["blockrun-free-direct"] = { ok: true, freeCount: models.filter((m) => m.isFree).length, models: models.filter((m) => m.isFree).map((m) => m.modelId) };
} catch (e) {
  report.catalogs["blockrun-free-direct"] = { ok: false, error: String(e?.message ?? e), code: e?.code, status: e?.status };
}
await persist();

function traced(modelId, key) {
  const frames = [];
  report.qualifications[key] = { modelId, frames };
  return {
    providerId: "kilo-free-direct", isTestProvider: false,
    async *streamChat(request, signal) {
      const frame = { at: new Date().toISOString(), events: 0, chars: 0 };
      frames.push(frame);
      try {
        for await (const ev of kilo.streamChat(request, signal)) {
          frame.events++;
          if (ev?.type === "text_delta") frame.chars += ev.delta.length;
          else if (ev?.type === "error") throw Object.assign(new Error(ev.message), { code: ev.code, status: ev.status });
          yield ev;
        }
      } catch (e) {
        frame.error = { code: e.code, status: e.status, message: e.message };
        throw e;
      } finally {
        frame.finishedAt = new Date().toISOString();
        await persist();
      }
    },
  };
}

async function qualify(modelId, key) {
  const catalog = report.catalogs["kilo-free-direct"];
  const entry = catalog.find((m) => m.modelId === modelId && m.isFree);
  if (!entry) {
    report.qualifications[key].skipped = "MODEL_ABSENT_FROM_FREE_CATALOG";
    return;
  }
  const record = { ...createGenericFreeRecord({ providerId: "kilo-free-direct", modelId }),
    capabilities: { text: true, coding: entry.coding, toolCalling: entry.tools, vision: false, structuredOutput: entry.structured, longContext: (entry.contextWindow ?? 0) > 32000 },
    contextWindow: entry.contextWindow };
  try {
    const receipt = await runCompactQualification(record, traced(modelId, key), { signal: AbortSignal.timeout(300_000) });
    report.qualifications[key].receipt = receipt;
    report.qualifications[key].state = receipt.qualificationState;
    report.qualifications[key].roles = Object.fromEntries(Object.entries(receipt.roleResults).map(([r, v]) => [r, v.status]));
  } catch (e) {
    report.qualifications[key].error = String(e?.message ?? e);
  }
  await persist();
}

await qualify(SUPER, "nemotron-3-super");
await qualify(NORTH, "north-mini-code");

report.quotaDomains["kilo-free-direct"] = "SINGLE_ANONYMOUS_DOMAIN — every :free model on the kilo gateway shares one quota; model count is not provider redundancy";
report.quotaDomains["blockrun-free-direct"] = report.catalogs["blockrun-free-direct"]?.ok ? "catalog reachable — see freeCount" : "unavailable/exhausted — see error";
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, catalog: report.catalogs["kilo-free-direct"].length, blockrun: report.catalogs["blockrun-free-direct"], quals: Object.fromEntries(Object.entries(report.qualifications).map(([k, v]) => [k, v.state ?? v.skipped ?? v.error])) }));

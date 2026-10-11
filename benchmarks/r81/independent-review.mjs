import { readFile, writeFile } from "node:fs/promises";
import { createKiloFreeDirectAdapter } from "@codeforge/providers";
import { reverifyKiloPolicy } from "@codeforge/model-registry";
import { createModelReviewer } from "@codeforge/forge-aaa";

/**
 * R81 GATE — genuinely independent review of the R81 native gameplay milestone.
 * Reviewer: nvidia/nemotron-3-ultra-550b-a55b:free on kilo-free-direct, which holds a
 * QUALIFIED REVIEWER receipt (R73_ROLE_QUALIFICATION_V7 / REVIEWER_PROTOCOL_V4,
 * 2026-10-10, score 0.875). R81 was implemented by deterministic adapters and a
 * separate Coder model (module contract), so this reviewer had no role in the
 * implementation — the independence claim is real.
 */

const REVIEWER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const EVIDENCE_DIR = "docs/evidence/r81-forgeaaa-native-gameplay";
const RECEIPT_FILE = "docs/evidence/r74-autonomous-completion-and-free-reliability/reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json";

const report = {
  startedAt: new Date().toISOString(),
  evidenceClass: "LIVE_INDEPENDENT_REVIEW_R81_NATIVE_GAMEPLAY",
  reviewerModel: REVIEWER_MODEL,
  frames: [],
};
const file = `${EVIDENCE_DIR}/independent-review-r81-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(report, null, 2));

const adapter = createKiloFreeDirectAdapter();
try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== "VERIFIED") throw new Error("POLICY_NOT_VERIFIED");

  const catalog = await adapter.listModels();
  report.catalogCount = catalog.length;
  const model = catalog.find((m) => m.modelId === REVIEWER_MODEL && m.isFree);
  if (!model) throw new Error("REVIEWER_MODEL_NOT_IN_FREE_CATALOG");
  report.catalogEntry = model;

  const receipt = JSON.parse(await readFile(RECEIPT_FILE, "utf8"));
  const reviewerResult = receipt.qualification?.roleResults?.REVIEWER;
  if (reviewerResult?.status !== "QUALIFIED") throw new Error("REVIEWER_RECEIPT_NOT_QUALIFIED");
  report.reviewerQualification = {
    providerId: adapter.providerId,
    suiteVersion: receipt.qualification.suiteVersion,
    protocolVersion: receipt.qualification.metadata?.roleProtocolVersions?.REVIEWER ?? "unknown",
    status: reviewerResult.status,
    score: reviewerResult.overallScore,
    completedAt: reviewerResult.completedAt,
  };

  const packet = await readFile(`${EVIDENCE_DIR}/review-packet-r81.md`, "utf8");
  const reviewRun = createModelReviewer({
    modelId: REVIEWER_MODEL,
    qualification: {
      providerId: adapter.providerId,
      suiteVersion: report.reviewerQualification.suiteVersion,
      protocolVersion: report.reviewerQualification.protocolVersion,
      status: reviewerResult.status,
      completedAt: reviewerResult.completedAt,
    },
    packetOf: () => packet,
    chat: async (req) => {
      const frame = { at: new Date().toISOString(), model: req.model, events: 0, chars: 0 };
      report.frames.push(frame);
      let text = "";
      try {
        for await (const ev of adapter.streamChat(req)) {
          frame.events++;
          if (ev?.type === "text_delta") text += ev.delta;
          else if (ev?.type === "error") throw Object.assign(new Error(ev.message), { code: ev.code, status: ev.status });
          frame.chars = text.length;
        }
      } finally {
        frame.finishedAt = new Date().toISOString();
        await persist();
      }
      return text;
    },
  });

  const outcome = await reviewRun({});
  report.review = outcome;
  report.status = outcome.independent ? "INDEPENDENT_REVIEW_COMPLETED" : "REVIEW_NOT_INDEPENDENT";
} catch (e) {
  report.status = "BLOCKED";
  report.error = e instanceof Error ? e.message : String(e);
}
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({
  file, status: report.status,
  approved: report.review?.approved, independent: report.review?.independent,
  verdict: report.review?.verdict, requests: report.frames.length,
  error: report.error,
}));

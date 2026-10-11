import { writeFile } from "node:fs/promises";
import { createKiloFreeDirectAdapter } from "@codeforge/providers";
import { reverifyKiloPolicy } from "@codeforge/model-registry";
import { parseDoorSpecFromText, defaultDoorSpec } from "@codeforge/forge-aaa";

/**
 * R80 GATE 4 — model-directed implementation artifact. A REVIEWER-independent,
 * CODER-qualified free model authors the doorSpec JSON consumed verbatim by both the
 * Blender generator and the Unreal interaction harness. If the emitted spec fails
 * schema validation, exactly one bounded repair call is made with the parse error.
 * Deterministic fallback is recorded honestly as such — never as model output.
 */

const PRIMARY = "nvidia/nemotron-3-super-120b-a12b:free";
const EVIDENCE_DIR = "docs/evidence/r80-forgeaaa-autonomous-gameplay";

const SCHEMA_DOC = `DoorSpec JSON (all dimensions centimeters):
{
 "moduleId": string — e.g. "dtw/building/door-western/v1" ([A-Za-z0-9/_-]{3,96}),
 "opening": {"widthCm": 60..300, "heightCm": 150..300},
 "leaf": {"thicknessCm": 2..15, "clearanceCm": 0.2..5, "battens": 0..6},
 "frame": {"depthCm": 5..60, "jambWidthCm": 3..40},
 "hinge": {"side": "left"|"right", "pivotOffsetCm": 0..20},
 "motion": {"openAngleDeg": non-zero in [-135,-30]∪[30,135] (sign = swing direction), "transitionS": 0.2..10}
}`;

const report = {
  startedAt: new Date().toISOString(),
  evidenceClass: "MODEL_DIRECTED_DOOR_SPEC",
  model: PRIMARY,
  frames: [],
  attempts: [],
};
const file = `${EVIDENCE_DIR}/model-door-spec-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(report, null, 2));

const adapter = createKiloFreeDirectAdapter();
async function call(messages, attempt) {
  const frame = { at: new Date().toISOString(), model: PRIMARY, events: 0, chars: 0, attempt };
  report.frames.push(frame);
  let text = "";
  try {
    for await (const ev of adapter.streamChat({ model: PRIMARY, messages, temperature: 0, maxTokens: 900 })) {
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
}

const system = [
  "You are a game-development engineer authoring one JSON artifact: a modular door spec for a",
  "late-19th-century Western hinged door (period wooden plank construction, battens appropriate,",
  "no modern hardware). The spec drives a Blender generator and an Unreal Engine 4.27 interaction",
  "harness unchanged — emit exactly one valid JSON object and nothing else.",
  SCHEMA_DOC,
].join("\n");

try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== "VERIFIED") throw new Error("POLICY_NOT_VERIFIED");
  const catalog = await adapter.listModels();
  const entry = catalog.find((m) => m.modelId === PRIMARY && m.isFree);
  if (!entry) throw new Error("MODEL_NOT_IN_FREE_CATALOG");
  report.catalogEntry = entry;

  const user = "Produce the DoorSpec for a modest cabin door. Opening roughly 100x210 cm, hinge on the left, leaf swings inward (negative angle) about 95 degrees, transition under one second. Battens appropriate to 1880s construction.";
  let text = await call([{ role: "system", content: system }, { role: "user", content: user }], 1);
  let parsed = parseDoorSpecFromText(text);
  report.attempts.push({ attempt: 1, raw: text, parsed: parsed.ok ? "valid" : parsed.error });
  if (!parsed.ok) {
    const repair = `Your previous output failed validation: ${parsed.error}. Emit the corrected JSON object only.`;
    text = await call([{ role: "system", content: system }, { role: "user", content: user }, { role: "assistant", content: text }, { role: "user", content: repair }], 2);
    parsed = parseDoorSpecFromText(text);
    report.attempts.push({ attempt: 2, raw: text, parsed: parsed.ok ? "valid" : parsed.error });
  }
  if (parsed.ok) {
    report.doorSpec = parsed.spec;
    report.status = "MODEL_SPEC_VALID";
  } else {
    report.doorSpec = defaultDoorSpec();
    report.status = "DETERMINISTIC_FALLBACK";
    report.fallbackReason = report.attempts.at(-1).parsed;
  }
} catch (e) {
  report.doorSpec = defaultDoorSpec();
  report.status = "DETERMINISTIC_FALLBACK";
  report.fallbackReason = e instanceof Error ? e.message : String(e);
}
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, spec: report.doorSpec, error: report.fallbackReason }));

import { mkdir, writeFile } from "node:fs/promises";
import { createKiloFreeDirectAdapter } from "@codeforge/providers";
import { reverifyKiloPolicy } from "@codeforge/model-registry";
import { parseModuleContractFromText, validateModuleContract } from "@codeforge/forge-aaa";

/**
 * R81 GATE — model-directed implementation artifact. A Coder-qualified free model
 * authors the reusable building-module contract for the native western door: identity,
 * pivot, sockets, collision, IForgeInteractable states, and persistence semantics.
 * The contract is schema-validated (validateModuleContract); exactly one bounded repair
 * call is allowed on validation failure. Deterministic fallback is recorded honestly —
 * never as model output. The artifact is consumed as the gameplay contract the R81
 * native door already implements, and the template for future wall/window/stair modules.
 */

const PRIMARY = "nvidia/nemotron-3-super-120b-a12b:free";
const EVIDENCE_DIR = "docs/evidence/r81-forgeaaa-native-gameplay";
const CONTRACT_FILE = "benchmarks/r81/module-contracts/door-western.module.json";

const SCHEMA_DOC = `BuildingModuleContract JSON (all dimensions centimeters):
{
 "contractVersion": 1,
 "moduleId": string matching [A-Za-z0-9/_-]{3,96},
 "moduleType": "door"|"window"|"wall"|"floor"|"roof"|"foundation"|"stair"|"storage"|"furniture"|"attachment",
 "displayName": string,
 "dimensions": {"widthCm": >0, "depthCm": >0, "heightCm": >0},
 "pivot": {"kind": "hinge-left"|"hinge-right"|"center"|"corner"|"custom", "offsetCm"?: [x,y,z]},
 "sockets": [{"id": string, "localPosCm": [x,y,z], "accepts"?: [moduleType,...]}, ...],
 "collision": {"profile": "block-all"|"block-dynamic"|"custom"|"none", "blocksWhenClosed"?: bool, "passesWhenOpen"?: bool},
 "interaction"?: {"interface": "IForgeInteractable", "states": [non-empty string,...], "initialState": one of states},
 "persistence"?: {"identityFrom": "instanceId"|"actorName"|"placedLabel", "stateFields": [string,...], "schemaVersion": int >= 1},
 "provenance": {"authoredBy": "model"|"deterministic"|"hand", "modelId"?: string, "sourceModuleId"?: string},
 "engines": {"unreal"?: [version,...], "blender"?: [version,...]}
}`;

const FALLBACK = () => validateModuleContract({
  contractVersion: 1,
  moduleId: "dtw/building/door-western/v1",
  moduleType: "door",
  displayName: "Western hinged door",
  dimensions: { widthCm: 104, depthCm: 24, heightCm: 214 },
  pivot: { kind: "hinge-left", offsetCm: [-50, 0, 0] },
  sockets: [{ id: "frame", localPosCm: [0, 0, 0], accepts: ["wall"] }],
  collision: { profile: "block-dynamic", blocksWhenClosed: true, passesWhenOpen: true },
  interaction: { interface: "IForgeInteractable", states: ["closed", "opening", "open", "closing"], initialState: "closed" },
  persistence: { identityFrom: "actorName", stateFields: ["state", "yawDeg"], schemaVersion: 1 },
  provenance: { authoredBy: "deterministic" },
  engines: { unreal: ["4.27"], blender: ["4.5"] },
});

const report = {
  startedAt: new Date().toISOString(),
  evidenceClass: "MODEL_DIRECTED_MODULE_CONTRACT",
  model: PRIMARY,
  frames: [],
  attempts: [],
};
const file = `${EVIDENCE_DIR}/model-module-contract-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(report, null, 2));

const adapter = createKiloFreeDirectAdapter();
async function call(messages, attempt) {
  const frame = { at: new Date().toISOString(), model: PRIMARY, events: 0, chars: 0, attempt };
  report.frames.push(frame);
  let text = "";
  try {
    for await (const ev of adapter.streamChat({ model: PRIMARY, messages, temperature: 0, maxTokens: 1400 })) {
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
  "You are a game-engine engineer authoring one JSON artifact: a reusable building-module contract",
  "for a native Unreal Engine 4.27 interactive door module (late-19th-century Western farmhouse).",
  "The door actor is an AActor that implements IForgeInteractable. Its leaf hangs on a hinge pivot",
  "at the left jamb edge and ticks through a closed -> opening -> open -> closing state machine.",
  "Each placed instance keeps independent identity and persists a stable state (closed or open)",
  "plus a yaw angle in a versioned SaveGame record keyed by instance identity derived from the",
  "placed actor name when no explicit id is set. The leaf blocks passage when closed and passes",
  "when open. Opening is ~104cm wide, ~214cm tall including frame; wall depth ~24cm. Emit exactly",
  "one valid JSON object and nothing else. provenance.authoredBy must be \"model\".",
  SCHEMA_DOC,
].join("\n");

try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== "VERIFIED") throw new Error("POLICY_NOT_VERIFIED");
  const catalog = await adapter.listModels();
  const entry = catalog.find((m) => m.modelId === PRIMARY && m.isFree);
  if (!entry) throw new Error("MODEL_NOT_IN_FREE_CATALOG");
  report.catalogEntry = entry;

  const user = "Produce the BuildingModuleContract for this door module. moduleId: dtw/building/door-western/v1. Include one socket named \"frame\" at the doorway origin that accepts wall modules. Engines: unreal [\"4.27\"], blender [\"4.5\"]. provenance.modelId: the model id you are.";
  let text = await call([{ role: "system", content: system }, { role: "user", content: user }], 1);
  let parsed = parseModuleContractFromText(text);
  report.attempts.push({ attempt: 1, raw: text, parsed: parsed.ok ? "valid" : parsed.error });
  if (!parsed.ok) {
    const repair = `Your previous output failed validation: ${parsed.error}. Emit the corrected JSON object only.`;
    text = await call([{ role: "system", content: system }, { role: "user", content: user }, { role: "assistant", content: text }, { role: "user", content: repair }], 2);
    parsed = parseModuleContractFromText(text);
    report.attempts.push({ attempt: 2, raw: text, parsed: parsed.ok ? "valid" : parsed.error });
  }
  if (parsed.ok) {
    report.contract = parsed.contract;
    report.status = "MODEL_CONTRACT_VALID";
  } else {
    report.contract = FALLBACK();
    report.status = "DETERMINISTIC_FALLBACK";
    report.fallbackReason = report.attempts.at(-1).parsed;
  }
} catch (e) {
  report.contract = FALLBACK();
  report.status = "DETERMINISTIC_FALLBACK";
  report.fallbackReason = e instanceof Error ? e.message : String(e);
}
await mkdir("benchmarks/r81/module-contracts", { recursive: true });
await writeFile(CONTRACT_FILE, JSON.stringify(report.contract, null, 2));
report.contractFile = CONTRACT_FILE;
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, status: report.status, requests: report.frames.length, contractFile: CONTRACT_FILE, error: report.fallbackReason }));

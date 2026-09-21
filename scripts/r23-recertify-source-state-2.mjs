// R23 recertification #2 of the ForgeGreen certified source state.
//
// The R23 continuation changed one material file, packages/agent/src/index.ts: the coder role
// system prompt unconditionally instructed `run_command`, while the run lease may withhold
// executeCommand — a prompt/tool-contract contradiction that manufactures provider-side
// tool-validation rejections and authority-boundary stops (R23 F15). The rule now conditions
// run_command on it being advertised to the model. No ForgeGreen optimization candidate,
// verification-evidence-reuse advisor, FG-12F cost gate, or ForgeVerify validity authority
// changed; prior campaign evidence remains historically accurate for its recorded source state.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");
const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));

const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = ["packages/agent/src/index.ts"];
if (changed.length !== expectedChangedFiles.length || changed.some((file) => !expectedChangedFiles.includes(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${changed.join(", ")}`);
}

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "r23-prompt-tool-contract-v1";

const changeNotes = {
  "packages/agent/src/index.ts":
    "One reviewed change on the role-prompt surface, none in ForgeGreen policy or ForgeVerify authority: the coder systemPromptTemplate's rule 4 instructed `run_command` unconditionally even though a run lease may withhold executeCommand (in which case the tool is filtered out of request.tools). A model following its own prompt then emitted a call the provider rejected as malformed (tool_use_failed) or the runtime denied at the authority boundary — CodeForge-induced failures, not model failures, observed terminating four OR prescreen candidates after correct fixes. Rule 4 now reads: 'If run_command is among the tools advertised to you, run targeted tests with it to verify your work before concluding; if it is not advertised to you, do not call it — state the verification you would run.' A prompt↔registry contract test (packages/tools/test/prompt-tool-contract.test.ts) pins every tool-shaped name in role prompts to the registry and forbids unconditional instruction of permission-gated tools. Completion gate, ForgeVerify dispatch, verification-evidence reuse, ForgeGreen ledger persistence and the FG-12F cost gate are untouched.",
};

doc.recertifications.push({
  label: "R23 prompt/tool-contract coherence (coder run_command instruction)",
  reason:
    "The R23 free-supply campaign found that the coder role prompt instructed run_command under leases that withhold it, teaching the model to emit calls that cannot succeed (provider-side tool_use_failed rejections or runtime authority-boundary stops). The prompt now conditions the instruction on the tool being advertised. ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate and ForgeVerify validity authority are unchanged; prior campaign evidence remains historically accurate for its recorded source state. This entry records the reviewed drift rather than rewriting it.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "packages/tools/test/prompt-tool-contract.test.ts (new, 4 tests: every tool-shaped name in role prompts is registered; coder prompt never unconditionally instructs a permission-gated tool; read-only roles name no mutating tools; denied permission really excludes the gated tool) — green. packages/tools/test/role-boundary.test.ts and the structured-output security suite unchanged and green; security boundary (no unauthorized tool execution) untouched — the change is prompt text only.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R23_PROMPT_TOOL_CONTRACT_SOURCE_STATE",
});

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the R23 prompt/tool-contract coherence fix above.`;
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorId}\nnew  =${sourceStateId}`);

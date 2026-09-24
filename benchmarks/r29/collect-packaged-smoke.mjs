import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const input = path.join(repoRoot, "apps/desktop/release/smoke-result.log");
const output = path.join(repoRoot, "docs/evidence/r29-release-closure/08-ipc-security/packaged-smoke-receipt.json");
const lines = fs.readFileSync(input, "utf8").split(/\r?\n/);
if (lines.some((line) => line.includes("CF_SECRET_"))) throw new Error("Smoke output contains a synthetic credential marker");

const required = {
  full: ["PACKAGED_FULL_SMOKE_OK", "control_plane_trust_boundary=PASS", "packaged_renderer_lifecycle_chain=PASS", "packaged_zero_prompt_workflow=PASS", "packaged_settings_roundtrip=PASS", "packaged_extensions_loaded=PASS", "packaged_extension_lifecycle=PASS", "packaged_updater_check=PASS"],
  interrupt: ["PACKAGED_INTERRUPT_EXPECTED_EXIT", "electron_restart_interruption_ready=PASS"],
  recover: ["PACKAGED_RECOVERY_SMOKE_OK", "electron_restart_failed_safely=PASS", "electron_restart_no_approval_replay=PASS", "corrupt_credential_fails_closed=PASS", "credential_restart_decrypt=PASS"],
};
const allowedMarker = /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)=PASS$/;
const runs = [];
let current;
for (const line of lines) {
  if (line.startsWith("smoke_mode=")) {
    const mode = line.slice("smoke_mode=".length);
    if (!(mode in required)) throw new Error(`Unexpected smoke mode: ${mode}`);
    current = { mode, runId: "", markers: [] };
    runs.push(current);
  } else if (current && line.startsWith("smoke_run_id=")) {
    current.runId = line.slice("smoke_run_id=".length);
  } else if (current && (allowedMarker.test(line) || line.startsWith("PACKAGED_"))) {
    current.markers.push(line);
  }
}
if (runs.length !== 3 || runs.map((run) => run.mode).join(",") !== "full,interrupt,recover") {
  throw new Error("Expected exactly the full, interrupt, recover smoke sequence");
}
for (const run of runs) {
  if (!run.runId || required[run.mode].some((marker) => !run.markers.includes(marker))) {
    throw new Error(`Incomplete ${run.mode} smoke evidence`);
  }
  run.requiredMarkers = required[run.mode];
  run.markerCount = run.markers.length;
  delete run.markers;
}
const receipt = {
  schemaVersion: 1,
  packageBuildCommit: "0dbca660ba721b7cde5bcd6bd6d7cbbb01e600f7",
  execution: "outside command sandbox; Electron renderer launch blocked inside command sandbox",
  modes: runs,
  result: "PASS",
  scope: "Packaged smoke markers; no claim of hostile IPC fuzzing, installer lifecycle, or signed update round trip",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ result: receipt.result, modes: runs.map(({ mode, markerCount }) => ({ mode, markerCount })) }));

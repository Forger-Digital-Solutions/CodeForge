import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const releaseRoot = resolve(desktopRoot, "release");
const smokeScript = resolve(scriptDirectory, "packaged-smoke.js");
const executable = resolve(releaseRoot, "win-unpacked", "CodeForge.exe");
const evidenceRoot = resolve(releaseRoot, "r1-ui-evidence");
const resultLog = resolve(releaseRoot, "r1-ui-result.log");
const reportPath = resolve(releaseRoot, "r1-ui-certification.json");

export const R1_CERTIFICATION_STATUS = Object.freeze({
  PRODUCT_PASS: "PRODUCT_PASS",
  PRODUCT_FAIL: "PRODUCT_FAIL",
  HARNESS_PASS: "HARNESS_PASS",
  HARNESS_FAIL: "HARNESS_FAIL",
  EXTERNAL_EVIDENCE_AVAILABLE: "EXTERNAL_EVIDENCE_AVAILABLE",
  EXTERNAL_EVIDENCE_UNAVAILABLE: "EXTERNAL_EVIDENCE_UNAVAILABLE",
  USER_AUTHORIZATION_REQUIRED: "USER_AUTHORIZATION_REQUIRED",
});

const modeMarkers = Object.freeze({
  r1: [
    "CODEFORGE_UI_AUTH_R1_HARNESS_PASS",
    "r1.signed_out=PASS",
    "r1.idle=PASS",
    "r1.model_picker=PASS",
    "r1.active_run=PASS",
    "r1.tool_activity=PASS",
    "r1.approval=PASS",
    "r1.queue_steer=PASS",
    "r1.completed=PASS",
    "r1.failure=PASS",
    "r1.size_matrix=PASS",
    "r1.security=PASS",
  ],
  "r1-restart": ["CODEFORGE_UI_AUTH_R1_RESTART_PASS", "r1.window_restore=PASS"],
  "r1-account": ["CODEFORGE_UI_AUTH_R1_HARNESS_PASS", "r1.signed_in_fixture=PASS"],
});

export function classifyR1Evidence({ mode, log, exitCode }) {
  const markers = modeMarkers[mode] ?? [];
  const markersPresent = markers.filter((marker) => log.includes(marker));
  const hasHarnessFailure = log.includes("PACKAGED_SMOKE_FAILED") || log.includes("HARNESS_FAIL");
  const productStatus = markersPresent.length === markers.length && exitCode === 0
    ? R1_CERTIFICATION_STATUS.PRODUCT_PASS
    : R1_CERTIFICATION_STATUS.PRODUCT_FAIL;
  const harnessStatus = markersPresent.length === markers.length && !hasHarnessFailure && exitCode === 0
    ? R1_CERTIFICATION_STATUS.HARNESS_PASS
    : R1_CERTIFICATION_STATUS.HARNESS_FAIL;

  return {
    mode,
    exitCode,
    product: productStatus,
    harness: harnessStatus,
    markersExpected: markers,
    markersPresent,
    markersMissing: markers.filter((marker) => !log.includes(marker)),
  };
}

function runMode(mode) {
  const result = spawnSync(process.execPath, [smokeScript, mode], {
    cwd: desktopRoot,
    env: { ...process.env, CODEFORGE_SMOKE_EXECUTABLE: executable },
    stdio: "inherit",
    windowsHide: true,
  });
  const modeLog = existsSync(resultLog) ? readFileSync(resultLog, "utf8") : "";
  const modeReport = classifyR1Evidence({
    mode,
    log: modeLog,
    exitCode: result.status ?? 1,
  });
  writeFileSync(resolve(evidenceRoot, `${mode}.result.log`), modeLog, "utf8");
  if (result.error) throw result.error;
  if (result.status !== 0) return modeReport;
  return modeReport;
}

if (!existsSync(executable)) {
  console.error(`[R1] Packaged executable not found: ${executable}`);
  console.error("Build the packaged desktop app before running R1 certification.");
  process.exit(1);
}

mkdirSync(evidenceRoot, { recursive: true });
const modes = ["r1", "r1-restart", "r1-account"];
const modeReports = modes.map(runMode);
const productPass = modeReports.every((report) => report.product === R1_CERTIFICATION_STATUS.PRODUCT_PASS);
const harnessPass = modeReports.every((report) => report.harness === R1_CERTIFICATION_STATUS.HARNESS_PASS);
const report = {
  schemaVersion: "r1-certification-1",
  generatedAt: new Date().toISOString(),
  executable,
  evidenceRoot,
  modes: modeReports,
  classifications: {
    product: productPass ? R1_CERTIFICATION_STATUS.PRODUCT_PASS : R1_CERTIFICATION_STATUS.PRODUCT_FAIL,
    harness: harnessPass ? R1_CERTIFICATION_STATUS.HARNESS_PASS : R1_CERTIFICATION_STATUS.HARNESS_FAIL,
    external: R1_CERTIFICATION_STATUS.EXTERNAL_EVIDENCE_UNAVAILABLE,
    oauth: R1_CERTIFICATION_STATUS.USER_AUTHORIZATION_REQUIRED,
  },
  boundaries: {
    external: "No independent third-party native UI evidence was collected by this repository-owned harness.",
    oauth: "The app-owned account fixture was verified; real provider consent was not initiated or asserted.",
  },
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n[R1] Certification report: ${reportPath}`);
console.log(JSON.stringify(report.classifications, null, 2));
process.exit(productPass && harnessPass ? 0 : 1);

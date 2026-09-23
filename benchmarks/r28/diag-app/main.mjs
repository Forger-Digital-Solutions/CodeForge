// R28 diagnostics live check — Electron main-process harness.
// Drives the real built diagnostics module (initDiagnostics + logDiagnostic +
// writeDiagnosticBundle) with a hostile state summary containing planted
// secret-shaped keys and values, then verifies the on-disk bundle redacted
// every one of them. Also audits the real persistent log for leakage.
//
// Needles never appear in printed output — the console tee captures everything
// this process writes, so emitting a needle would self-poison the log.
//
//   node_modules/.bin/electron benchmarks/r28/diag-app
import electron from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const app = electron.app;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 160) : ""}`); };

const diagMod = await import(pathToFileURL(path.resolve("apps/desktop/dist/diagnostics.js")).href);
const { initDiagnostics, logDiagnostic, writeDiagnosticBundle, sanitizeDiagnosticValue, diagnosticsLogPath } = diagMod;

const NEEDLE = [
  "sk-live-AABBCCDDEEFF11223344",
  "sk-or-v1-aabbccddeeff00112233445566778899",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "hunter2",
  "-----BEGIN PRIVATE KEY-----ABC",
  "sk-ant-api03-zzzzzzzzzz",
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
];

app.whenReady().then(async () => {
  try {
    initDiagnostics();
    check("init_log_created", typeof diagnosticsLogPath === "function" && diagnosticsLogPath() && fs.existsSync(diagnosticsLogPath()));

    const PLANTED = {
      apiKey: NEEDLE[0],
      openrouter_api_key: NEEDLE[1],
      nested: { authorization: `Bearer ${NEEDLE[2]}.payload.sig`, github_token: NEEDLE[3] },
      deep: { session_secret: NEEDLE[4], credentials: { private_key: NEEDLE[5] } },
      innocentSecretValue: NEEDLE[6],
      hex40: NEEDLE[7],
      safe: "ordinary value",
    };

    const sanitizedJson = JSON.stringify(sanitizeDiagnosticValue(PLANTED));
    for (let i = 0; i < NEEDLE.length; i++) {
      check(`sanitizer_catches:planted_${i}`, !sanitizedJson.includes(NEEDLE[i]));
    }
    check("sanitizer_keeps_safe", sanitizedJson.includes("ordinary value"));

    console.log(`probe line ${NEEDLE[0]} bearer Bearer ${NEEDLE[2]}.x`);
    logDiagnostic("info", "r28_probe", PLANTED);

    const bundle = writeDiagnosticBundle({
      runtimeStatus: { running: false, port: 0 },
      connections: [{ providerId: "openrouter", connected: true, credentialSource: "environment", supplyClass: "free_api", authState: "ok", freeRouteCount: 12, healthyRouteCount: 1 }],
      plantedSecrets: PLANTED,
    });
    check("bundle_written", bundle.ok === true && typeof bundle.path === "string" && fs.existsSync(bundle.path));

    if (bundle.ok) {
      const raw = fs.readFileSync(bundle.path, "utf8");
      const parsed = JSON.parse(raw);
      check("bundle_shape", parsed.kind === "codeforge-diagnostic-bundle" && typeof parsed.generatedAt === "string" && Array.isArray(parsed.logTail), `${parsed.logTail?.length ?? 0} tail lines`);
      // The log tail legitimately contains this harness's own PASS/FAIL lines —
      // none of which carry needle text by construction.
      for (let i = 0; i < NEEDLE.length; i++) {
        check(`bundle_redacts:planted_${i}`, !raw.includes(NEEDLE[i]));
      }
      check("bundle_state_present", raw.includes('"openrouter"') && raw.includes("freeRouteCount"), "connection summary retained");
    }

    const logPath = diagnosticsLogPath();
    if (logPath && fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, "utf8");
      check("log_captured_probe", raw.includes("r28_probe"), `${raw.split(/\r?\n/).filter(Boolean).length} lines`);
      for (let i = 0; i < NEEDLE.length; i++) {
        check(`log_redacts:planted_${i}`, !raw.includes(NEEDLE[i]));
      }
    } else {
      check("log_captured_probe", false, "no log file");
    }
  } catch (error) {
    check("harness_completed", false, error instanceof Error ? error.message : String(error));
  }

  const failures = results.filter((r) => !r.ok);
  const report = { schema: "r28-diagnostics-live-1", at: new Date().toISOString(), checks: results, pass: results.length - failures.length, total: results.length, failures: failures.map((f) => f.name) };
  fs.writeFileSync("docs/evidence/r28-capability-completion/R28-DIAGNOSTICS-LIVE-EVIDENCE.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(`DIAGNOSTICS_LIVE_CHECK ${report.pass}/${report.total} ${failures.length ? "FAIL" : "PASS"}`);
  app.exit(failures.length ? 1 : 0);
});

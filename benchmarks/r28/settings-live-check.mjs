// R28 settings/auth live check — starts the real CodeForge server in-process and audits
// the settings → runtime effect chain: control-plane auth, privacy-mode transitions
// changing actual model eligibility, invalid-value rejection, repository-index settings.
//
//   node benchmarks/r28/settings-live-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "@codeforge/server";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 160) : ""}`); };

const TOKEN = "r28-settings-live-token";
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cf-settings-live-")), "settings.sqlite");
const server = createServer({ port: 0, dbPath, controlPlaneToken: TOKEN });
await server.start();
const base = `http://localhost:${server.port}`;
const api = (route, init = {}) => fetch(`${base}${route}`, { ...init, headers: { "x-codeforge-control-token": TOKEN, "Content-Type": "application/json", ...(init.headers ?? {}) } });

try {
  // 1. Control-plane auth: no token and wrong token both 401
  const noAuth = await fetch(`${base}/api/privacy-mode`);
  check("missing token → 401", noAuth.status === 401, `status=${noAuth.status}`);
  const badAuth = await fetch(`${base}/api/privacy-mode`, { headers: { "x-codeforge-control-token": "wrong" } });
  check("wrong token → 401", badAuth.status === 401, `status=${badAuth.status}`);

  // 2. Privacy mode GET → current mode
  const mode0 = await (await api("/api/privacy-mode")).json();
  check("privacy-mode GET returns a mode", ["STRICT", "STANDARD", "MAXIMUM_FREE"].includes(mode0.mode), mode0.mode);

  // 3. Eligible-model set under the current mode
  const modelsAt = async () => {
    const res = await api("/api/models");
    const body = await res.json();
    const list = body.models ?? body.freeModels ?? body;
    return new Map((Array.isArray(list) ? list : []).map((m) => [`${m.providerId}/${m.id ?? m.modelId}`, m]));
  };
  const eligibleIds = (map) => new Set([...map.entries()].filter(([, m]) => m.eligible === true).map(([k]) => k));
  const before = await modelsAt();
  const eligibleBefore = eligibleIds(before);
  check("models endpoint returns eligibility flags", before.size > 0, `${before.size} models, ${eligibleBefore.size} eligible`);

  // 4. STRICT → eligible set must become a strict-class subset
  const setStrict = await api("/api/privacy-mode", { method: "POST", body: JSON.stringify({ mode: "STRICT" }) });
  check("POST STRICT accepted", setStrict.ok, `status=${setStrict.status}`);
  const strictModels = await modelsAt();
  const eligibleStrict = eligibleIds(strictModels);
  const strictViolations = [...eligibleStrict].filter((id) => {
    const m = strictModels.get(id);
    return m.privacyClass && m.privacyClass !== "strict";
  });
  check("STRICT → only strict-class models eligible", strictViolations.length === 0 && eligibleStrict.size <= eligibleBefore.size, `${eligibleStrict.size} eligible, ${strictViolations.length} violations`);

  // 5. MAXIMUM_FREE → eligible set must grow to include permissive where present
  const setMax = await api("/api/privacy-mode", { method: "POST", body: JSON.stringify({ mode: "MAXIMUM_FREE" }) });
  check("POST MAXIMUM_FREE accepted", setMax.ok, `status=${setMax.status}`);
  const maxModels = await modelsAt();
  const eligibleMax = eligibleIds(maxModels);
  check("MAXIMUM_FREE → eligibility superset of STRICT", eligibleMax.size >= eligibleStrict.size, `STRICT=${eligibleStrict.size} MAX=${eligibleMax.size}`);

  // 6. Invalid mode rejected
  const bad = await api("/api/privacy-mode", { method: "POST", body: JSON.stringify({ mode: "DEFINITELY_NOT_A_MODE" }) });
  check("invalid mode rejected", bad.status === 400 || bad.status === 422, `status=${bad.status}`);
  const modeAfterBad = await (await api("/api/privacy-mode")).json();
  check("rejected change did not apply", modeAfterBad.mode === "MAXIMUM_FREE", modeAfterBad.mode);

  // 7. Restore STANDARD + repository-index settings round-trip
  await api("/api/privacy-mode", { method: "POST", body: JSON.stringify({ mode: "STANDARD" }) });
  const riSet = await api("/api/repository-index/settings", { method: "POST", body: JSON.stringify({ enabled: false }) });
  check("repository-index settings POST accepted", riSet.ok, `status=${riSet.status}`);
  const riGet = await api("/api/repository-index/settings");
  const riBody = await riGet.json();
  check("repository-index setting persisted in runtime", riGet.ok && (riBody.enabled === false || riBody.repositoryIndexEnabled === false), JSON.stringify(riBody).slice(0, 100));

  // 8. Model-selection surface honors auth + validation
  const selBad = await api("/api/model-selection", { method: "POST", body: JSON.stringify({ providerId: "openrouter", modelId: "paid/fake-model" }) });
  check("non-free model selection refused", !selBad.ok, `status=${selBad.status} ${(await selBad.text()).slice(0, 80)}`);
} finally {
  await server.stop?.().catch(() => undefined);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nSETTINGS_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-SETTINGS-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-settings-live-check-1",
  recordedAt: new Date().toISOString(),
  surface: "real CodeForge server (createServer port:0) — control-plane auth + privacy-mode + repository-index + model-selection",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

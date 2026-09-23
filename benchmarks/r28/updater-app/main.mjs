// R28 updater live check — Electron main-process harness.
// Serves a localhost update feed (latest.yml + artifact) and drives the real
// electron-updater state machine: check → metadata → sha512-verified download.
// Also proves tampered metadata and dead feeds fail honestly.
//
//   node_modules/.bin/electron benchmarks/r28/updater-app
import electron from "electron";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const app = electron.app;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 140) : ""}`); };

function yamlFor(version, file, sha512, size) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
}

async function main() {
  if (!app) throw new Error("electron app API unavailable — run under the electron binary");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cf-updater-feed-"));
  const artifact = path.join(scratch, "CodeForge-Setup-9.9.9.exe");
  const artifactBytes = Buffer.concat([crypto.randomBytes(64 * 1024), Buffer.from("CF-UPDATER-TEST-ARTIFACT"), crypto.randomBytes(64 * 1024)]);
  fs.writeFileSync(artifact, artifactBytes);
  const goodSha = crypto.createHash("sha512").update(artifactBytes).digest("base64");
  const badSha = crypto.createHash("sha512").update("not-the-artifact").digest("base64");

  const goodYml = yamlFor("9.9.9", "CodeForge-Setup-9.9.9.exe", goodSha, artifactBytes.length);
  const badYml = yamlFor("9.9.9", "CodeForge-Setup-9.9.9.exe", badSha, artifactBytes.length);
  let serveYml = goodYml;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/latest.yml") { res.setHeader("content-type", "text/yaml"); res.end(serveYml); return; }
    if (pathname === "/CodeForge-Setup-9.9.9.exe") { res.setHeader("content-type", "application/octet-stream"); res.end(artifactBytes); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const feed = `http://127.0.0.1:${server.address().port}`;

  process.env.CODEFORGE_UPDATER_FORCE_DEV = "1";
  process.env.CODEFORGE_UPDATE_FEED = feed;
  fs.writeFileSync(path.resolve("benchmarks/r28/updater-app/dev-app-update.yml"), `provider: generic\nurl: ${feed}\nchannel: latest\n`);
  const updaterUrl = pathToFileURL(path.resolve("apps/desktop/dist/updater.js")).href;
  const { checkForUpdates, downloadUpdate, getUpdaterStatus, __resetUpdaterForTest } = await import(updaterUrl);

  await app.whenReady();

  const st0 = getUpdaterStatus();
  check("status surface", st0.state === "idle" && st0.currentVersion === app.getVersion(), JSON.stringify(st0));

  const s1 = await checkForUpdates();
  check("check → update available", s1.state === "available" && s1.availableVersion === "9.9.9", JSON.stringify(s1).slice(0, 160));

  const s2 = await downloadUpdate();
  const downloadedOk = s2.state === "downloaded" && s2.downloadedPath && fs.existsSync(s2.downloadedPath);
  check("download → sha512 verified + file staged", downloadedOk, `${s2.state} ${s2.downloadedPath ?? s2.error ?? ""}`);

  // Manifest whose sha512 does not match the artifact: refetch then download.
  serveYml = badYml;
  const s3a = await checkForUpdates();
  const s3 = await downloadUpdate().catch((e) => ({ state: "error", error: e.message }));
  check("tampered sha512 → honest failure", s3.state === "error", `check=${s3a.state} download=${JSON.stringify(s3).slice(0, 120)}`);

  // Dead feed: reset the module so the new env feed is applied, then check.
  process.env.CODEFORGE_UPDATE_FEED = "http://127.0.0.1:59999/dead";
  __resetUpdaterForTest();
  const s4 = await checkForUpdates().catch((e) => ({ state: "error", error: e.message }));
  check("dead feed → honest error", s4.state === "error" || s4.state === "unavailable", JSON.stringify(s4).slice(0, 140));

  server.close();
  fs.rmSync(path.resolve("benchmarks/r28/updater-app/dev-app-update.yml"), { force: true });
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nUPDATER_LIVE_CHECK ${passed}/${results.length} PASS`);
  fs.writeFileSync("docs/evidence/r28-capability-completion/R28-UPDATER-LIVE-EVIDENCE.json", JSON.stringify({ schema: "r28-updater-live-check-1", recordedAt: new Date().toISOString(), feed: "localhost generic provider", results }, null, 2) + "\n");
  app.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("harness fatal:", e); (app ?? process).exit(2); });

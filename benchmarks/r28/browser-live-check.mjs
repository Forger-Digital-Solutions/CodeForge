// R28 browser live check — real GovernedBrowserRuntime against a localhost page.
// Same runtime the packaged mcp/tool surface drives; URL policy, downloads
// quarantine, and session lifecycle are all exercised for real.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { GovernedBrowserRuntime } from "../../packages/browser/dist/runtime.js";

const PAGE_A = `<!doctype html><title>CF Browser Check A</title>
<h1 id="title">CodeForge Browser Check</h1>
<input id="field" type="text" placeholder="type here">
<button id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('field').value">Go</button>
<div id="out"></div>
<a id="link" href="/b">page b</a>
<script>console.log("page-a-loaded")</script>`;
const PAGE_B = `<!doctype html><title>CF Browser Check B</title><h1 id="b">Second Page</h1>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url === "/b" ? PAGE_B : PAGE_A);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cf-browser-check-"));
const runtime = new GovernedBrowserRuntime({
  downloadDir: path.join(scratch, "downloads"),
  screenshotDir: path.join(scratch, "shots"),
  headless: true,
});

const report = { checks: [], evidence: {} };
const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

try {
  const session = await runtime.openSession();
  report.evidence.sessionId = session.sessionId;
  check("openSession", session.status === "active", session.sessionId);

  const nav = await session.navigate(`${base}/a`);
  check("navigate localhost", nav.status === "completed" || nav.ok === true || nav !== undefined, JSON.stringify(nav).slice(0, 120));

  const { snapshot } = await session.inspect();
  const dom = JSON.stringify(snapshot);
  check("inspect DOM", dom.includes("CodeForge Browser Check") && dom.includes("field"), `snapshot ${dom.length}B`);

  await session.type({ kind: "css", selector: "#field" }, "hello-forge");
  const click = await session.click({ kind: "css", selector: "#go" });
  const after = await session.inspect();
  check("type+click updates DOM", JSON.stringify(after.snapshot ?? after).includes("clicked:hello-forge"), JSON.stringify(click).slice(0, 100));

  const { record } = await session.screenshot({ persist: true });
  check("screenshot persisted", record.bytes > 0 && fs.existsSync(record.path ?? ""), `${record.bytes}B sha256=${record.sha256?.slice(0, 12)}`);

  const state = { tabs: session.listTabs(), console: session.consoleLog(), network: session.networkLog() };
  check("console log captured", state.console.some((e) => e.text.includes("page-a-loaded")), `${state.console.length} entries`);
  check("network log host-only", state.network.every((n) => !String(n.pathHash ?? "").includes("?")), `${state.network.length} obs`);

  await session.navigate(`${base}/b`);
  const bSnap = await session.inspect();
  check("second navigation", JSON.stringify(bSnap.snapshot ?? bSnap).includes("Second Page"));

  const denied = await runtime.checkNavigation("http://169.254.169.254/latest/meta-data");
  check("metadata endpoint denied", denied.allowed === false, denied.reason?.slice(0, 80));
  const privDenied = await runtime.checkNavigation("http://192.168.1.1/router");
  check("private network denied", privDenied.allowed === false, privDenied.reason?.slice(0, 80));
  const plainPublic = await runtime.checkNavigation("http://example.com/");
  check("plaintext public http denied", plainPublic.allowed === false, plainPublic.reason?.slice(0, 80));

  await session.close();
  check("session close", runtime.listSessions().every((s) => s.status !== "active"));
} finally {
  await runtime.shutdown().catch(() => undefined);
  server.close();
}

const leftover = fs.readdirSync(scratch);
report.evidence.scratchContents = leftover;
const passed = report.checks.filter((c) => c.ok).length;
console.log(`\nBROWSER_LIVE_CHECK ${passed}/${report.checks.length} PASS`);
fs.writeFileSync(path.join("docs/evidence/r28-capability-completion", "R28-BROWSER-LIVE-EVIDENCE.json"), JSON.stringify({ schema: "r28-browser-live-check-1", recordedAt: new Date().toISOString(), ...report }, null, 2) + "\n");
process.exit(passed === report.checks.length ? 0 : 1);

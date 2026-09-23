// R28 permissions-penetration live check — drives the real ToolBroker with hostile
// contexts and inputs. Every denied case must fail closed with the documented error
// code; every positive control must actually execute.
//
//   node benchmarks/r28/permissions-live-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolBroker } from "@codeforge/tools";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cf-perm-ws-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-perm-out-"));
fs.writeFileSync(path.join(ws, "innocent.txt"), "hello workspace\n");
fs.writeFileSync(path.join(ws, ".env"), "OPENROUTER_API_KEY=should-never-read\n");
fs.writeFileSync(path.join(outside, "outside-secret.txt"), "OUTSIDE\n");
fs.mkdirSync(path.join(ws, "sub"));
try { fs.symlinkSync(outside, path.join(ws, "escape-link"), "junction"); } catch { /* best effort */ }

const broker = new ToolBroker();
const perms = (over) => ({ read: true, search: true, write: false, executeCommand: false, network: false, ...over });
const ctx = (role, p) => ({ workspacePath: ws, role, permissions: perms(p) });
const denied = (rec, code) => !rec.success && rec.error === code;

// ---- Role ceiling: read-only roles vs mutating tools --------------------------------
for (const role of ["explorer", "reviewer", "planner", "replanner"]) {
  const w = await broker.executeTool({ name: "write_file", arguments: { path: "x.txt", content: "x" } }, ctx(role, { write: true, executeCommand: true, network: true }));
  check(`${role}: write_file denied despite granted perms`, denied(w, "TOOL_PERMISSION_DENIED"), w.error);
  const r = await broker.executeTool({ name: "run_command", arguments: { command: "echo hi" } }, ctx(role, { executeCommand: true }));
  check(`${role}: run_command denied`, denied(r, "TOOL_PERMISSION_DENIED"), r.error);
}

// ---- Permission ceiling: mutating role lacking the specific permission --------------
const coderNoWrite = await broker.executeTool({ name: "write_file", arguments: { path: "x.txt", content: "x" } }, ctx("coder"));
check("coder without write perm → denied", denied(coderNoWrite, "TOOL_PERMISSION_DENIED"), coderNoWrite.error);
const coderNoExec = await broker.executeTool({ name: "run_command", arguments: { command: "echo hi" } }, ctx("coder", { write: true }));
check("coder without executeCommand → denied", denied(coderNoExec, "TOOL_PERMISSION_DENIED"), coderNoExec.error);

// ---- Workspace confinement -----------------------------------------------------------
const coderFull = ctx("coder", { write: true, executeCommand: true, network: true });
for (const p of ["../outside-secret.txt", "..\\..\\outside-secret.txt", path.join(outside, "outside-secret.txt"), "sub/../../outside-secret.txt", "//server/share/x"]) {
  const rec = await broker.executeTool({ name: "read_file", arguments: { path: p } }, coderFull);
  check(`read_file escape ${JSON.stringify(p.slice(0, 40))} → denied`, !rec.success && /ESCAPE|denied|traversal/i.test(rec.error + rec.output), rec.error);
}
const wEscape = await broker.executeTool({ name: "write_file", arguments: { path: "../evil.txt", content: "x" } }, coderFull);
check("write_file escape → denied", !wEscape.success, wEscape.error);
const cwdEscape = await broker.executeTool({ name: "run_command", arguments: { command: "echo hi", cwd: "../.." } }, coderFull);
check("run_command cwd escape → denied", !cwdEscape.success, cwdEscape.error);
if (fs.existsSync(path.join(ws, "escape-link"))) {
  const sym = await broker.executeTool({ name: "read_file", arguments: { path: "escape-link/outside-secret.txt" } }, coderFull);
  check("symlink escape → denied", !sym.success && /symlink|escape|denied|traversal/i.test(sym.error + sym.output), sym.error);
}

// ---- Sensitive-path denylist ----------------------------------------------------------
for (const p of [".env", ".env.local", "sub/../.env", "credentials.json", "id_rsa", "server.pem"]) {
  const rec = await broker.executeTool({ name: "read_file", arguments: { path: p } }, coderFull);
  check(`sensitive read ${p} → denied`, denied(rec, "TOOL_SENSITIVE_PATH_DENIED"), rec.error);
}
const wEnv = await broker.executeTool({ name: "write_file", arguments: { path: ".env.production", content: "x" } }, coderFull);
check("sensitive write .env.production → denied", denied(wEnv, "TOOL_SENSITIVE_PATH_DENIED"), wEnv.error);

// ---- Tool-registry integrity ----------------------------------------------------------
const unknown = await broker.executeTool({ name: "definitely_not_a_tool", arguments: {} }, coderFull);
check("unknown tool → TOOL_UNKNOWN", denied(unknown, "TOOL_UNKNOWN"), unknown.error);
const badJson = await broker.executeTool({ name: "read_file", arguments: "{not json" }, ctx("explorer"));
check("malformed JSON args → TOOL_ARGUMENT_INVALID", denied(badJson, "TOOL_ARGUMENT_INVALID"), badJson.error);
const missingArg = await broker.executeTool({ name: "read_file", arguments: {} }, ctx("explorer"));
check("missing required arg → TOOL_ARGUMENT_INVALID", denied(missingArg, "TOOL_ARGUMENT_INVALID"), missingArg.error);

// ---- Positive controls (the same broker must still work) ------------------------------
const okRead = await broker.executeTool({ name: "read_file", arguments: { path: "innocent.txt" } }, ctx("explorer"));
check("explorer read_file inside ws → works", okRead.success && okRead.output.includes("hello workspace"), okRead.output.slice(0, 60));
const okWrite = await broker.executeTool({ name: "write_file", arguments: { path: "sub/new.txt", content: "made by coder" } }, ctx("coder", { write: true }));
check("coder write_file inside ws → works", okWrite.success && fs.readFileSync(path.join(ws, "sub/new.txt"), "utf8") === "made by coder", okWrite.output.slice(0, 60));
const okCmd = await broker.executeTool({ name: "run_command", arguments: { command: "node -e \"console.log('cmd-ok')\"" } }, ctx("coder", { executeCommand: true }));
check("coder run_command inside ws → works", okCmd.success && okCmd.output.includes("cmd-ok"), okCmd.output.slice(0, 60));
const outsideClean = !fs.existsSync(path.join(outside, "evil.txt")) && !fs.existsSync(path.join(ws, "..", "evil.txt"));
check("no writes escaped the workspace", outsideClean && !fs.existsSync(path.join(os.tmpdir(), "evil.txt")), "");

const passed = results.filter((r) => r.ok).length;
console.log(`\nPERMISSIONS_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-PERMISSIONS-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-permissions-live-check-1",
  recordedAt: new Date().toISOString(),
  surface: "real ToolBroker.executeTool — role ceilings, permission flags, workspace/symlink confinement, sensitive-path denylist, registry integrity",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

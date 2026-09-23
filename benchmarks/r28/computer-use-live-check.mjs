// R28 computer-use live check — drives the real GovernedComputerRuntime against the
// Windows desktop backend (System.Drawing capture + user32 input injection).
//
//   node benchmarks/r28/computer-use-live-check.mjs
//
// Injection proof is bounded: cursor moves are verified by reading GetCursorPos back from
// the OS, and a lone SHIFT keypress exercises the SendInput path with zero side effects.
// Real click/type into a focused target requires a controlled session — recorded as a gap.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GovernedComputerRuntime } from "@codeforge/computer-use";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 140) : ""}`); };

function getCursorPos() {
  const out = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v); [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out System.Drawing.Point p);' -Name C -Namespace W -ReferencedAssemblies System.Drawing; [void][W.C]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4)); $p=New-Object System.Drawing.Point; [void][W.C]::GetCursorPos([ref]$p); \"$($p.X),$($p.Y)\"",
  ], { encoding: "utf8", timeout: 15000 }).trim();
  const [x, y] = out.split(",").map(Number);
  return { x, y };
}

const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-cu-live-"));
const rt = new GovernedComputerRuntime({ evidenceDir, policy: { minActionIntervalMs: 50 } });

const status = await rt.status();
check("status → supported + real bounds", status.supported === true && status.bounds?.width > 0 && status.bounds?.height > 0, JSON.stringify(status.bounds));

const shot = await rt.screenshot();
const png = fs.readFileSync(shot.path);
const isPng = png.length > 100 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
check("screenshot → real PNG persisted + hashed", isPng && shot.sha256.length === 64, `${png.length}B sha256=${shot.sha256.slice(0, 12)}… ${shot.bounds.width}x${shot.bounds.height}`);

// Real input injection: move the cursor to two points and read the OS cursor position back.
const target = { x: Math.round(status.bounds.x + status.bounds.width / 2), y: Math.round(status.bounds.y + status.bounds.height / 2) };
await rt.moveMouse(target.x, target.y);
await new Promise((r) => setTimeout(r, 150));
const pos1 = getCursorPos();
check("mouse move → OS cursor position verified", pos1.x === target.x && pos1.y === target.y, `target=(${target.x},${target.y}) actual=(${pos1.x},${pos1.y})`);

await new Promise((r) => setTimeout(r, 100));
const target2 = { x: target.x + 40, y: target.y + 40 };
await rt.moveMouse(target2.x, target2.y);
await new Promise((r) => setTimeout(r, 150));
const pos2 = getCursorPos();
check("second move → cursor tracked", pos2.x === target2.x && pos2.y === target2.y, `target=(${target2.x},${target2.y}) actual=(${pos2.x},${pos2.y})`);

// SendInput path: a lone SHIFT press has zero observable side effects but must complete.
await new Promise((r) => setTimeout(r, 100));
const keyReceipt = await rt.keyPress(["shift"]);
check("key press → SendInput path executed (shift, no side effect)", keyReceipt.action === "computer_key_press", keyReceipt.detail);

// Policy gates
await expectFail("out-of-bounds move rejected", () => rt.moveMouse(status.bounds.x + status.bounds.width + 500, 0), "COMPUTER_INVALID_TARGET");
await expectFail("unknown key rejected", () => rt.keyPress(["definitely-not-a-key"]), "COMPUTER_INVALID_KEY");
await expectFail("empty key list rejected", () => rt.keyPress([]), "COMPUTER_INVALID_KEY");
const tiny = new GovernedComputerRuntime({ evidenceDir, policy: { maxActionsPerSession: 1, minActionIntervalMs: 0 } });
await tiny.moveMouse(target.x, target.y);
await expectFail("session budget exhaustion", () => tiny.moveMouse(target.x, target.y), "COMPUTER_BUDGET_EXHAUSTED");

async function expectFail(name, fn, code) {
  try {
    await fn();
    check(name, false, "expected failure did not occur");
  } catch (e) {
    check(name, e.code === code, e.code ?? e.message);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nCOMPUTER_USE_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-COMPUTER-USE-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-computer-use-live-check-1",
  recordedAt: new Date().toISOString(),
  backend: "windows: System.Drawing capture + user32 SetCursorPos/mouse_event/SendInput",
  results,
  gap: "real click/type into a focused window requires a controlled session; move+keypress prove the injection pipeline",
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

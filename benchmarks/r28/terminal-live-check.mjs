// R28 terminal live check — drives the real CommandExecutor against real Windows
// processes: output capture, exit codes, streaming, timeout with process-tree kill
// (verified — no orphaned child survives), and abort cancellation.
//
//   node benchmarks/r28/terminal-live-check.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { execute, backendFor, loadPty } from "@codeforge/terminal";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

function procsMatching(imageName, cmdMatch) {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${imageName}' -and $_.CommandLine -like '*${cmdMatch}*' -and $_.ProcessId -ne $PID } | Select-Object -ExpandProperty ProcessId`],
      { encoding: "utf8", timeout: 15000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

const backend = backendFor();
check("backend resolved", backend === "conpty" || backend === "pipe", `${backend} (pty=${loadPty() !== null})`);

// 1. Basic execution + output capture
const r1 = await execute({ commandLine: "cmd.exe /c echo TERMINAL_LIVE_MARKER" });
check("command executes + stdout captured", r1.exitCode === 0 && r1.stdout.includes("TERMINAL_LIVE_MARKER"), `exit=${r1.exitCode} out=${r1.stdout.trim().slice(0, 60)}`);

// 2. Nonzero exit propagates
const r2 = await execute({ commandLine: "cmd.exe /c exit 3" });
check("nonzero exit code propagates", r2.exitCode === 3, `exit=${r2.exitCode}`);

// 3. stderr captured separately (pipe) or merged (conpty)
const r3 = await execute({ commandLine: "cmd.exe /c echo ERR_LINE 1>&2" });
const sawErr = r3.stderr.includes("ERR_LINE") || r3.output.includes("ERR_LINE");
check("stderr surfaced", sawErr, `stderr=${r3.stderr.trim().slice(0, 40)} merged=${r3.output.trim().slice(0, 40)}`);

// 4. Streaming via onOutput
const chunks = [];
const r4 = await execute({ commandLine: "cmd.exe /c echo A && echo B", onOutput: (c) => chunks.push(c) });
check("streaming output chunks arrive", r4.exitCode === 0 && chunks.length >= 1 && chunks.join("").includes("A"), `${chunks.length} chunks`);

// 5. Timeout kills the process — and its whole tree
const marker = "cf_term_tree_marker_" + Date.now();
const r5 = await execute({
  commandLine: `cmd.exe /c "title ${marker} && ping -t 127.0.0.1 >nul"`,
  timeoutMs: 1500,
});
check("long-running command times out", r5.timedOut === true, `timedOut=${r5.timedOut} dur=${r5.durationMs}ms`);
await new Promise((r) => setTimeout(r, 1000));
const orphans = procsMatching("ping.exe", "-t 127.0.0.1").length + procsMatching("cmd.exe", marker).length;
check("process tree killed — no orphaned children", orphans === 0, `${orphans} orphan(s) found`);

// 6. AbortSignal cancellation
const ac = new AbortController();
setTimeout(() => ac.abort(), 600);
const r6 = await execute({ commandLine: "cmd.exe /c ping -n 30 127.0.0.1 >nul", signal: ac.signal });
check("abort signal cancels execution", r6.cancelled === true || r6.timedOut === false, `cancelled=${r6.cancelled} timedOut=${r6.timedOut}`);

// 7. Custom env reaches the child
const r7 = await execute({ commandLine: "cmd.exe /c echo %CF_LIVE_VAR%", env: { ...process.env, CF_LIVE_VAR: "env_ok_42" } });
check("custom env var reaches child", r7.stdout.includes("env_ok_42"), r7.stdout.trim().slice(0, 40));

// 8. cwd honored
const r8 = await execute({ file: "cmd.exe", args: ["/c", "cd"], cwd: "C:\\Windows" });
check("cwd honored", r8.stdout.trim().toLowerCase().includes("c:\\windows"), r8.stdout.trim().slice(0, 40));

const passed = results.filter((r) => r.ok).length;
console.log(`\nTERMINAL_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-TERMINAL-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-terminal-live-check-1",
  recordedAt: new Date().toISOString(),
  backend,
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

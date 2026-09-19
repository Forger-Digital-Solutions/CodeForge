#!/usr/bin/env node
// Drive ONE real coding task through the installed app's real UI and record what the product did.
//
//   CDP_PORT=9229 node scenarios/agent-task.mjs <outDir> <projectPath> "<task text>" [--follow-up "<text>"] [--approve allow_once|allow_session|none] [--timeout-sec 900] [--new-task]
//
// The task is typed into the real composer and sent with Enter. Approvals are answered by clicking
// the real approval buttons (default: "Allow once"). Progress is observed through the renderer's
// own runtime access (bearer injected by the main process). At the end the fixture's own test
// command is run independently so "verification passed" is checked against reality.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openPage, evaluate, screenshot, clickText, clickSelector, pressKey, sleep, waitFor } from "../cdp-driver.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const has = (name) => args.includes(name);
const [outDir, projectPath, taskText] = args;
if (!outDir || !projectPath || !taskText) { console.error("usage: agent-task.mjs <outDir> <projectPath> <task> [--follow-up text] [--approve mode] [--timeout-sec n] [--new-task] [--verify-cmd cmd]"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const approveMode = flag("--approve", "allow_once");
const timeoutSec = Number(flag("--timeout-sec", "900"));
const followUp = flag("--follow-up", null);
const verifyCmd = flag("--verify-cmd", "npm test");
const label = flag("--label", "task");

const report = { label, projectPath, taskText, startedAt: new Date().toISOString(), screenshots: [], approvals: [], events: {}, timeline: [] };
const cdp = await openPage();
const consoleErrors = [];
await cdp.send("Log.enable");
cdp.on("Runtime.exceptionThrown", (p) => consoleErrors.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text || "").slice(0, 300)));
cdp.on("Log.entryAdded", (p) => { if (p.entry.level === "error") consoleErrors.push(p.entry.text.slice(0, 200)); });

const shot = async (name) => { const f = path.join(outDir, `${label}-${String(report.screenshots.length + 1).padStart(2, "0")}-${name}.png`); await screenshot(cdp, f); report.screenshots.push(path.basename(f)); return f; };
const mark = (event, extra = {}) => { report.timeline.push({ at: new Date().toISOString(), event, ...extra }); console.log(`${new Date().toISOString().slice(11, 19)} ${event} ${extra.detail ?? ""}`); };
const endpoint = await evaluate(cdp, "window.electronAPI.getRuntimeEndpoint()");
const api = async (p, init) => evaluate(cdp, `fetch(${JSON.stringify(endpoint + p)}, ${JSON.stringify(init ?? {})}).then(async (r) => ({ status: r.status, body: await r.text() }))`).then((r) => { try { return { status: r.status, body: JSON.parse(r.body) }; } catch { return r; } });

// 1. Make the project the active workspace, the way a relaunch restores the last workspace.
const current = await evaluate(cdp, "document.body.innerText");
const projectName = path.basename(projectPath);
if (!current.includes(projectName)) {
  await evaluate(cdp, `window.electronAPI.openProject(${JSON.stringify(projectPath)})`);
  await cdp.send("Page.reload");
  await sleep(2500);
  await waitFor(cdp, `document.documentElement.getAttribute('data-cf-lifecycle-workspace-interactive') !== null`, 30000, "workspace interactive");
  mark("workspace-opened", { detail: projectName });
}
if (has("--new-task")) {
  try { await clickText(cdp, "New task", "button"); await sleep(500); mark("new-task"); } catch (e) { mark("new-task-failed", { detail: e.message }); }
}
await shot("before");

// 2. Type the task into the real composer and send it with Enter.
await evaluate(cdp, `(() => { const el = document.querySelector('.composer-input'); el.focus(); return true; })()`);
await cdp.send("Input.insertText", { text: taskText });
await sleep(200);
const typed = await evaluate(cdp, "document.querySelector('.composer-input').value");
if (typed !== taskText) throw new Error(`composer did not accept the task text (got ${JSON.stringify(typed.slice(0, 60))})`);
await pressKey(cdp, "Enter", []);
mark("sent");
await sleep(1500);
await shot("sent");

// 3. Observe until the session settles.
const sessionId = await waitFor(cdp, `(() => { const a = document.querySelector('.nav-task.active'); return Boolean(a); })()`, 15000, "active session in sidebar").then(() => evaluate(cdp, `(async () => { const r = await fetch(${JSON.stringify(endpoint + "/api/sessions")}); const s = await r.json(); s.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); return s[0].id; })()`)).catch(() => null);
report.sessionId = sessionId;
mark("session", { detail: sessionId });
if (has("--no-wait")) {
  // Interruption scenarios (Stop, close-while-running, force-kill) take over from here.
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(`report: ${path.join(outDir, `${label}.json`)}`);
  cdp.close();
  process.exit(0);
}

const deadline = Date.now() + timeoutSec * 1000;
let lastPhaseShot = "";
let approvalsSeen = new Set();
let terminal = null;
while (Date.now() < deadline) {
  const snap = sessionId ? await api(`/api/sessions/${sessionId}`) : null;
  const body = snap?.body ?? {};
  const pending = body.pendingApprovals ?? [];
  for (const approval of pending) {
    if (approvalsSeen.has(approval.approvalId)) continue;
    approvalsSeen.add(approval.approvalId);
    report.approvals.push({ id: approval.approvalId, tool: approval.tool, action: approval.action, description: approval.description, risk: approval.risk, at: new Date().toISOString() });
    await shot(`approval-${report.approvals.length}`);
    mark("approval-requested", { detail: `${approval.tool} ${approval.action} (${approval.risk})` });
    if (approveMode === "none") continue;
    const label = approveMode === "allow_session" ? "Allow for this task" : "Allow once";
    try { await clickText(cdp, label, "button"); mark("approval-clicked", { detail: label }); }
    catch { try { await clickText(cdp, "Start now", "button"); mark("approval-clicked", { detail: "Start now" }); } catch (e) { mark("approval-click-failed", { detail: e.message }); } }
    await sleep(800);
  }
  const questions = body.pendingQuestions ?? [];
  if (questions.length > 0 && !report.questionSeen) { report.questionSeen = questions[0]; await shot("question"); mark("question", { detail: JSON.stringify(questions[0]).slice(0, 200) }); }
  const turns = body.turns ?? [];
  const running = turns.some((t) => ["running", "paused", "recovering", "waiting_for_approval", "waiting_for_question"].includes(t.status));
  const status = body.session?.status;
  const phaseText = await evaluate(cdp, `(() => { const p = document.querySelector('.workflow-progress, .task-progress, .phase-strip'); return p ? p.innerText.replace(/\\s+/g, ' ').slice(0, 120) : ''; })()`).catch(() => "");
  if (phaseText && phaseText !== lastPhaseShot) { lastPhaseShot = phaseText; await shot("progress"); mark("progress", { detail: phaseText }); }
  if (!running && turns.length > 0 && status && status !== "running") { terminal = { status, turns: turns.map((t) => ({ id: t.id, status: t.status, error: t.error ?? null })) }; break; }
  await sleep(2500);
}
await sleep(1500);
await shot("final");
report.terminal = terminal ?? { status: "TIMEOUT" };
mark("terminal", { detail: JSON.stringify(report.terminal.status) });

// 4. What did the product do? (from the persisted events — the same data the UI renders)
if (sessionId) {
  const snap = await api(`/api/sessions/${sessionId}`);
  const events = snap.body?.events ?? [];
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  report.events = byType;
  report.routing = events.filter((e) => e.type === "router.selection").map((e) => ({ providerId: e.payload?.providerId, modelId: e.payload?.modelId, reasons: e.payload?.reasons }));
  report.tools = events.filter((e) => e.type === "tool.call_started").map((e) => e.payload?.toolName);
  report.filesWritten = [...new Set(events.filter((e) => e.type === "file.written").map((e) => e.payload?.path))];
  report.commands = events.filter((e) => e.type === "command.executed").map((e) => ({ command: e.payload?.command, exitCode: e.payload?.exitCode }));
  report.verification = events.filter((e) => e.type === "workflow.verification_completed").map((e) => e.payload);
  report.completion = events.filter((e) => e.type === "workflow.completion_decided").map((e) => e.payload);
  report.assistantText = events.filter((e) => e.type === "assistant.message.completed").map((e) => (e.payload?.text ?? "").slice(0, 1200));
  report.turnErrors = (snap.body?.turns ?? []).filter((t) => t.error).map((t) => t.error.slice(0, 300));
  report.workItems = (snap.body?.workItems ?? []).map((w) => w.kind);
}
report.conversationText = (await evaluate(cdp, "(document.querySelector('.conversation, .conversation-scroll, main') || document.body).innerText")).slice(0, 6000);

// 5. Independent verification in the fixture.
const verify = spawnSync(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", verifyCmd] : ["-c", verifyCmd], { cwd: projectPath, encoding: "utf8", timeout: 120000 });
report.independentVerification = { command: verifyCmd, exitCode: verify.status, output: (verify.stdout + verify.stderr).slice(-1500) };
const diff = spawnSync("git", ["diff", "--stat"], { cwd: projectPath, encoding: "utf8" });
report.gitDiffStat = diff.stdout;
const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectPath, encoding: "utf8" });
report.gitStatus = status.stdout;

// 6. Optional follow-up in the same conversation.
if (followUp) {
  await evaluate(cdp, `(() => { const el = document.querySelector('.composer-input'); el.focus(); return true; })()`);
  await cdp.send("Input.insertText", { text: followUp });
  await pressKey(cdp, "Enter", []);
  mark("follow-up-sent");
  const d2 = Date.now() + timeoutSec * 1000;
  let done = false;
  while (Date.now() < d2) {
    const snap = await api(`/api/sessions/${sessionId}`);
    const body = snap?.body ?? {};
    for (const approval of body.pendingApprovals ?? []) {
      if (approvalsSeen.has(approval.approvalId)) continue;
      approvalsSeen.add(approval.approvalId);
      report.approvals.push({ id: approval.approvalId, tool: approval.tool, action: approval.action, followUp: true });
      try { await clickText(cdp, approveMode === "allow_session" ? "Allow for this task" : "Allow once", "button"); } catch { try { await clickText(cdp, "Start now", "button"); } catch {} }
      await sleep(800);
    }
    const turns = body.turns ?? [];
    const running = turns.some((t) => ["running", "paused", "recovering", "waiting_for_approval", "waiting_for_question"].includes(t.status));
    if (!running && turns.length > 1 && body.session?.status !== "running") { done = true; report.followUpTerminal = { status: body.session?.status, lastTurn: turns.at(-1)?.status, error: turns.at(-1)?.error ?? null }; break; }
    await sleep(2500);
  }
  if (!done) report.followUpTerminal = { status: "TIMEOUT" };
  await shot("follow-up-final");
  const snap = await api(`/api/sessions/${sessionId}`);
  report.followUpAssistantText = (snap.body?.events ?? []).filter((e) => e.type === "assistant.message.completed").map((e) => (e.payload?.text ?? "").slice(0, 800)).slice(-2);
}

report.consoleErrors = consoleErrors.slice(0, 20);
report.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(report, null, 2));
console.log(`report: ${path.join(outDir, `${label}.json`)}`);
cdp.close();

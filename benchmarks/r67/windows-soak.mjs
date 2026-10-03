import { spawn, execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import asar from '@electron/asar';
import { taskAt } from './fresh-tasks.mjs';

const execFile = promisify(callback);
const directory = path.resolve('docs/evidence/r67-everyday-completion-reliability');
const temporary = path.resolve('benchmarks/r67/tmp');
const exe = path.join(temporary, 'windows-package/win-unpacked/CodeForge.exe');
const archive = path.join(path.dirname(exe), 'resources/app.asar');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idleOnly = process.env.R67_WINDOWS_IDLE_ONLY === '1';
const profile = process.env.R67_WINDOWS_PROFILE ? path.resolve(process.env.R67_WINDOWS_PROFILE) : await mkdtemp(path.join(temporary, 'windows-profile-'));
const workspace = await mkdtemp(path.join(temporary, 'windows-public-'));
const task = taskAt(0);
for (const [file, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(workspace, file)), { recursive: true }); await writeFile(path.join(workspace, file), content); }
await writeFile(path.join(workspace, 'package.json'), '{"name":"r67-windows-public","type":"module","private":true}\n');
for (const args of [['init'], ['config', 'user.name', 'CodeForge Fixture'], ['config', 'user.email', 'fixture@codeforge.invalid'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'Public packaged fixture']]) await execFile('git', args, { cwd: workspace, windowsHide: true });
const server = net.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const output = { startedAt: new Date().toISOString(), status: 'RUNNING', evidenceClass: 'ACTUAL_PACKAGED_WINDOWS_NORMAL_STARTUP', profile, workspace, port, samples: [], tasks: [], restarts: [], limitations: [], identity: JSON.parse(asar.extractFile(archive, 'apps\\desktop\\dist\\build-identity.json').toString()), manifest: JSON.parse(asar.extractFile(archive, 'apps\\desktop\\dist\\cloud-endpoints.json').toString()) };
const evidenceName = process.argv[2] ?? 'R67-WINDOWS-SOAK.json';
if (!/^R67-WINDOWS-[A-Z-]+\.json$/.test(evidenceName)) throw new Error('WINDOWS_EVIDENCE_NAME_REQUIRED');
const persist = () => writeFile(path.join(directory, evidenceName), `${JSON.stringify(output, null, 2)}\n`);
const env = { ...process.env, LOCALAPPDATA: path.join(profile, 'localappdata'), CODEFORGE_SUBAGENTS_R1: 'true' };
for (const name of Object.keys(env)) if (/^(NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(name) || /API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD/i.test(name)) delete env[name];
let child;
let socket;
const pending = new Map();
let sequence = 0;
let exited = false;
async function evaluate(expression) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('RENDERER_EVALUATION_TIMEOUT')); }, 15000); pending.set(id, { resolve, reject, timer }); });
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 12000 } }));
  const response = await result;
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}
async function launch() {
  exited = false;
  child = spawn(exe, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { env, cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  output.pid = child.pid;
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('exit', () => { exited = true; });
  let metadata;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      metadata = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
      const page = pages.find((entry) => entry.type === 'page' && entry.url.startsWith('file:'));
      if (metadata.pid === child.pid && page) {
        const url = new URL(page.webSocketDebuggerUrl);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('NON_LOOPBACK_DEBUGGER');
        socket = new WebSocket(url);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (!request) return; clearTimeout(request.timer); pending.delete(message.id); if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result); });
        return metadata;
      }
    } catch {}
    if (exited) throw new Error('PACKAGED_STARTUP_EXIT');
    await delay(1000);
  }
  throw new Error('PACKAGED_STARTUP_TIMEOUT');
}
let endpoint;
async function request(route, method = 'GET', body) {
  return evaluate(`fetch(${JSON.stringify(endpoint + route)}, ${JSON.stringify({ method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })}).then(async response => {const text=await response.text();let body;try{body=JSON.parse(text)}catch{}return {status:response.status,body:body??null,...(!body?{text:text.slice(0,300)}:{})}})`);
}
async function sample() {
  const started = performance.now();
  const renderer = await evaluate('new Promise(resolve => requestAnimationFrame(() => resolve({title:document.title,buttons:[...document.querySelectorAll("button")].map(b=>b.textContent?.trim()).filter(Boolean).slice(0,25)})))');
  const elapsed = performance.now() - started;
  let processMemory;
  try { processMemory = JSON.parse((await execFile('powershell', ['-NoProfile', '-Command', `$r67App=Get-Process -Id ${child.pid} -ErrorAction Stop; @{rssBytes=$r67App.WorkingSet64;handles=$r67App.Handles;cpuSeconds=$r67App.CPU}|ConvertTo-Json -Compress`], { windowsHide: true })).stdout); } catch {}
  output.samples.push({ at: new Date().toISOString(), rendererRoundTripMs: elapsed, mainProcess: processMemory, renderer });
  await persist();
}
try {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(exe)) hash.update(bytes);
  output.executableSha256 = hash.digest('hex');
  let metadata = await launch();
  endpoint = metadata.runtimeEndpoint;
  output.endpointConsistency = await evaluate(`window.electronAPI.getRuntimeEndpoint().then(endpoint=>({matches: endpoint===${JSON.stringify(endpoint)},rendererOrigin:location.origin}))`);
  output.runtimeStatus = await evaluate('window.electronAPI.getRuntimeStatus()');
  output.launchMs = Date.now() - Date.parse(output.startedAt);
  output.runtimeVersion = metadata.applicationVersion;
  await sample();
  output.account = await evaluate('window.electronAPI.getCloudAccount().then(account => ({authenticated:Boolean(account?.user||account?.authenticated||account?.id),status:account?.status??null}))');
  if (!output.account.authenticated && !idleOnly) {
    output.waitingFor = 'USER_FIRST_RUN_ACKNOWLEDGMENT_AND_GITHUB_LOGIN';
    await persist();
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline && !output.account.authenticated) {
      await sample();
      await delay(5000);
      output.account = await evaluate('window.electronAPI.getCloudAccount().then(account=>({authenticated:Boolean(account?.user?.id),offline:account?.offline??false,pending:account?.pending??false}))');
    }
    delete output.waitingFor;
  }
  let runId;
  if (idleOnly) {
    output.authenticatedTaskGate = output.account.authenticated ? 'NOT_RUN_IDLE_ONLY' : 'HUMAN_AUTH_REQUIRED';
    output.backendHealth = await request('/api/health');
    output.trustedRendererSessions = await request('/api/sessions');
    for (let index = 0; index < 12; index++) { await delay(5000); await sample(); }
  } else {
  if (!output.account.authenticated) throw new Error('AUTHENTICATED_WINDOWS_LOGIN_REQUIRED');
  output.capacityAtStart = await evaluate('window.electronAPI.getProviderConnections().then(rows=>rows.filter(row=>["kilo-free-direct","ai-horde"].includes(row.providerId)))');
  const selected = await request('/api/workspace/set', 'POST', { path: workspace });
  output.workspaceSelection = { status: selected.status };
  await evaluate('window.electronAPI.updateSettings({privacy:{routingMode:"MAXIMUM_FREE",freeCodeSharing:"PUBLIC_AND_CONSENTED"}})');
  const sessionId = `r67-windows-${Date.now()}`;
  const run = await request('/api/orchestrator/run', 'POST', { sessionId, workspacePath: workspace, goal: task.goal + ' This workspace is a public synthetic fixture.', verificationCommands: ['node --test'] });
  output.tasks.push({ startedAt: new Date().toISOString(), class: task.taskClass, launchStatus: run.status, runId: run.body?.runId });
  const deadline = Date.now() + 600000;
  runId = run.body?.runId;
  while (Date.now() < deadline && !exited) {
    await sample();
    if (runId) {
      const progress = await request(`/api/orchestrator/${runId}`);
      output.tasks[0].lastStatus = progress.body?.status;
      if (['completed', 'blocked', 'failed', 'cancelled'].includes(progress.body?.status)) { output.tasks[0].result = progress.body?.result; break; }
    } else break;
    await delay(10000);
  }
  output.capacityAtEnd = await evaluate('window.electronAPI.getProviderConnections().then(rows=>rows.filter(row=>["kilo-free-direct","ai-horde"].includes(row.providerId)))');
  }
  output.visibleText = await evaluate('document.body.innerText.slice(-6000)');
  socket.close();
  await execFile('taskkill', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true });
  await delay(2000);
  const before = Date.now();
  metadata = await launch();
  endpoint = metadata.runtimeEndpoint;
  const listed = await request('/api/orchestrator/list');
  output.restarts.push({ crashInjected: true, restartMs: Date.now() - before, priorRunId: runId, recoveredRun: Array.isArray(listed.body) ? listed.body.find((item) => item.id === runId) : null });
  await sample();
  output.backendHealthAfterRestart = await request('/api/health');
  output.runtimeStatusAfterRestart = await evaluate('window.electronAPI.getRuntimeStatus()');
  output.status = idleOnly ? 'PASS_UNAUTHENTICATED_IDLE_RESTART' : 'MEASURED';
  if (!output.account.authenticated) output.limitations.push('GitHub login not demonstrated in this isolated profile.');
  output.limitations.push('One packaged task and one restart do not meet the daily-use multi-task/repeated-recovery gate.');
} catch (error) { output.status = 'BLOCKED'; output.error = String(error); }
finally {
  socket?.close();
  if (child?.pid && !exited) await execFile('taskkill', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true }).catch(() => {});
  output.finishedAt = new Date().toISOString();
  output.durationMs = Date.parse(output.finishedAt) - Date.parse(output.startedAt);
  output.memoryScope = 'Main process only; renderer evaluated separately. Process-tree memory unmeasured.';
  await persist();
  console.log(JSON.stringify({ status: output.status, durationMs: output.durationMs, tasks: output.tasks.map(({ lastStatus, launchStatus }) => ({ lastStatus, launchStatus })), samples: output.samples.length, error: output.error }));
}

#!/usr/bin/env node
/**
 * R28 packaged endurance soak.
 *
 * Launches the packaged Windows build with a dedicated user-data profile (no
 * smoke mode — the normal startup path), then soaks it for a bounded window:
 *
 *   - samples every CodeForge.exe process's WorkingSet64/handle count
 *   - probes the runtime control-plane endpoint unauthenticated, expecting 401
 *     every time — liveness plus the auth boundary holding under soak
 *   - tracks renderer crash/exit by watching the process set
 *
 * The evidence is the trend table, not a threshold assertion. The process is
 * then terminated and shutdown behavior recorded.
 */
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const releaseRoot = resolve(here, '..', 'release');
const exePath = process.env.CODEFORGE_SMOKE_EXECUTABLE
  ? resolve(process.env.CODEFORGE_SMOKE_EXECUTABLE)
  : resolve(releaseRoot, 'win-unpacked', 'CodeForge.exe');
const soakProfile = resolve(releaseRoot, 'endurance-user-data');
const evidencePath = resolve('..', '..', 'docs', 'evidence', 'r28-capability-completion', 'R28-ENDURANCE-PACKAGED-EVIDENCE.json');

const minutes = Math.min(Number.parseInt(process.env.CODEFORGE_ENDURANCE_MINUTES ?? '20', 10) || 20, 240);
const sampleEveryMs = Math.min(Number.parseInt(process.env.CODEFORGE_ENDURANCE_SAMPLE_MS ?? '30000', 10) || 30000, 300000);
const deadline = Date.now() + minutes * 60_000;

if (!existsSync(exePath)) {
  console.error(`[PACKAGED ENDURANCE] Executable not found: ${exePath}`);
  process.exit(1);
}
mkdirSync(soakProfile, { recursive: true });

const cleanRuntimeEnv = { ...process.env };
delete cleanRuntimeEnv.NODE_PATH;
delete cleanRuntimeEnv.NODE_OPTIONS;
delete cleanRuntimeEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(exePath, [`--user-data-dir=${soakProfile}`], {
  env: cleanRuntimeEnv,
  cwd: dirname(exePath),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`[ELECTRON STDOUT] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[ELECTRON STDERR] ${d}`));

async function runtimeMetadata() {
  const file = resolve(soakProfile, 'runtime.json');
  for (let i = 0; i < 60; i++) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed?.runtimeEndpoint) return parsed;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}

async function processTreeSample() {
  // Every CodeForge.exe process belonging to this soak profile shares the root
  // executable path; filter by name then keep only PIDs whose command line
  // carries this profile dir (main process) plus its children.
  const { stdout } = await execFile('powershell', [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='CodeForge.exe'" | Where-Object { $_.CommandLine -like '*${soakProfile.replace(/\\/g, '\\\\')}*' -or $_.ExecutablePath -eq '${exePath.replace(/\\/g, '\\\\')}' } | Select-Object ProcessId,ParentProcessId,WorkingSetSize,HandleCount | ConvertTo-Json -Compress`,
  ], { maxBuffer: 4 * 1024 * 1024, windowsHide: true }).catch(() => ({ stdout: '' }));
  let rows = [];
  try {
    const parsed = JSON.parse(stdout.trim() || '[]');
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  // Children spawned by the main process don't carry the profile flag; include
  // descendants of any matched PID.
  if (rows.length > 0) {
    const matched = new Set(rows.map((r) => r.ProcessId));
    const { stdout: all } = await execFile('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='CodeForge.exe'" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,HandleCount | ConvertTo-Json -Compress`,
    ], { maxBuffer: 4 * 1024 * 1024, windowsHide: true }).catch(() => ({ stdout: '' }));
    try {
      const allRows = JSON.parse(all.trim() || '[]');
      const list = Array.isArray(allRows) ? allRows : [allRows];
      const byParent = new Map();
      for (const r of list) {
        const arr = byParent.get(r.ParentProcessId) ?? [];
        arr.push(r);
        byParent.set(r.ParentProcessId, arr);
      }
      const queue = [...matched];
      while (queue.length > 0) {
        const pid = queue.pop();
        for (const childRow of byParent.get(pid) ?? []) {
          if (!matched.has(childRow.ProcessId)) {
            matched.add(childRow.ProcessId);
            queue.push(childRow.ProcessId);
            rows.push(childRow);
          }
        }
      }
    } catch {}
  }
  return rows;
}

async function probeEndpoint(endpoint) {
  try {
    const res = await fetch(`${endpoint}/api/models`, { signal: AbortSignal.timeout(5000) });
    return { reachable: true, status: res.status };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function linearSlope(samples, valueOf) {
  const ys = samples.map(valueOf);
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const metadata = await runtimeMetadata();
if (!metadata) {
  console.error('[PACKAGED ENDURANCE] runtime.json never appeared — app failed to reach runtime.');
  child.kill();
  process.exit(1);
}
console.log(`[PACKAGED ENDURANCE] runtime endpoint ${metadata.runtimeEndpoint}, main pid ${metadata.pid}, soak ${minutes}min`);

const samples = [];
const startedAt = Date.now();
let childExited = false;
let childExitCode = null;
child.on('close', (code) => {
  childExited = true;
  childExitCode = code;
});

while (Date.now() < deadline && !childExited) {
  const rows = await processTreeSample();
  const probe = await probeEndpoint(metadata.runtimeEndpoint);
  samples.push({
    t: Date.now() - startedAt,
    processCount: rows.length,
    totalWorkingSetBytes: rows.reduce((a, r) => a + (r.WorkingSetSize ?? 0), 0),
    maxProcessWorkingSetBytes: Math.max(0, ...rows.map((r) => r.WorkingSetSize ?? 0)),
    totalHandles: rows.reduce((a, r) => a + (r.HandleCount ?? 0), 0),
    endpoint: probe,
    childAlive: !childExited,
  });
  await new Promise((r) => setTimeout(r, sampleEveryMs));
}

// Graceful shutdown: close the window tree, then force only if needed.
let shutdown = 'clean_exit_observed';
if (!childExited) {
  await execFile('taskkill', ['/PID', String(child.pid), '/T'], { windowsHide: true }).catch(() => {});
  const gracefulDeadline = Date.now() + 15_000;
  while (!childExited && Date.now() < gracefulDeadline) await new Promise((r) => setTimeout(r, 500));
  if (!childExited) {
    await execFile('taskkill', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    shutdown = childExited ? 'forced_after_graceful_timeout' : 'kill_failed';
  } else {
    shutdown = 'graceful_taskkill';
  }
}
const leftover = (await processTreeSample()).length;

const receipt = {
  schema: 'r28-endurance-packaged-1',
  recordedAt: new Date().toISOString(),
  exePath,
  profile: soakProfile,
  soak: { minutesBudgeted: minutes, sampleEveryMs, samplesTaken: samples.length, wallClockMs: Date.now() - startedAt },
  runtime: { endpoint: metadata.runtimeEndpoint, pid: metadata.pid, version: metadata.applicationVersion },
  outcome: {
    processAliveThroughSoak: samples.every((s) => s.childAlive),
    endpointReachableCount: samples.filter((s) => s.endpoint.reachable).length,
    endpoint401Count: samples.filter((s) => s.endpoint.status === 401).length,
    endpointUnexpectedStatuses: [...new Set(samples.filter((s) => s.endpoint.status && s.endpoint.status !== 401).map((s) => s.endpoint.status))],
    childExitCode,
    shutdown,
    leftoverProcessesAfterKill: leftover,
  },
  resourceTrends: {
    workingSetBytesPerSample: Math.round(linearSlope(samples, (s) => s.totalWorkingSetBytes)),
    handlesPerSample: Math.round(linearSlope(samples, (s) => s.totalHandles) * 100) / 100,
    processCountPerSample: linearSlope(samples, (s) => s.processCount),
    first: samples[0] ?? null,
    last: samples.at(-1) ?? null,
  },
  samples,
  honesty: {
    probe: 'Unauthenticated GET /api/models — 401 expected and counted; it proves liveness and the auth boundary holding under soak, not authenticated throughput.',
    scope: 'Process-level packaged soak (uptime, memory/handle trend, liveness). Does not drive workflows; task-level packaged endurance is separate.',
  },
};

writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  evidencePath,
  samples: samples.length,
  aliveThroughSoak: receipt.outcome.processAliveThroughSoak,
  endpoint401Count: receipt.outcome.endpoint401Count,
  wsSlopeBytesPerSample: receipt.resourceTrends.workingSetBytesPerSample,
  shutdown,
  leftover,
}, null, 2));
process.exitCode = receipt.outcome.processAliveThroughSoak && leftover === 0 ? 0 : 2;

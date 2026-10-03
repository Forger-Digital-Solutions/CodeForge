import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const execFile = promisify(callback);
const root = Number(process.argv[2]);
if (!Number.isSafeInteger(root) || root <= 0) throw new Error('EXPLICIT_ROOT_PID_REQUIRED');
const output = { startedAt: new Date().toISOString(), rootPid: root, scope: 'Canonical harness and recursively enumerated node descendants, sampled every 15 seconds outside the restricted execution environment.', peakProcessTreeRssBytes: 0, peakSingleProcessWorkingSetBytes: 0, samples: [] };
const script = `$r66RootPid=${root};$r66All=Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop;if(-not($r66All.ProcessId -contains $r66RootPid)){exit 3};$r66Ids=@($r66RootPid);do{$r66New=@($r66All|Where-Object{$r66Ids -contains $_.ParentProcessId -and $r66Ids -notcontains $_.ProcessId}|Select-Object -ExpandProperty ProcessId);$r66Ids+=$r66New}while($r66New.Count -gt 0);$r66Memory=@(Get-Process -Id $r66Ids -ErrorAction SilentlyContinue);@{at=[DateTime]::UtcNow.ToString('o');pids=$r66Ids;rssBytes=($r66Memory|Measure-Object WorkingSet64 -Sum).Sum;peak=($r66Memory|Measure-Object PeakWorkingSet64 -Maximum).Maximum}|ConvertTo-Json -Compress`;
while (true) {
  try {
    const { stdout } = await execFile('pwsh', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10000 });
    const sample = JSON.parse(stdout);
    output.samples.push(sample);
    output.peakProcessTreeRssBytes = Math.max(output.peakProcessTreeRssBytes, sample.rssBytes ?? 0);
    output.peakSingleProcessWorkingSetBytes = Math.max(output.peakSingleProcessWorkingSetBytes, sample.peak ?? 0);
  } catch (error) { if (error.code !== 3) output.error = error.message; break; }
  await writeFile('docs/evidence/r66-everyday-free-readiness/R66-TEST-MEMORY.json', `${JSON.stringify(output, null, 2)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 15000));
}
output.finishedAt = new Date().toISOString();
await writeFile('docs/evidence/r66-everyday-free-readiness/R66-TEST-MEMORY.json', `${JSON.stringify(output, null, 2)}\n`);

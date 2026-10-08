import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';

const directory = 'docs/evidence/r72-free-supply-and-autonomy';
const artifact = path.resolve(process.argv[2] ?? 'apps/desktop/release/win-unpacked');
const audits = [];
for (const [name, extra] of [
  ['build-identity', ['--require-clean']], ['internal-dependencies', []], ['runtime-dependencies', []], ['browser-security', []],
  ['auth-endpoint', ['--channel', 'development', '--mode', 'smoke', '--expected-url', 'http://127.0.0.1:3220']],
]) {
  const result = spawnSync(process.execPath, [`apps/desktop/scripts/audit-packaged-${name}.mjs`, artifact, ...extra], { encoding: 'utf8', windowsHide: true });
  const log = `${directory}/windows-${name}.log`;
  await writeFile(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  audits.push({ name, log, exitCode: result.status, passed: result.status === 0 });
}
const files = [];
for (const relative of ['CodeForge.exe', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
  const absolute = path.join(artifact, relative);
  const bytes = await readFile(absolute);
  files.push({ file: relative, path: absolute, bytes: (await stat(absolute)).size, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = { observedAt: new Date().toISOString(), sourceRevision: execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), artifact, files, audits,
  execution: 'NOT_EXECUTED_NO_AUTHORIZED_ISOLATED_WINDOWS_ENVIRONMENT', installer: 'NOT_BUILT_NOT_CERTIFIED' };
await writeFile(`${directory}/windows-artifact-manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ sourceRevision: manifest.sourceRevision, audits }));
process.exitCode = audits.every(a => a.passed) ? 0 : 1;

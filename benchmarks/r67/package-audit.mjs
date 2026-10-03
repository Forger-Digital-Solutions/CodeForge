import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import asar from '@electron/asar';
import { directory, read } from './release-artifacts.mjs';
const archive = 'benchmarks/r67/tmp/windows-package/win-unpacked/resources/app.asar';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeFiles = ['agent/index', 'eight-bit/route-health-authority', 'eight-bit/runtime',
  'model-registry/free-cloud-service', 'protocol/subagent-runtime', 'server/agent-runtime',
  'server/autonomous-orchestrator', 'server/command-classifier', 'server/index', 'server/subagent-manager',
  'terminal/executor', 'terminal/pty-loader', 'tools/index'];
const entries = [];
for (const module of runtimeFiles) {
  const [name, file] = module.split('/');
  const builtPath = `packages/${name}/dist/${file}.js`;
  const packagedPath = `node_modules\\@codeforge\\${name}\\dist\\${file}.js`;
  const builtSha256 = digest(await readFile(builtPath));
  const packagedSha256 = digest(asar.extractFile(archive, packagedPath));
  assert.equal(builtSha256, packagedSha256, `PACKAGED_RUNTIME_DRIFT:${module}`);
  entries.push({ builtPath, packagedPath, builtSha256, packagedSha256 });
}
const frozen = await read('R67-SOURCE-FREEZE');
const windows = await read('R67-WINDOWS-CERTIFIED-IDLE-RESTART');
const manifest = JSON.parse(asar.extractFile(archive, 'apps\\desktop\\dist\\cloud-endpoints.json').toString());
assert.equal(manifest.channel, 'production');
assert.equal(manifest.endpoints.production, 'https://codeforge-cloud-va.onrender.com');
const result = { at: new Date().toISOString(), status: 'PASS', evidenceClass: 'ACTUAL_PACKAGED_RUNTIME_BYTE_COMPARISON',
  runtimeSourceStateId: frozen.sourceStateId, runtimeSourceAggregateSha256: frozen.sourceAggregateSha256,
  archiveSha256: digest(await readFile(archive)), executableSha256: windows.executableSha256,
  identity: windows.identity, manifest, entries, runtimeModulesCompared: entries.length,
  startupIdleRestartEvidence: 'R67-WINDOWS-CERTIFIED-IDLE-RESTART.json', authenticatedTaskGate: 'HUMAN_AUTH_REQUIRED' };
await writeFile(`${directory}/R67-WINDOWS-PACKAGE-BYTE-AUDIT.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, runtimeModulesCompared: entries.length, archiveSha256: result.archiveSha256 }));

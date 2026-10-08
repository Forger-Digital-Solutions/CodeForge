import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const directory = 'docs/evidence/r72-free-supply-and-autonomy';
const initial = JSON.parse(await readFile(`${directory}/affected-tests.json`, 'utf8'));
const native = process.argv[2] === 'native';
const files = native
  ? JSON.parse(await readFile(`${directory}/isolated-rechecks.json`, 'utf8')).results.filter(r => r.failed).map(r => r.file)
  : initial.testResults.filter(s => s.assertionResults.some(a => a.status === 'failed')).map(s => s.name);
const temp = native ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Temp', 'codeforge-r72') : path.resolve('t');
await mkdir(temp, { recursive: true });
const env = { ...process.env, TEMP: temp, TMP: temp, npm_config_script_shell: process.env.ComSpec,
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' };
const results = [];
for (const file of files) {
  const output = `${directory}/${native ? 'native' : 'isolated'}-${path.basename(file, '.test.ts')}.json`;
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', file, '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], { env, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(-1)); child.on('exit', resolve);
  });
  const receipt = JSON.parse(await readFile(output, 'utf8'));
  results.push({ file, output, exitCode, tests: receipt.numTotalTests, passed: receipt.numPassedTests, failed: receipt.numFailedTests, skipped: receipt.numPendingTests });
  await writeFile(`${directory}/${native ? 'native' : 'isolated'}-rechecks.json`, JSON.stringify({ startedFrom: native ? 'isolated-rechecks.json' : 'affected-tests.json', environment: { temp, npmShell: process.env.ComSpec, fsmonitor: false }, results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
process.exitCode = results.some(r => r.failed || r.exitCode !== 0) ? 1 : 0;

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mode = process.argv[2] || 'full';
const desktopRoot = resolve(__dirname, '..');
const exePath = process.env.CODEFORGE_SMOKE_EXECUTABLE
  ? resolve(process.env.CODEFORGE_SMOKE_EXECUTABLE)
  : resolve(desktopRoot, 'release', 'win-unpacked', 'CodeForge.exe');
const smokeWorkspace = resolve(desktopRoot, 'release', 'smoke-workspace');
const smokeOut = resolve(desktopRoot, 'release', 'smoke-result.log');
const smokeProfile = resolve(desktopRoot, 'release', 'smoke-user-data');
const smokeSuiteState = resolve(desktopRoot, 'release', 'smoke-suite-id');
if (mode === 'full') writeFileSync(smokeSuiteState, randomUUID(), 'utf8');
if (!existsSync(smokeSuiteState)) {
  console.error('[PACKAGED SMOKE] Run full mode before interrupt/recover.');
  process.exit(1);
}
const suiteId = readFileSync(smokeSuiteState, 'utf8').trim();
const testSecret = `CF_SECRET_${createHash('sha256').update(`codeforge-packaged-smoke:${suiteId}`).digest('hex')}`;
const runId = randomUUID();
const requiredMarkers = {
  full: ['PACKAGED_FULL_SMOKE_OK', 'packaged_failure_repair_pass=PASS', 'packaged_renderer_reload_count=5', 'packaged_renderer_reload=PASS', 'credential_plaintext_absent=PASS'],
  interrupt: ['PACKAGED_INTERRUPT_EXPECTED_EXIT', 'electron_restart_interruption_ready=PASS'],
  recover: ['PACKAGED_RECOVERY_SMOKE_OK', 'electron_restart_failed_safely=PASS', 'electron_restart_no_approval_replay=PASS'],
};

if (!existsSync(exePath)) {
  console.error(`Packaged executable not found at: ${exePath}`);
  console.error('Run "npm run pack --workspace=codeforge-desktop" first.');
  process.exit(1);
}

if (mode === 'full') {
  try { rmSync(smokeProfile, { recursive: true, force: true }); } catch {}
  try { rmSync(smokeWorkspace, { recursive: true, force: true }); } catch {}
  mkdirSync(join(smokeWorkspace, 'src'), { recursive: true });
  writeFileSync(join(smokeWorkspace, 'src', 'calc.ts'), 'export function add(a: number, b: number): number {\n  return a - b;\n}\n');
  writeFileSync(join(smokeWorkspace, 'package.json'), JSON.stringify({ name: 'smoke-test', type: 'module' }, null, 2));
  const noiseRoot = join(smokeWorkspace, 'packages', 'noise', 'src');
  mkdirSync(noiseRoot, { recursive: true });
  const noiseLines = Array.from({ length: 199 }, (_, index) => `// deterministic distraction line ${index}`).join('\n');
  for (let index = 0; index < 256; index++) {
    writeFileSync(join(noiseRoot, `module-${String(index).padStart(4, '0')}.ts`), `${noiseLines}\nexport const distraction${index} = ${index};\n`);
  }
  try { rmSync(smokeOut, { force: true }); } catch {}
}

const startingSize = existsSync(smokeOut) ? readFileSync(smokeOut).length : 0;

console.log(`[PACKAGED SMOKE] Mode: ${mode}`);
console.log(`[PACKAGED SMOKE] Executable: ${exePath}`);
console.log(`[PACKAGED SMOKE] Workspace: ${smokeWorkspace}`);

const child = spawn(exePath, [`--user-data-dir=${smokeProfile}`], {
  env: {
    ...process.env,
    CODEFORGE_PACKAGED_SMOKE: '1',
    CODEFORGE_PACKAGED_SMOKE_MODE: mode,
    CODEFORGE_SMOKE_WORKSPACE: smokeWorkspace,
    CODEFORGE_SMOKE_OUT: smokeOut,
    CODEFORGE_SMOKE_RUN_ID: runId,
    CODEFORGE_TEST_SECRET: testSecret,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const watchdog = setTimeout(() => {
  console.error(`[PACKAGED SMOKE] Mode ${mode} timed out`);
  child.kill();
}, 90_000);

child.stdout.on('data', (data) => {
  process.stdout.write(`[ELECTRON STDOUT] ${data}`);
});

child.stderr.on('data', (data) => {
  process.stderr.write(`[ELECTRON STDERR] ${data}`);
});

child.on('close', (code) => {
  clearTimeout(watchdog);
  console.log(`\n[ELECTRON EXITED] Exit code: ${code}`);
  let currentRunEvidence = '';
  if (existsSync(smokeOut)) {
    const allEvidence = readFileSync(smokeOut, 'utf8');
    currentRunEvidence = Buffer.from(allEvidence).subarray(startingSize).toString('utf8');
    console.log('\n--- SMOKE OUT CONTENT ---');
    console.log(currentRunEvidence);
    console.log('-------------------------');
  } else {
    console.log('\n[NO SMOKE OUT PRODUCED]');
  }

  const expectedCode = mode === 'interrupt' ? 73 : 0;
  const markers = requiredMarkers[mode];
  const evidenceValid = Array.isArray(markers)
    && currentRunEvidence.includes(`smoke_run_id=${runId}`)
    && currentRunEvidence.includes(`smoke_mode=${mode}`)
    && currentRunEvidence.includes('app_is_packaged=true')
    && markers.every((marker) => currentRunEvidence.includes(marker))
    && !currentRunEvidence.includes('PACKAGED_SMOKE_FAILED')
    && !currentRunEvidence.includes(testSecret);
  const fixedFileValid = mode === 'interrupt'
    || (existsSync(join(smokeWorkspace, 'src', 'calc.ts'))
      && readFileSync(join(smokeWorkspace, 'src', 'calc.ts'), 'utf8').includes('a + b'));
  const isExpectedSuccess = code === expectedCode && evidenceValid && fixedFileValid;
  if (isExpectedSuccess) {
    console.log(`[PACKAGED SMOKE] Mode ${mode} SUCCESS (exit code: ${code})`);
    process.exit(0);
  } else {
    console.error(`[PACKAGED SMOKE] Mode ${mode} FAILED (exit=${code}, evidence=${evidenceValid}, content=${fixedFileValid})`);
    process.exit(1);
  }
});

child.on('error', (error) => {
  clearTimeout(watchdog);
  console.error(`[PACKAGED SMOKE] Failed to launch: ${error.message}`);
  process.exit(1);
});

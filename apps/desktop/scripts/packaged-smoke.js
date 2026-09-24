import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mode = process.argv[2] || 'full';
const desktopRoot = resolve(__dirname, '..');
const smokeRoot = process.env.CODEFORGE_SMOKE_ROOT
  ? resolve(process.env.CODEFORGE_SMOKE_ROOT)
  : resolve(desktopRoot, 'release');
const exePath = process.env.CODEFORGE_SMOKE_EXECUTABLE
  ? resolve(process.env.CODEFORGE_SMOKE_EXECUTABLE)
  : resolve(smokeRoot, 'win-unpacked', 'CodeForge.exe');
const smokeWorkspace = resolve(smokeRoot, 'smoke-workspace');
const smokeOut = resolve(smokeRoot, 'smoke-result.log');
const smokeProfile = resolve(smokeRoot, 'smoke-user-data');
const smokeRepositoryIndexes = resolve(smokeRoot, 'smoke-repository-indexes');
const smokeSuiteState = resolve(smokeRoot, 'smoke-suite-id');
const screenshotDirectory = process.env.CODEFORGE_SMOKE_SCREENSHOT_DIR
  ? resolve(process.env.CODEFORGE_SMOKE_SCREENSHOT_DIR)
  : undefined;
function removeSmokeDirectory(target) {
  const root = resolve(smokeRoot);
  const candidate = resolve(target);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error(`Refusing to remove a path outside the smoke root: ${candidate}`);
  rmSync(candidate, { recursive: true, force: true });
}
mkdirSync(smokeRoot, { recursive: true });
if (mode === 'full' || mode === 'live-task') writeFileSync(smokeSuiteState, randomUUID(), 'utf8');
if (!existsSync(smokeSuiteState)) {
  console.error('[PACKAGED SMOKE] Run full mode before interrupt/recover.');
  process.exit(1);
}
const suiteId = readFileSync(smokeSuiteState, 'utf8').trim();
const testSecret = `CF_SECRET_${createHash('sha256').update(`codeforge-packaged-smoke:${suiteId}`).digest('hex')}`;
const runId = randomUUID();
const requiredMarkers = {
  full: [
    'PACKAGED_STARTUP=PASS', 'FORGEGREEN_RUNTIME=PASS', 'EIGHT_BIT_RUNTIME=PASS', 'CLOUD_DB_PACKAGED_RUNTIME=PASS', 'PACKAGED_FULL_SMOKE_OK',
    // Renderer startup chain stamped by the renderer itself (renderer/lifecycle.ts).
    'packaged_renderer_lifecycle_chain=PASS',
    'packaged_zero_prompt_workflow=PASS',
    'packaged_failure_repair_pass=PASS', 'packaged_renderer_reload_count=5', 'packaged_renderer_reload=PASS', 'credential_plaintext_absent=PASS',
    // Settings control plane + extension host: real bridge round-trip, strict rejection, fixture
    // extension discovery/activation, permission-gated command, live workspace:read, lifecycle.
    'packaged_settings_roundtrip=PASS', 'packaged_settings_invalid_rejected=PASS',
    'packaged_extensions_loaded=PASS', 'packaged_extension_command=PASS', 'packaged_extension_workspace_read=PASS',
    'packaged_extension_lifecycle=PASS', 'settings_repo_intel_page=PASS', 'settings_extensions_page=PASS',
    'packaged_updater_status=PASS', 'packaged_updater_check=PASS', 'packaged_updater_install_guarded=PASS',
    // Local control-plane trust boundary: bearer never reaches the renderer, main authenticates the
    // primary document, everything else (no/wrong bearer, forged origin, secondary renderer) fails closed.
    'control_plane_renderer_bearer_absent=PASS', 'control_plane_trusted_renderer=PASS', 'control_plane_missing_bearer_rejected=PASS',
    'control_plane_wrong_bearer_rejected=PASS', 'control_plane_forged_approval_rejected=PASS', 'control_plane_forged_origin_rejected=PASS',
    'control_plane_secondary_renderer_ipc_rejected=PASS', 'control_plane_secondary_renderer_unauthenticated=PASS', 'control_plane_trust_boundary=PASS',
  ],
  interrupt: ['PACKAGED_INTERRUPT_EXPECTED_EXIT', 'electron_restart_interruption_ready=PASS'],
  recover: ['PACKAGED_RECOVERY_SMOKE_OK', 'electron_restart_failed_safely=PASS', 'electron_restart_no_approval_replay=PASS'],
  // R32: the packaged binary must run a real coding task against a live free provider —
  // discovery proves the route existed; PASS means the workflow completed and the file is right.
  'live-task': ['PACKAGED_STARTUP=PASS', 'packaged_live_free_models=', 'packaged_live_task=PASS'],
};

if (!existsSync(exePath)) {
  console.error(`Packaged executable not found at: ${exePath}`);
  console.error('Run "npm run pack --workspace=codeforge-desktop" first.');
  process.exit(1);
}

if (mode === 'full' || mode === 'live-task') {
  removeSmokeDirectory(smokeProfile);
  removeSmokeDirectory(smokeWorkspace);
  removeSmokeDirectory(smokeRepositoryIndexes);
  mkdirSync(join(smokeWorkspace, 'src'), { recursive: true });
  writeFileSync(join(smokeWorkspace, 'src', 'calc.ts'), 'export function add(a: number, b: number): number {\n  return a - b;\n}\n');
  writeFileSync(join(smokeWorkspace, 'package.json'), JSON.stringify({ name: 'smoke-test', type: 'module' }, null, 2));
  // Clear the evidence file: stale markers from a previous mode must never satisfy this run.
  try { rmSync(smokeOut, { force: true }); } catch {}
}

if (mode === 'full') {
  const noiseRoot = join(smokeWorkspace, 'packages', 'noise', 'src');
  mkdirSync(noiseRoot, { recursive: true });
  const noiseLines = Array.from({ length: 199 }, (_, index) => `// deterministic distraction line ${index}`).join('\n');
  for (let index = 0; index < 256; index++) {
    writeFileSync(join(noiseRoot, `module-${String(index).padStart(4, '0')}.ts`), `${noiseLines}\nexport const distraction${index} = ${index};\n`);
  }

  // Seed extension fixtures into the fresh userData profile before launch: one valid extension
  // (must be discovered + activated by the packaged host) and one corrupt manifest (must be
  // contained as a per-extension error state, never crash boot).
  const smokeExtensionsDir = join(smokeProfile, 'extensions');
  mkdirSync(join(smokeExtensionsDir, 'acme.smoke'), { recursive: true });
  writeFileSync(join(smokeExtensionsDir, 'acme.smoke', 'codeforge-extension.json'), JSON.stringify({
    id: 'acme.smoke',
    name: 'Smoke Probe',
    version: '1.0.0',
    description: 'Packaged-smoke fixture proving the extension host runs inside the installed product.',
    main: 'extension.js',
    engines: { codeforge: '*' },
    permissions: ['commands:register', 'workspace:read'],
    contributes: { commands: [{ id: 'acme.smoke.ping', title: 'Ping' }] },
  }, null, 2));
  writeFileSync(join(smokeExtensionsDir, 'acme.smoke', 'extension.js'), [
    'module.exports = {',
    '  activate(codeforge) {',
    '    codeforge.commands.register("acme.smoke.ping", () => {',
    '      const name = codeforge.workspace.name;',
    '      if (name !== "smoke-workspace") throw new Error("workspace:read saw " + name);',
    '      return "pong";',
    '    });',
    '  },',
    '};',
    '',
  ].join('\n'));
  mkdirSync(join(smokeExtensionsDir, 'acme.broken'), { recursive: true });
  writeFileSync(join(smokeExtensionsDir, 'acme.broken', 'codeforge-extension.json'), '{ not json');
}

const startingSize = existsSync(smokeOut) ? readFileSync(smokeOut).length : 0;

const cleanRuntimeEnv = { ...process.env };
delete cleanRuntimeEnv.NODE_PATH;
delete cleanRuntimeEnv.NODE_OPTIONS;
delete cleanRuntimeEnv.ELECTRON_RUN_AS_NODE;

console.log(`[PACKAGED SMOKE] Mode: ${mode}`);
console.log(`[PACKAGED SMOKE] Executable: ${exePath}`);
console.log(`[PACKAGED SMOKE] Workspace: ${smokeWorkspace}`);

const child = spawn(exePath, [`--user-data-dir=${smokeProfile}`], {
  env: {
    ...cleanRuntimeEnv,
    CODEFORGE_PACKAGED_SMOKE: '1',
    CODEFORGE_PACKAGED_SMOKE_MODE: mode,
    CODEFORGE_SMOKE_WORKSPACE: smokeWorkspace,
    CODEFORGE_SMOKE_OUT: smokeOut,
    CODEFORGE_SMOKE_RUN_ID: runId,
    CODEFORGE_TEST_SECRET: testSecret,
    CODEFORGE_REPOSITORY_INDEX_ROOT: smokeRepositoryIndexes,
    ...(screenshotDirectory ? { CODEFORGE_SMOKE_SCREENSHOT_DIR: screenshotDirectory } : {}),
    ELECTRON_ENABLE_LOGGING: '1',
  },
  cwd: dirname(exePath),
  stdio: ['ignore', 'pipe', 'pipe'],
});

const watchdog = setTimeout(() => {
  console.error(`[PACKAGED SMOKE] Mode ${mode} timed out`);
  child.kill();
}, mode === 'live-task' ? 20 * 60_000 : 90_000);

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

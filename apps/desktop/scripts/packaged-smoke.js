import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mode = process.argv[2] || 'full';
const desktopRoot = resolve(__dirname, '..');
const exePath = resolve(desktopRoot, 'release', 'win-unpacked', 'CodeForge.exe');
const smokeWorkspace = resolve(desktopRoot, 'release', 'smoke-workspace');
const smokeOut = resolve(desktopRoot, 'release', 'smoke-result.log');
const testSecret = 'codeforge-test-secret-' + Math.floor(Math.random() * 900000 + 100000);

if (!existsSync(exePath)) {
  console.error(`Packaged executable not found at: ${exePath}`);
  console.error('Run "npm run pack --workspace=codeforge-desktop" first.');
  process.exit(1);
}

if (mode === 'full') {
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? join(process.env.HOME || '', 'Library', 'Application Support') : join(process.env.HOME || '', '.config'));
  const userData = join(appData, 'codeforge-desktop');
  try { rmSync(userData, { recursive: true, force: true }); } catch {}
  try { rmSync(smokeWorkspace, { recursive: true, force: true }); } catch {}
  mkdirSync(join(smokeWorkspace, 'src'), { recursive: true });
  writeFileSync(join(smokeWorkspace, 'src', 'calc.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  writeFileSync(join(smokeWorkspace, 'package.json'), JSON.stringify({ name: 'smoke-test', type: 'module' }, null, 2));
  try { rmSync(smokeOut, { force: true }); } catch {}
}

console.log(`[PACKAGED SMOKE] Mode: ${mode}`);
console.log(`[PACKAGED SMOKE] Executable: ${exePath}`);
console.log(`[PACKAGED SMOKE] Workspace: ${smokeWorkspace}`);
console.log(`[PACKAGED SMOKE] Secret: ${testSecret}`);

const child = spawn(exePath, [], {
  env: {
    ...process.env,
    CODEFORGE_PACKAGED_SMOKE: '1',
    CODEFORGE_PACKAGED_SMOKE_MODE: mode,
    CODEFORGE_SMOKE_WORKSPACE: smokeWorkspace,
    CODEFORGE_SMOKE_OUT: smokeOut,
    CODEFORGE_TEST_SECRET: testSecret,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (data) => {
  process.stdout.write(`[ELECTRON STDOUT] ${data}`);
});

child.stderr.on('data', (data) => {
  process.stderr.write(`[ELECTRON STDERR] ${data}`);
});

child.on('close', (code) => {
  console.log(`\n[ELECTRON EXITED] Exit code: ${code}`);
  if (existsSync(smokeOut)) {
    console.log('\n--- SMOKE OUT CONTENT ---');
    console.log(readFileSync(smokeOut, 'utf8'));
    console.log('-------------------------');
  } else {
    console.log('\n[NO SMOKE OUT PRODUCED]');
  }

  const isExpectedSuccess = code === 0 || (mode === 'interrupt' && code === 73);
  if (isExpectedSuccess) {
    console.log(`[PACKAGED SMOKE] Mode ${mode} SUCCESS (exit code: ${code})`);
    process.exit(0);
  } else {
    console.error(`[PACKAGED SMOKE] Mode ${mode} FAILED (unexpected exit code: ${code})`);
    process.exit(1);
  }
});

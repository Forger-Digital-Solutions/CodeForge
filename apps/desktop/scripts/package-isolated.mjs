import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPackagingIsolation } from './packaging-isolation.mjs';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopDirectory, '../..');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output requires a dedicated directory');
const outputDirectory = resolve(desktopDirectory, outputIndex === -1 ? 'release' : process.argv[outputIndex + 1]);
const receipt = assertPackagingIsolation({ repositoryRoot, desktopDirectory, outputDirectory });
console.log(JSON.stringify({ packagingIsolation: receipt }));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktopDirectory, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging command failed with exit ${result.status}`);
}

if (process.argv.includes('--build')) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run build packaging through npm');
  run(process.execPath, [npmCli, 'run', 'build']);
  run(process.execPath, [npmCli, 'run', 'build:native']);
}
const current = assertPackagingIsolation({ repositoryRoot, desktopDirectory, outputDirectory });
if (current.sourceRevision !== receipt.sourceRevision) throw new Error('PACKAGING_SOURCE_CHANGED');
run(process.execPath, [resolve(repositoryRoot, 'node_modules/electron-builder/cli.js'), ...(process.argv.includes('--dir') ? ['--dir'] : []), `--config.directories.output=${outputDirectory}`]);
for (const audit of ['internal-dependencies', 'runtime-dependencies', 'build-identity']) {
  run(process.execPath, [`scripts/audit-packaged-${audit}.mjs`, outputDirectory, ...(audit === 'build-identity' ? ['--require-clean'] : [])]);
}

import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function rejectRedirects(root, candidate) {
  let current = candidate;
  while (contained(root, current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`PACKAGING_REDIRECT: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    current = path.dirname(current);
  }
}

export function assertPackagingIsolation({ repositoryRoot, desktopDirectory, outputDirectory, git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).trim() }) {
  const sourceRoot = path.resolve(repositoryRoot);
  const sourceDesktop = path.resolve(desktopDirectory);
  const sourceOutput = path.resolve(outputDirectory);
  if (!contained(sourceRoot, sourceDesktop) || !contained(sourceDesktop, sourceOutput)) throw new Error('PACKAGING_OUTPUT_OUTSIDE_ISOLATED_DESKTOP');
  rejectRedirects(sourceRoot, sourceDesktop);
  rejectRedirects(sourceRoot, sourceOutput);
  // Canonicalize existing roots before comparing Windows long and 8.3 path spellings.
  const root = realpathSync.native(sourceRoot);
  const desktop = realpathSync.native(sourceDesktop);
  const output = path.resolve(desktop, path.relative(sourceDesktop, sourceOutput));
  const top = realpathSync.native(git(['rev-parse', '--show-toplevel']));
  const common = realpathSync.native(path.resolve(root, git(['rev-parse', '--git-common-dir'])));
  if (top !== root || common === path.join(root, '.git')) throw new Error('PACKAGING_PROTECTED_PRIMARY_CHECKOUT: use an isolated Git worktree');
  if (git(['status', '--porcelain=v1', '--untracked-files=normal'])) throw new Error('PACKAGING_SOURCE_DIRTY');
  const sourceRevision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('PACKAGING_SOURCE_IDENTITY_INVALID');
  try {
    if (readdirSync(output).length > 0) throw new Error('PACKAGING_OUTPUT_NOT_EMPTY: choose a new dedicated release directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { repositoryRoot: root, desktopDirectory: desktop, outputDirectory: output, sourceRevision };
}

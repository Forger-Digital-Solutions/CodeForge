import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = 'docs/evidence/r76-free-supply-recovery-and-reliability';
const roots = ['G:/CodeForge', 'G:/CodeForge/worktrees/r75-reliable-free-autonomous-coding'];
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(root, entry.name);
  return entry.isSymbolicLink() ? [] : entry.isDirectory() ? walk(file) : [file];
});
const trees = roots.map(root => {
  const git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trimEnd();
  const status = git(['status', '--porcelain=v1']);
  const modified = git(['diff', '--name-only']).split('\n').filter(Boolean).map(file => ({ file, sha256: hash(path.join(root, file)) }));
  const release = path.join(root, 'apps/desktop/release');
  const protectedArtifacts = existsSync(release) ? readdirSync(release).filter(file => /\.(exe|yml|blockmap)$/.test(file)).map(file => ({ file: path.join(release, file), bytes: statSync(path.join(release, file)).size, sha256: hash(path.join(release, file)) })) : [];
  const evidenceRoot = path.join(root, 'docs/evidence');
  const evidence = readdirSync(evidenceRoot).filter(name => /^r7[2-5]-/.test(name)).flatMap(name => walk(path.join(evidenceRoot, name))).map(file => ({ file: path.relative(root, file), sha256: hash(file) }));
  return { root, head: git(['rev-parse', 'HEAD']), status, modified, protectedArtifacts, evidence };
});
const mode = process.argv[2] ?? 'before';
const receipt = { at: new Date().toISOString(), trees };
if (mode === 'after') {
  const before = JSON.parse(readFileSync(`${directory}/preservation-before.json`, 'utf8'));
  receipt.preserved = JSON.stringify(trees) === JSON.stringify(before.trees);
}
writeFileSync(`${directory}/preservation-${mode}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ mode, preserved: receipt.preserved, trees: trees.map(tree => ({ root: tree.root, head: tree.head, modified: tree.modified.length, protectedArtifacts: tree.protectedArtifacts.length, evidence: tree.evidence.length })) }));
if (receipt.preserved === false) process.exitCode = 1;

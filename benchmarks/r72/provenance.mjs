import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const original = 'G:/CodeForge';
const evidence = 'docs/evidence/r72-free-supply-and-autonomy';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dirtyFiles = git(original, 'diff', '--name-only').split('\n').filter(Boolean);
const preservedFiles = await Promise.all(dirtyFiles.map(async file => ({ file, sha256: hash(await readFile(path.join(original, file))) })));
const previous = 'docs/evidence/r71-packaged-free-supply-expansion';
const previousEvidence = [];
for (const file of await readdir(previous)) {
  const bytes = await readFile(path.join(previous, file));
  const item = { file, bytes: bytes.length, sha256: hash(bytes) };
  if (file.endsWith('.json')) {
    const data = JSON.parse(bytes);
    item.schema = Array.isArray(data) ? 'array' : Object.keys(data);
  }
  previousEvidence.push(item);
}
await mkdir(evidence, { recursive: true });
const baseline = {
  at: new Date().toISOString(), original, originalBranch: git(original, 'branch', '--show-current'),
  originalHead: git(original, 'rev-parse', 'HEAD'), source: process.cwd(),
  startingHead: git(process.cwd(), 'rev-parse', 'HEAD'), branch: git(process.cwd(), 'branch', '--show-current'),
  r71CheckoutHead: git(`${original}/benchmarks/r71/tmp/source`, 'rev-parse', 'HEAD'),
  ancestry: ['516a3c30d93b089935d09672c970a3998e25603d', '2ac1ede001debf3c5e52f38e52b91d7d26832d12', 'b61af87b5a5dbc66fd6b37c807c87b789348eb7b'].map(sha => {
    git(original, 'merge-base', '--is-ancestor', sha, '8ef7847019b49380ecf519463c6b527920770124');
    return { sha, isAncestor: true, objectType: git(original, 'cat-file', '-t', sha) };
  }),
  preservedFiles, originalStatus: git(original, 'status', '--short'), previousEvidence,
  lockfileSha256: hash(await readFile('package-lock.json')),
};
await writeFile(`${evidence}/provenance.json`, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(JSON.stringify({ startingHead: baseline.startingHead, preservedFiles, previousEvidenceFiles: previousEvidence.length }));

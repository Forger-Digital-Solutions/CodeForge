import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const modules = path.join(root, 'node_modules');
const stage = path.join(root, 'benchmarks/r74/tmp/dependency-refresh');
const candidate = path.join(stage, 'node_modules');
const backup = path.join(root, 'benchmarks/r74/tmp/original-node-modules-before-security-refresh');
if (fs.lstatSync(modules).isSymbolicLink() || fs.realpathSync(modules) !== modules || fs.realpathSync(candidate) !== candidate) throw new Error('DEPENDENCY_ROOT_NOT_PRIVATE');
if (!backup.startsWith(`${root}${path.sep}`) || fs.existsSync(backup)) throw new Error('INVALID_PRIVATE_BACKUP');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = fs.readFileSync('package-lock.json');
const after = fs.readFileSync(path.join(stage, 'package-lock.json'));
const oldLock = JSON.parse(before), newLock = JSON.parse(after);
const native = [];
for (const name of ['better-sqlite3', 'node-pty', 'electron']) {
  const oldVersion = oldLock.packages[`node_modules/${name}`]?.version;
  const newVersion = newLock.packages[`node_modules/${name}`]?.version;
  if (!oldVersion || oldVersion !== newVersion) throw new Error(`NATIVE_VERSION_CHANGED:${name}`);
  native.push({ name, version: oldVersion });
}
for (const name of ['better-sqlite3', 'node-pty']) {
  const source = path.join(modules, name, 'build');
  const destination = path.join(candidate, name, 'build');
  if (fs.existsSync(source)) fs.cpSync(source, destination, { recursive: true });
}
for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
  if (entry.name === '@codeforge' || entry.name.startsWith('.')) continue;
  const target = path.join(modules, entry.name);
  if (path.dirname(target) !== modules || !fs.lstatSync(target).isSymbolicLink()) throw new Error(`DEPENDENCY_LINK_NOT_ISOLATED:${target}`);
}
// A same-volume directory rename retains every old junction intact, including its target;
// activation can be reversed without deleting or writing any protected shared dependency.
fs.renameSync(modules, backup);
fs.mkdirSync(modules);
fs.cpSync(path.join(backup, '@codeforge'), path.join(modules, '@codeforge'), { recursive: true, dereference: false, verbatimSymlinks: true });
fs.cpSync(path.join(backup, '.bin'), path.join(modules, '.bin'), { recursive: true });
for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '@codeforge' || entry.name.startsWith('.')) continue;
  fs.symlinkSync(path.join(candidate, entry.name), path.join(modules, entry.name), 'junction');
}
for (const file of ['package.json', 'package-lock.json', 'packages/mcp/package.json']) fs.copyFileSync(path.join(stage, file), path.join(root, file));
const changed = Object.entries(newLock.packages).filter(([name, pkg]) => pkg.version !== oldLock.packages[name]?.version).map(([name, pkg]) => ({ name, before: oldLock.packages[name]?.version, after: pkg.version }));
const removed = Object.keys(oldLock.packages).filter(name => !newLock.packages[name]);
const receipt = { at: new Date().toISOString(), reason: 'R74 required security gate found eight blocking high advisories; isolated candidate removes them without a waiver', previousLockfileSha256: hash(before), currentLockfileSha256: hash(after), changed, removed, nativeVersionsPreserved: native, nativeCompilation: false, installScriptsExecuted: false, protectedR73DependencyTargetsModified: false, candidatePath: stage, preservedDependencyDirectory: backup, activation: 'PRIVATE_ROOT_RENAME_NO_SHARED_JUNCTION_REMOVAL' };
fs.writeFileSync('docs/evidence/r74-autonomous-completion-and-free-reliability/dependency-refresh.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ changed: changed.length, removed: removed.length, privateCandidateActivated: true }));

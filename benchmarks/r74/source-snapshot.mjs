import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function snapshotSource() {
  const paths = execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    .split('\0').filter(file => /^(?:packages\/|apps\/|benchmarks\/r74\/|scripts\/r73-)/.test(file) && /\.(?:[cm]?[jt]sx?|json|ps1)$/.test(file)).sort();
  const files = [];
  for (const file of paths) {
    const bytes = await readFile(file);
    files.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { at: new Date().toISOString(), files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
